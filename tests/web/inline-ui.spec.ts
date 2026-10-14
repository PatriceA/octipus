import type { Page, Route } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

/**
 * Interactive answers in the web chat (docs/plans/inline-ui-spec.md §5.6):
 * a reply's marker line renders as a block fetched by id; a block from
 * history waits for a click while one that arrives live starts at once; the
 * chat page draws the link chip and the suggestion strip, and nothing is sent
 * without a click in the page; client outcomes ride with the next message;
 * the streaming reply shows a preview of the block being written.
 *
 * The server and the gateway are stubbed. Clicks inside a block land at page
 * coordinates: the content frame is nested and sandboxed.
 */

const HISTORY = '11111111-1111-4111-8111-111111111111';
const LIVE = '22222222-2222-4222-8222-222222222222';
const THROWS = '33333333-3333-4333-8333-333333333333';
const LINKS = '44444444-4444-4444-8444-444444444444';

const blocks: Record<string, Record<string, unknown>> = {
  [HISTORY]: { title: 'Tip calculator', html: '<p>Tip</p>', css: '', js: "document.querySelector('p').textContent = 'ran';", scripts: true },
  [LIVE]: {
    title: 'Ask about it',
    html: '<button id="b" type="button" style="display:block;width:220px;height:48px">Ask</button>',
    css: '',
    js: "document.getElementById('b').addEventListener('click', function () { octi.prompt('Explain the 15% case'); });",
    scripts: true,
  },
  [THROWS]: { title: 'Broken', html: '<p>x</p>', css: '', js: "throw new TypeError('boom');", scripts: true },
  [LINKS]: { title: 'Sources', html: '<a href="https://example.test/doc" style="display:block;height:48px">Read the docs</a>', css: '', js: '', scripts: false },
};

async function stubBlocks(page: Page, fetched: string[] = []): Promise<void> {
  await page.route('**/api/sessions/sess-1/inline-ui/*', (route: Route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() as string;
    fetched.push(id);
    const block = blocks[id];
    if (!block) return json(route, 404, { error: 'Interactive answer not found' });
    return json(route, 200, { block: { id, heightHint: 120, tainted: false, risk: 'normal', issues: [], shared: false, ...block } });
  });
}

const marker = (id: string) => `[[octi-ui:${id}|${blocks[id].title}]]`;

function replyEvent(gateway: Awaited<ReturnType<typeof stubGateway>>, text: string): void {
  gateway.event('chat.response', { response: { response: text, sessionId: 'sess-1' } }, 'sess-1');
}

async function clickInBlock(page: Page, title: string, x = 20, y = 20): Promise<void> {
  const frame = page.getByTestId('inline-ui-block').filter({ hasText: title }).getByTestId('inline-ui-frame');
  await expect(frame).toBeVisible();
  const box = await frame.boundingBox();
  if (!box) throw new Error('frame has no box');
  await page.mouse.click(box.x + x, box.y + y);
}

