import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { EmailMessage, InboxItem } from '../../src/shared/email';

const now = new Date().toISOString();
const row = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id, threadId: `t-${id}`, provider: 'google', from: { name: 'Boss', email: 'boss@example.com' }, subject: `Subject ${id}`, snippet: `Snippet ${id}`, receivedAt: now, unread: false, ...extra });

interface Box {
  sent: Array<Record<string, unknown>>;
  uploads: string[];
  removed: string[];
  snoozes: Array<Record<string, unknown>>;
  unsnoozed: string[];
}

/** A Google mailbox with one conversation, and the writing and snooze routes recorded. */
async function stubMailbox(page: Page, message: EmailMessage): Promise<Box> {
  const box: Box = { sent: [], uploads: [], removed: [], snoozes: [], unsnoozed: [] };
  let items: InboxItem[] = [message];
  await page.route('**/api/mail/accounts', route => json(route, 200, []));
  await page.route('**/api/email/accounts', route => json(route, 200, { accounts: [{ provider: 'google', address: 'me@example.com' }] }));
  await page.route('**/api/email/categories', route => json(route, 200, { categories: { work: 'job mail', other: 'none of the above' }, defaults: {} }));
  await page.route('**/api/email/triage/settings', route => json(route, 200, { saved: false, settings: { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: [], instructions: '', skipDialog: false } }));
  await page.route('**/api/email/triage/run', route => json(route, 200, { run: null }));
  await page.route('**/api/email/messages?**', route => json(route, 200, { provider: 'google', items: new URL(route.request().url()).searchParams.get('folder') === 'inbox' ? items : [] }));
  await page.route('**/api/email/messages/batch', route => json(route, 200, { done: route.request().postDataJSON().ids, failed: [] }));
  await page.route(`**/api/email/thread/${message.threadId}?**`, route => json(route, 200, { messages: [message] }));
  let seq = 0;
  await page.route('**/api/email/uploads', async route => {
    const body = route.request().postDataBuffer()?.toString('latin1') ?? '';
    const name = body.match(/filename="([^"]+)"/)?.[1] ?? 'file';
    box.uploads.push(name);
    return json(route, 200, { id: `up-${++seq}`, name, size: 5, contentType: 'text/plain' });
  });
  await page.route('**/api/email/uploads/*', route => { box.removed.push(route.request().url().split('/').pop()!); return json(route, 200, { removed: true }); });
  await page.route('**/api/email/send', route => { box.sent.push(route.request().postDataJSON()); return json(route, 200, { sent: true }); });
  await page.route('**/api/email/snooze', route => {
    box.snoozes.push(route.request().postDataJSON());
    items = [];
    return json(route, 200, { snoozed: { id: 's1' } });
  });
  await page.route('**/api/email/snoozed', route => json(route, 200, { snoozed: box.snoozes.length && !box.unsnoozed.length ? [{
    id: 's1', provider: 'google', messageIds: ['m1'], threadId: message.threadId, from: message.from, subject: message.subject, snippet: message.snippet,
    wakeAt: new Date(Date.now() + 86_400_000).toISOString(), error: 'Mail provider returned an error (HTTP 503).', retryAt: new Date(Date.now() + 120_000).toISOString(),
  }] : [] }));
  await page.route('**/api/email/snoozed/s1/unsnooze', route => { box.unsnoozed.push('s1'); items = [message]; return json(route, 200, { unsnoozed: true }); });
  return box;
}

const budget: EmailMessage = {
  ...row('m1', { subject: 'Budget' }), to: [{ email: 'me@example.com' }], body: 'Please confirm', html: '<p>Please confirm</p>',
  attachments: [{ id: '2', name: 'budget.xlsx', size: 48211, contentType: 'application/vnd.ms-excel' }],
};

async function openBudget(page: Page) {
  await page.goto('/email');
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: /Budget/ }).click();
  return page.getByRole('article', { name: 'Conversation: Budget' });
}

test('files are uploaded as they are added, can be removed, and the send names the ones left', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, budget);
  await page.goto('/email');
  await page.getByRole('button', { name: 'Compose' }).click();
  const compose = page.getByRole('form', { name: 'New message' });
  await compose.getByLabel('To').fill('bob@example.com');
  await compose.getByLabel('Subject').fill('Notes');
  await compose.getByRole('textbox', { name: 'Message' }).fill('Two files.');
  await compose.locator('input[type="file"]').setInputFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('world') },
  ]);
  const files = compose.getByRole('list', { name: 'Attachments' });
  await expect(files.getByRole('listitem')).toHaveCount(2);
  await expect.poll(() => box.uploads.sort()).toEqual(['a.txt', 'b.txt']);
  const firstId = box.uploads[0] === 'a.txt' ? 'up-1' : 'up-2';
  await files.getByRole('button', { name: 'Remove a.txt' }).click();
  await expect(files.getByRole('listitem')).toHaveCount(1);
  await expect.poll(() => box.removed).toEqual([firstId]);
  await compose.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(compose.getByRole('alertdialog', { name: 'Confirm send' })).toContainText('with 1 attachment');
  await compose.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => box.sent).toHaveLength(1);
  expect(box.sent[0]).toMatchObject({ to: 'bob@example.com', subject: 'Notes', body: 'Two files.', format: 'rich', confirm: true, attachments: [{ upload: firstId === 'up-1' ? 'up-2' : 'up-1' }] });
});