test.describe('interactive answers in the chat', () => {
  test('a block from history waits for a click; Run starts it', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await page.route('**/api/sessions/sess-1/messages**', (route) => json(route, 200, {
      messages: [{ id: 'm1', role: 'assistant', content: `Here you go:\n${marker(HISTORY)}\nEnjoy.`, createdAt: new Date().toISOString() }],
    }));
    await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');

    const block = page.getByTestId('inline-ui-block').filter({ hasText: 'Tip calculator' });
    await expect(block).toBeVisible();
    await expect(page.locator('[data-role="assistant"]')).toContainText('Here you go:');
    await expect(page.locator('[data-role="assistant"]')).toContainText('Enjoy.');
    await expect(block).toContainText('Its script runs when you start it.');
    await block.getByTestId('inline-ui-run').click();
    await expect(block.getByTestId('inline-ui-run')).toHaveCount(0);
    await expect(block.getByTestId('inline-ui-frame')).toBeVisible();
    await expect(block).toContainText('don’t enter passwords or keys here');
  });

  test('a live block starts at once; its suggestion is sent only from the strip, with provenance; renders is declared', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);

    replyEvent(gateway, `Try it:\n${marker(LIVE)}`);
    const block = page.getByTestId('inline-ui-block').filter({ hasText: 'Ask about it' });
    await expect(block.getByTestId('inline-ui-frame')).toBeVisible();
    await expect(block.getByTestId('inline-ui-run')).toHaveCount(0);

    await page.waitForTimeout(500);
    await clickInBlock(page, 'Ask about it');
    const strip = block.getByTestId('inline-ui-suggestion');
    await expect(strip).toContainText('Explain the 15% case');
    expect(gateway.sent.filter((m) => m.type === 'chat.send')).toHaveLength(0);

    await page.waitForTimeout(900);
    await strip.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toBeTruthy();
    const send = gateway.sent.find((m) => m.type === 'chat.send')!;
    expect(send.content).toBe('Explain the 15% case');
    expect(send.renders).toEqual(['inline_ui']);
    expect(send.inlineUi?.provenance).toEqual({ inlineUiId: LIVE });
    await expect(page.getByTestId('from-inline-ui')).toBeVisible();
  });

  test('a script error is shown, and reported with the next message as a class only', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);

    replyEvent(gateway, marker(THROWS));
    const block = page.getByTestId('inline-ui-block').filter({ hasText: 'Broken' });
    await expect(block).toContainText('Script error: TypeError');

    const input = page.getByPlaceholder(/send a message/i).first();
    await input.fill('what went wrong?');
    await input.press('Enter');
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toBeTruthy();
    const reports = gateway.sent.find((m) => m.type === 'chat.send')!.inlineUi?.reports;
    expect(reports).toEqual([expect.objectContaining({ id: THROWS, outcome: 'script-error', errorClass: 'TypeError' })]);
    expect(JSON.stringify(reports)).not.toContain('boom');
  });

  test('a link becomes a chip the user clicks; the frame never navigates', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await stubGateway(page);
    const outbound: string[] = [];
    await page.context().route('https://example.test/**', (route) => { outbound.push(route.request().url()); return route.fulfill({ status: 200, body: 'x' }); });
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);

    replyEvent(gateway, marker(LINKS));
    await page.waitForTimeout(500);
    await clickInBlock(page, 'Sources');
    const chip = page.getByTestId('inline-ui-link');
    await expect(chip).toContainText('https://example.test/doc');
    await expect(chip.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(outbound).toEqual([]);
  });

  test('a reply still streaming shows a preview of the block being written', async ({ authenticatedPage: page }) => {
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
    const input = page.getByPlaceholder(/send a message/i).first();
    await input.fill('chart it');
    await input.press('Enter');
    gateway.event('chat.delta', { agentId: 'root-1', iteration: 0, delta: 'Here:\n```octi-ui title="Chart"\n<style>p{color:red}</style><p>Half' }, 'sess-1');
    await expect(page.getByTestId('inline-ui-preview')).toContainText('Building “Chart”');
    await expect(page.getByTestId('inline-ui-streaming')).not.toContainText('<style>');
  });

  test('a block another session holds, or one that is gone, shows as not available', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const missing = '55555555-5555-4555-8555-555555555555';
    await page.route('**/api/sessions/sess-1/messages**', (route) => json(route, 200, {
      messages: [{ id: 'm1', role: 'assistant', content: `[[octi-ui:${missing}|Gone]]`, createdAt: new Date().toISOString() }],
    }));
    await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect(page.getByTestId('inline-ui-block')).toContainText('Interactive answer “Gone” is not available here.');
  });
});

test.describe('saving an interactive answer as an artifact', () => {
  test('the dialog suggests a slug, warns about octi, saves privately by default and links to the copy', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const saved: Array<Record<string, unknown>> = [];
    await page.route('**/api/sessions/sess-1/inline-ui/*/promote', async (route) => {
      saved.push(route.request().postDataJSON());
      return json(route, 201, { artifact: { id: 'art-1' }, appUrl: '/artifacts/view?id=art-1', warnings: [], removed: [], bridge: true });
    });
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);

    replyEvent(gateway, marker(LIVE));
    const block = page.getByTestId('inline-ui-block').filter({ hasText: 'Ask about it' });
    await block.getByTestId('inline-ui-save').click();
    const dialog = page.getByTestId('inline-ui-save-dialog');
    await expect(dialog.getByLabel('Artifact title')).toHaveValue('Ask about it');
    await expect(dialog.getByLabel('Artifact slug')).toHaveValue('ask-about-it');
    await expect(dialog).toContainText('A static copy');
    await expect(dialog).toContainText('not available here');
    await dialog.getByRole('button', { name: 'save' }).click();
    await expect(page.getByTestId('inline-ui-saved')).toContainText('Saved as an artifact.');
    await expect(page.getByTestId('inline-ui-saved').getByRole('link', { name: 'open it' })).toHaveAttribute('href', '/artifacts/view?id=art-1');
    expect(saved).toEqual([{ title: 'Ask about it', slug: 'ask-about-it', visibility: 'private' }]);
  });

  test('an answer made after reading content from outside cannot be saved', async ({ authenticatedPage: page }) => {
    const TAINTED = '77777777-7777-4777-8777-777777777777';
    blocks[TAINTED] = { title: 'From the web', html: '<p>w</p>', css: '', js: '', scripts: false, tainted: true };
    await stubBlocks(page);
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
    replyEvent(gateway, marker(TAINTED));
    const save = page.getByTestId('inline-ui-block').filter({ hasText: 'From the web' }).getByTestId('inline-ui-save');
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute('title', /content from outside/);
  });
});

test('a block that takes the keyboard focus by itself is stopped and the focus returns', async ({ authenticatedPage: page }) => {
  const THIEF = '66666666-6666-4666-8666-666666666666';
  blocks[THIEF] = { title: 'Thief', html: '<input id="i" aria-label="x">', css: '', js: "setTimeout(function () { document.getElementById('i').focus(); }, 1500);", scripts: true };
  await stubBlocks(page);
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
  replyEvent(gateway, marker(THIEF));
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.click();
  await input.pressSequentially('typing my own message', { delay: 80 });
  const block = page.getByTestId('inline-ui-block').filter({ hasText: 'Thief' });
  await expect(block).toContainText('Stopped: It tried to take the keyboard focus.');
  await expect(input).toBeFocused();
});