test('a file over 25 MB is refused before it is uploaded', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, budget);
  await page.goto('/email');
  await page.getByRole('button', { name: 'Compose' }).click();
  const compose = page.getByRole('form', { name: 'New message' });
  await compose.locator('input[type="file"]').setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(26 * 1024 * 1024) });
  await expect(compose.getByRole('alert')).toContainText('25 MB');
  expect(box.uploads).toEqual([]);
});

test('a forward carries the original\'s files unless they are removed; nothing is uploaded for them', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, budget);
  const reader = await openBudget(page);
  await reader.getByRole('button', { name: 'Forward' }).click();
  const compose = page.getByRole('form', { name: 'Forward' });
  await expect(compose.getByRole('list', { name: 'Attachments' })).toContainText('budget.xlsx');
  await compose.getByLabel('To').fill('cfo@example.com');
  await compose.getByRole('button', { name: 'Send', exact: true }).click();
  await compose.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => box.sent).toHaveLength(1);
  expect(box.sent[0]).toMatchObject({ to: 'cfo@example.com', subject: 'Fwd: Budget', attachments: [{ forward: { messageId: 'm1', attachmentId: '2' } }] });
  expect(box.sent[0]).not.toHaveProperty('replyTo');
  expect(box.uploads).toEqual([]);
  // Removed, it does not go.
  await reader.getByRole('button', { name: 'Forward' }).click();
  const again = page.getByRole('form', { name: 'Forward' });
  await again.getByRole('button', { name: 'Remove budget.xlsx' }).click();
  await again.getByLabel('To').fill('cfo@example.com');
  await again.getByRole('button', { name: 'Send', exact: true }).click();
  await again.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => box.sent).toHaveLength(2);
  expect(box.sent[1]).not.toHaveProperty('attachments');
});

test('the formatting toolbar writes signs around the selection; plain text sends no HTML', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, budget);
  await page.goto('/email');
  await page.getByRole('button', { name: 'Compose' }).click();
  const compose = page.getByRole('form', { name: 'New message' });
  await compose.getByLabel('To').fill('bob@example.com');
  const body = compose.getByRole('textbox', { name: 'Message' });
  await body.fill('Hello team\nfirst\nsecond');
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 10));
  await compose.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click();
  await expect(body).toHaveValue('Hello **team**\nfirst\nsecond');
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(16, 27));
  await compose.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bulleted list' }).click();
  await expect(body).toHaveValue('Hello **team**\n- first\n- second');
  await compose.getByRole('button', { name: 'Send', exact: true }).click();
  await compose.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => box.sent).toHaveLength(1);
  // The browser sends the signs; the server builds the HTML from them (core/email/compose-format.ts).
  expect(box.sent[0]).toMatchObject({ body: 'Hello **team**\n- first\n- second', format: 'rich' });
  await page.getByRole('button', { name: 'Compose' }).click();
  const plain = page.getByRole('form', { name: 'New message' });
  await plain.getByLabel('To').fill('bob@example.com');
  await plain.getByRole('textbox', { name: 'Message' }).fill('2 * 3 = 6');
  await plain.getByLabel('Plain text').check();
  await plain.getByRole('button', { name: 'Send', exact: true }).click();
  await plain.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => box.sent).toHaveLength(2);
  expect(box.sent[1]).toMatchObject({ body: '2 * 3 = 6', format: 'plain' });
});

test('snooze takes a conversation out of the inbox; the Snoozed folder lists it, says why a wake failed, and brings it back', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, budget);
  const reader = await openBudget(page);
  await reader.getByRole('button', { name: 'Snooze' }).click();
  const menu = page.getByRole('menu', { name: 'Snooze until' });
  await menu.getByRole('menuitem', { name: /Tomorrow morning/ }).click();
  await expect.poll(() => box.snoozes).toHaveLength(1);
  const sent = box.snoozes[0] as { ids: string[]; wakeAt: string; provider: string; subject: string; threadId: string };
  expect(sent).toMatchObject({ ids: ['m1'], provider: 'google', subject: 'Budget', threadId: 't-m1' });
  const wake = new Date(sent.wakeAt);
  expect(wake.getHours()).toBe(8);
  expect(+wake).toBeGreaterThan(Date.now());
  await expect(page.getByRole('status')).toContainText('Snoozed until');
  const list = page.getByRole('region', { name: 'Messages' });
  await expect(list.getByText('Budget')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: 'Snoozed' }).click();
  const snoozed = page.getByRole('region', { name: 'Snoozed' });
  await expect(snoozed).toContainText('Budget');
  await expect(snoozed).toContainText('Could not bring it back: Mail provider returned an error (HTTP 503).');
  await snoozed.getByRole('button', { name: 'Unsnooze' }).click();
  await expect.poll(() => box.unsnoozed).toEqual(['s1']);
  await expect(snoozed).toContainText('Nothing is snoozed.');
  await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: /Inbox/ }).click();
  await expect(page.getByRole('region', { name: 'Messages' }).getByText('Budget')).toBeVisible();
});
