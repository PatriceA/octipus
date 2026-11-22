import type { Page, Route } from '@playwright/test';
import { type InlineUiView, lintInlineUiView } from '../../src/shared/inline-ui/view';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

/**
 * Declarative views in the web chat (docs/plans/inline-ui-views-spec.md §4,
 * §5): a view block renders as the page's own components at once — no Run
 * button, no frame — its inputs write the data model, and a button's event
 * goes back to the agent as `chat.send` with `inlineUi.action`; a tainted
 * block's answer goes through the suggestion strip; a stored answer opens as
 * answered.
 *
 * Views are written as an agent would and normalized by the shared lint, as
 * the server stores them. The server and the gateway are stubbed.
 */

function view(doc: unknown): InlineUiView {
  const result = lintInlineUiView(JSON.stringify(doc), { closed: true });
  if (!result.view) throw new Error(`not a view: ${result.issues.map((i) => i.message).join('; ')}`);
  return result.view;
}

const PLAN = '11111111-aaaa-4111-8111-111111111111';
const TABLE = '22222222-aaaa-4222-8222-222222222222';
const CHART = '33333333-aaaa-4333-8333-333333333333';
const STEPS = '44444444-aaaa-4444-8444-444444444444';
const BROKEN = '55555555-aaaa-4555-8555-555555555555';
const OLD = '66666666-aaaa-4666-8666-666666666666';

const PLAN_VIEW = view({
  data: { plan: null, seats: 3, name: '' },
  computed: { total: 'seats * 10' },
  root: {
    component: 'Column',
    children: [
      { component: 'Text', text: 'Pick a plan', variant: 'heading' },
      { component: 'ChoicePicker', label: 'Plan', value: { '@path': '/plan' }, options: [{ label: 'Basic', value: 'basic' }, { label: 'Pro', value: 'pro', description: 'For teams' }] },
      { component: 'TextField', label: 'Seats', variant: 'number', min: 1, max: 50, value: { '@path': '/seats' } },
      { component: 'TextField', label: 'Your name', required: true, value: { '@path': '/name' } },
      { component: 'Stat', label: 'Total', value: { '@expr': "formatCurrency(total, 'EUR')" } },
      {
        id: 'go',
        component: 'Button',
        label: 'Continue',
        variant: 'primary',
        action: { event: { name: 'plan_chosen', context: { plan: { '@path': '/plan' }, seats: { '@path': '/seats' }, total: { '@expr': 'total' } }, userMessage: 'I take ${plan} for ${seats} seats' } },
      },
    ],
  },
});

const TABLE_VIEW = view({
  data: {
    picked: [],
    rows: [
      { name: 'Gamma', cost: 30, since: '2026-03-01' },
      { name: 'Alpha', cost: 120, since: '2025-11-15' },
      { name: 'Beta', cost: 7.5, since: '2026-01-20' },
    ],
  },
  root: {
    component: 'Column',
    children: [
      {
        component: 'Table',
        filter: true,
        selectable: 'multiple',
        selected: { '@path': '/picked' },
        rowKey: 'name',
        rows: { '@path': '/rows' },
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'cost', label: 'Cost', format: 'currency:USD', align: 'end' },
          { key: 'since', label: 'Since', format: 'date' },
        ],
      },
      { component: 'Stat', label: 'Picked', value: { '@expr': 'count(picked)' } },
    ],
  },
});

const CHART_VIEW = view({
  data: { months: [{ m: 'Jan', revenue: 10, cost: 4 }, { m: 'Feb', revenue: 25, cost: 9 }, { m: 'Mar', revenue: 18, cost: 12 }] },
  root: { component: 'Chart', type: 'bar', data: { '@path': '/months' }, x: 'm', series: [{ key: 'revenue', label: 'Revenue' }, { key: 'cost', label: 'Cost' }] },
});

const STEPS_VIEW = view({
  root: {
    component: 'Column',
    children: [
      { component: 'Steps', steps: [
        { title: 'Prepare', child: { component: 'Text', text: 'Gather the documents.' } },
        { title: 'Submit', child: { component: 'Text', text: 'Send the form.' } },
        { title: 'Wait', child: { component: 'Text', text: 'Expect an answer in a week.' } },
      ] },
      { component: 'Tabs', tabs: [
        { title: 'Monthly', child: { component: 'Text', text: 'Pay each month.' } },
        { title: 'Yearly', child: { component: 'Text', text: 'Pay once a year.' } },
      ] },
    ],
  },
});

const BROKEN_VIEW = view({
  data: { price: 12, code: 'not-a-code' },
  root: {
    component: 'Column',
    children: [
      { component: 'Text', text: 'Still here', variant: 'subheading' },
      { id: 'bad', component: 'Stat', label: 'Price', value: { '@expr': 'formatCurrency(price, code)' } },
      { component: 'Stat', label: 'Plain', value: { '@path': '/price' } },
    ],
  },
});

const WRITES = '77777777-aaaa-4777-8777-777777777777';
const SETS = '88888888-aaaa-4888-8888-888888888888';
const WIDE = '99999999-aaaa-4999-8999-999999999999';
const ROWS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LAYOUT = 'bbbbbbbb-aaaa-4bbb-8bbb-bbbbbbbbbbbb';

// Writes that cannot land: a relative path on a string item, a path through a string.
const WRITES_VIEW = view({
  data: { items: ['a', 'b'], plan: 'basic' },
  root: {
    component: 'Column',
    children: [
      { component: 'Text', text: 'Still drawn', variant: 'caption' },
      { component: 'Column', children: { path: '/items', template: { component: 'CheckBox', label: 'Done', value: { '@path': 'done' } } } },
      { component: 'TextField', label: 'Plan name', value: { '@path': '/plan/name' } },
    ],
  },
});

// A button that only sets; a template Slider with no number; a button with two events.
const SETS_VIEW = view({
  data: { n: 1, items: [{ name: 'a' }] },
  root: {
    component: 'Column',
    children: [
      { component: 'Stat', label: 'Count', value: { '@path': '/n' } },
      { id: 'add', component: 'Button', label: 'Add one', action: { set: { path: '/n', value: { '@expr': 'n + 1' } } } },
      { component: 'Column', children: { path: '/items', template: { component: 'Slider', label: 'Level', min: 2, max: 10, value: { '@path': 'level' } } } },
      { id: 'send', component: 'Button', label: 'Send', action: { event: { name: 'counted', context: { n: { '@path': '/n' } }, userMessage: 'Counted ${n}' } } },
      { id: 'twice', component: 'Button', label: 'Twice', action: [{ event: { name: 'first', context: {}, userMessage: 'First' } }, { event: { name: 'second', context: {}, userMessage: 'Second' } }] },
    ],
  },
});

// Rows big enough that two selected copies take the data model over the limit.
const WIDE_VIEW = view({
  data: { picked: [], rows: ['r1', 'r2', 'r3', 'r4'].map((name) => ({ name, note: name.repeat(1_500) })) },
  root: {
    component: 'Column',
    children: [
      { component: 'Table', selectable: 'multiple', selected: { '@path': '/picked' }, rowKey: 'name', rows: { '@path': '/rows' }, columns: [{ key: 'name', label: 'Name' }] },
      { id: 'go', component: 'Button', label: 'Use these', action: { event: { name: 'picked', context: { count: { '@expr': 'count(picked)' } }, userMessage: 'Use these rows' } } },
    ],
  },
});

// Two rows share a rowKey value; two columns share a key.
const ROWS_VIEW = view({
  data: { picked: [], rows: [{ name: 'api', region: 'eu' }, { name: 'api', region: 'us' }, { name: 'db', region: 'eu' }] },
  root: {
    component: 'Column',
    children: [
      { component: 'Table', selectable: 'multiple', selected: { '@path': '/picked' }, rowKey: 'name', rows: { '@path': '/rows' }, columns: [{ key: 'name', label: 'Name' }, { key: 'region', label: 'Region' }, { key: 'region', label: 'Region again' }] },
      { component: 'Stat', label: 'Picked', value: { '@expr': 'count(picked)' } },
    ],
  },
});

// A chart series keyed `x`, and a row with a hidden child.
const LAYOUT_VIEW = view({
  data: { months: [{ m: 'Jan', x: 10 }, { m: 'Feb', x: 20 }] },
  root: {
    component: 'Column',
    children: [
      { component: 'Row', children: [
        { component: 'Text', text: 'Left', variant: 'caption' },
        { component: 'Text', text: 'Hidden', variant: 'caption', visible: false },
        { component: 'Text', text: 'Right', variant: 'caption' },
      ] },
      { component: 'Chart', type: 'bar', data: { '@path': '/months' }, x: 'm', series: [{ key: 'x', label: 'Visits' }] },
    ],
  },
});

type BlockStub = Record<string, unknown> & { title: string };

const blocks: Record<string, BlockStub> = {
  [PLAN]: { title: 'Choose a plan', kind: 'view', view: PLAN_VIEW },
  [TABLE]: { title: 'Vendors', kind: 'view', view: TABLE_VIEW },
  [CHART]: { title: 'Revenue', kind: 'view', view: CHART_VIEW },
  [STEPS]: { title: 'How it works', kind: 'view', view: STEPS_VIEW },
  [BROKEN]: { title: 'Broken numbers', kind: 'view', view: BROKEN_VIEW },
  [WRITES]: { title: 'Bad writes', kind: 'view', view: WRITES_VIEW },
  [SETS]: { title: 'Counter', kind: 'view', view: SETS_VIEW },
  [WIDE]: { title: 'Wide rows', kind: 'view', view: WIDE_VIEW },
  [ROWS]: { title: 'Same names', kind: 'view', view: ROWS_VIEW },
  [LAYOUT]: { title: 'Layout', kind: 'view', view: LAYOUT_VIEW },
  // A server from before views: no `kind`, `view` or `state`.
  [OLD]: { title: 'Old widget', html: '<p>old</p>', css: '', js: '', scripts: false },
};

async function stubBlocks(page: Page, overrides: Record<string, Partial<BlockStub>> = {}): Promise<void> {
  await page.route('**/api/sessions/sess-1/inline-ui/*', (route: Route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() as string;
    const block = blocks[id];
    if (!block) return json(route, 404, { error: 'Interactive answer not found' });
    const base = block.kind === 'view' ? { html: '', css: '', js: '', scripts: false, state: null } : {};
    return json(route, 200, { block: { id, heightHint: 120, tainted: false, risk: 'normal', issues: [], shared: false, ...base, ...block, ...overrides[id] } });
  });
}

const marker = (id: string) => `[[octi-ui:${id}|${blocks[id].title}]]`;

async function openWithHistory(page: Page, messages: Array<Record<string, unknown>>) {
  await page.route('**/api/sessions/sess-1/messages**', (route) => json(route, 200, { messages }));
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
  return gateway;
}

const reply = (id: string, text = 'Here:') => ({ id: `m-${id}`, role: 'assistant', content: `${text}\n${marker(id)}`, createdAt: new Date().toISOString() });
const blockOf = (page: Page, title: string) => page.getByTestId('inline-ui-block').filter({ hasText: title });

test.describe('declarative views in the chat', () => {
  test('a view from history renders at once — no Run button, no frame — and its inputs drive a computed Stat', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await expect(block.getByTestId('inline-ui-view')).toBeVisible();
    await expect(block.getByTestId('inline-ui-run')).toHaveCount(0);
    await expect(block.getByTestId('inline-ui-frame')).toHaveCount(0);
    await expect(block.getByTestId('inline-ui-save')).toHaveCount(0);
    await expect(block).toContainText('Interactive answer');
    await expect(block).toContainText('Made by the agent');

    const total = block.getByTestId('inline-ui-stat').filter({ hasText: 'Total' });
    await expect(total).toContainText('€30.00');
    const seats = block.getByLabel('Seats');
    await seats.fill('7');
    await expect(total).toContainText('€70.00');
    // Text that is not (yet) a number is kept as typed and writes nothing.
    await seats.fill('7.');
    await expect(seats).toHaveValue('7.');
    await expect(total).toContainText('€70.00');
    await seats.fill('99');
    await expect(block).toContainText('Enter a number from 1 to 50.');
    await expect(total).toContainText('€70.00');
  });

  test('an event button sends chat.send with inlineUi.action, then shows the sent state; Change answer opens it again', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    const go = block.getByRole('button', { name: 'Continue' });

    await block.getByLabel('Pro').check();
    await block.getByLabel('Seats').fill('5');
    // A required field that is empty holds the answer back, and says why.
    await expect(go).toBeDisabled();
    await expect(go).toHaveAttribute('title', 'Fill in “Your name” first');
    await expect(block).toContainText('Fill in “Your name” to answer.');
    await block.getByLabel('Your name').fill('Ada');
    await expect(go).toBeEnabled();
    await go.click();

    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toBeTruthy();
    const send = gateway.sent.find((m) => m.type === 'chat.send')!;
    expect(send.content).toBe('I take pro for 5 seats');
    expect(send.renders).toEqual(['inline_ui']);
    expect(send.inlineUi).toEqual({
      provenance: { inlineUiId: PLAN },
      action: {
        blockId: PLAN,
        name: 'plan_chosen',
        componentId: 'go',
        context: { plan: 'pro', seats: 5, total: 50 },
        data: { plan: 'pro', seats: 5, name: 'Ada' },
      },
    });

    // The bubble shows where the message came from and the values it carried.
    const bubble = page.locator('[data-role="user"]').filter({ hasText: 'I take pro for 5 seats' });
    await expect(bubble.getByTestId('from-inline-ui')).toBeVisible();
    await expect(bubble.getByTestId('inline-ui-action-values')).toContainText('plan: pro');
    await expect(bubble.getByTestId('inline-ui-action-values')).toContainText('seats: 5');

    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await expect(go).toBeDisabled();
    await expect(block.getByLabel('Your name')).toHaveAttribute('readonly', '');
    await block.getByRole('button', { name: 'Change answer' }).click();
    await expect(go).toBeEnabled();
    await expect(block.getByLabel('Your name')).not.toHaveAttribute('readonly', '');
  });

  test('a refused answer says why on the block and stays editable', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await block.getByLabel('Basic').check();
    await block.getByLabel('Your name').fill('Ada');
    await block.getByRole('button', { name: 'Continue' }).click();
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    gateway.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'The interactive answer was not sent: component "go" has no event "x"' });
    await expect(block.getByTestId('inline-ui-view-error')).toContainText('component "go" has no event "x"');
    await expect(block.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('a tainted block’s answer opens the suggestion strip; its Send carries the action', async ({ authenticatedPage: page }) => {
    await stubBlocks(page, { [PLAN]: { tainted: true } });
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await block.getByLabel('Basic').check();
    await block.getByLabel('Your name').fill('Bo');
    await block.getByRole('button', { name: 'Continue' }).click();

    const strip = block.getByTestId('inline-ui-suggestion');
    await expect(strip).toContainText('I take basic for 3 seats');
    expect(gateway.sent.filter((m) => m.type === 'chat.send')).toHaveLength(0);
    await page.waitForTimeout(900);
    await strip.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toBeTruthy();
    const send = gateway.sent.find((m) => m.type === 'chat.send')!;
    expect(send.content).toBe('I take basic for 3 seats');
    expect(send.inlineUi?.action).toMatchObject({ blockId: PLAN, name: 'plan_chosen', context: { plan: 'basic', seats: 3, total: 30 } });
    await expect(strip).toHaveCount(0);
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
  });

  test('a block with a stored answer loads as answered', async ({ authenticatedPage: page }) => {
    await stubBlocks(page, {
      [PLAN]: { state: { data: { plan: 'pro', seats: 9, name: 'Cy' }, action: { name: 'plan_chosen', componentId: 'go', at: '2026-11-20T10:00:00.000Z' } } },
    });
    await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await expect(block.getByLabel('Seats')).toHaveValue('9');
    await expect(block.getByLabel('Pro')).toBeChecked();
    await expect(block.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(block.getByTestId('inline-ui-stat').filter({ hasText: 'Total' })).toContainText('€90.00');
    // Reset goes back to the view's own data.
    await block.getByTestId('inline-ui-reset').click();
    await expect(block.getByLabel('Seats')).toHaveValue('3');
    await expect(block.getByTestId('inline-ui-view-status')).not.toContainText('Answer sent');
    await expect(block.getByRole('button', { name: 'Change answer' })).toHaveCount(0);
  });

  test('a table sorts by column format, filters, and writes the selected rows', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(TABLE)]);
    const block = blockOf(page, 'Vendors');
    const table = block.getByTestId('inline-ui-table');
    const names = () => table.locator('tbody tr td:nth-child(2)').allTextContents();
    await expect(table).toContainText('$120.00');
    await expect(table).toContainText('Nov 15, 2025');
    expect(await names()).toEqual(['Gamma', 'Alpha', 'Beta']);

    await table.getByRole('button', { name: 'Cost' }).click();
    expect(await names()).toEqual(['Beta', 'Gamma', 'Alpha']);
    await expect(table.locator('th[aria-sort="ascending"]')).toContainText('Cost');
    await table.getByRole('button', { name: 'Cost' }).click();
    expect(await names()).toEqual(['Alpha', 'Gamma', 'Beta']);
    await table.getByRole('button', { name: 'Since' }).click();
    expect(await names()).toEqual(['Alpha', 'Beta', 'Gamma']);

    await table.getByLabel('Filter rows').fill('am');
    expect(await names()).toEqual(['Gamma']);
    await expect(table.getByTestId('inline-ui-table-count')).toContainText('Showing 1–1 of 1');
    await table.getByLabel('Filter rows').fill('');

    const picked = block.getByTestId('inline-ui-stat').filter({ hasText: 'Picked' });
    await expect(picked).toContainText('0');
    await table.getByLabel('Select Alpha').check();
    await table.getByLabel('Select Beta').check();
    await expect(picked).toContainText('2');
    await table.getByLabel('Select Alpha').uncheck();
    await expect(picked).toContainText('1');
  });

  test('a chart draws an svg and has a text alternative', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(CHART)]);
    const chart = blockOf(page, 'Revenue').getByTestId('inline-ui-chart');
    await expect(chart.locator('svg.recharts-surface').first()).toBeVisible();
    await expect(chart.getByRole('img', { name: 'Bar chart by m, 3 points: Revenue from 10 to 25; Cost from 4 to 12' })).toBeVisible();
    await chart.getByText('Show data').click();
    await expect(chart.locator('details table')).toContainText('Feb');
    await expect(chart.locator('details table')).toContainText('25');
  });

  test('steps move one at a time and tabs follow the keyboard', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(STEPS)]);
    const block = blockOf(page, 'How it works');
    const position = block.getByTestId('inline-ui-steps-position');
    await expect(position).toHaveText('Step 1 of 3');
    await expect(block).toContainText('Gather the documents.');
    await expect(block.getByRole('button', { name: 'Back' })).toBeDisabled();
    await block.getByRole('button', { name: 'Next' }).click();
    await expect(position).toHaveText('Step 2 of 3');
    await expect(block).toContainText('Send the form.');
    await expect(block).not.toContainText('Gather the documents.');
    await block.getByRole('button', { name: 'Next' }).click();
    await expect(block.getByRole('button', { name: 'Next' })).toBeDisabled();
    await block.getByRole('button', { name: 'Back' }).click();
    await expect(position).toHaveText('Step 2 of 3');

    const monthly = block.getByRole('tab', { name: 'Monthly' });
    await expect(monthly).toHaveAttribute('aria-selected', 'true');
    await expect(block.getByRole('tabpanel')).toContainText('Pay each month.');
    await monthly.focus();
    await page.keyboard.press('ArrowRight');
    await expect(block.getByRole('tab', { name: 'Yearly' })).toBeFocused();
    await expect(block.getByRole('tab', { name: 'Yearly' })).toHaveAttribute('aria-selected', 'true');
    await expect(block.getByRole('tabpanel')).toContainText('Pay once a year.');
  });

  test('an expression that fails shows on its component; the rest of the view renders', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(BROKEN)]);
    const block = blockOf(page, 'Broken numbers');
    await expect(block.getByTestId('inline-ui-component-error')).toContainText('bad');
    await expect(block.getByTestId('inline-ui-component-error')).toContainText('not a currency code');
    await expect(block).toContainText('Still here');
    await expect(block.getByTestId('inline-ui-stat').filter({ hasText: 'Plain' })).toContainText('12');
  });

  test('View source shows the view as JSON', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await block.getByRole('button', { name: 'View source' }).click();
    const source = block.getByTestId('inline-ui-source');
    await expect(source).toContainText('"component": "ChoicePicker"');
    await expect(source).toContainText('"id": "go"');
  });

  test('a block from a server without views (no kind) still renders as HTML', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(OLD)]);
    const block = blockOf(page, 'Old widget');
    await expect(block.getByTestId('inline-ui-frame')).toBeVisible();
    await expect(block.getByTestId('inline-ui-view')).toHaveCount(0);
  });

  test('the user bubble of a stored answer shows its values, long ones truncated', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const long = 'a very long note that goes on and on well past the chip limit';
    await openWithHistory(page, [
      reply(PLAN),
      { id: 'u1', role: 'user', content: 'I take pro', createdAt: new Date().toISOString(), metadata: { inlineUiProvenance: { id: PLAN }, inlineUiAction: { blockId: PLAN, name: 'plan_chosen', context: { plan: 'pro', note: long } } } },
    ]);
    const bubble = page.locator('[data-role="user"]').filter({ hasText: 'I take pro' });
    await expect(bubble.getByTestId('from-inline-ui')).toBeVisible();
    const values = bubble.getByTestId('inline-ui-action-values');
    await expect(values).toContainText('plan: pro');
    await expect(values).toContainText('note: a very long note');
    await expect(values).not.toContainText('chip limit');
    await expect(values.locator('li').nth(1)).toHaveAttribute('title', `note: ${long}`);
  });

  test('a view still streaming shows a preview with its inputs off, and keeps the last good render', async ({ authenticatedPage: page }) => {
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
    const input = page.getByPlaceholder(/send a message/i).first();
    await input.fill('pick for me');
    await input.press('Enter');
    gateway.event('chat.delta', {
      agentId: 'root-1',
      iteration: 0,
      delta: 'Here:\n```octi-ui title="Plan"\n{"root":{"component":"Column","children":[{"component":"Text","text":"Hello there"},{"component":"Button","label":"Go","action":{"event":{"name":"go"}}},',
    }, 'sess-1');
    const preview = page.getByTestId('inline-ui-preview');
    await expect(preview).toContainText('Building “Plan”');
    await expect(preview.getByTestId('inline-ui-view')).toContainText('Hello there');
    await expect(preview.getByRole('button', { name: 'Go' })).toBeDisabled();
    await expect(page.getByTestId('inline-ui-streaming')).not.toContainText('"component"');

    // A component name half written does not validate: the last good render stays.
    gateway.event('chat.delta', { agentId: 'root-1', iteration: 0, delta: '{"component":"Te' }, 'sess-1');
    await page.waitForTimeout(700);
    await expect(preview.getByTestId('inline-ui-view')).toContainText('Hello there');
    gateway.event('chat.delta', { agentId: 'root-1', iteration: 0, delta: 'xt","text":"More text"}' }, 'sess-1');
    await expect(preview.getByTestId('inline-ui-view')).toContainText('More text');
  });
  test('a refusal that arrives after the running turn streamed on still reaches the block', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await block.getByLabel('Basic').check();
    await block.getByLabel('Your name').fill('Ada');
    await block.getByRole('button', { name: 'Continue' }).click();
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    // A turn of the session is streaming: its delta comes before the refusal.
    gateway.event('chat.delta', { agentId: 'root-1', iteration: 0, delta: 'Working on it' }, 'sess-1');
    gateway.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'The interactive answer was not sent: the view changed' });
    await expect(block.getByTestId('inline-ui-view-error')).toContainText('the view changed');
    await expect(block.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('once the server took the send (chat.delivery), a later error frame is not its refusal', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await block.getByLabel('Basic').check();
    await block.getByLabel('Your name').fill('Ada');
    await block.getByRole('button', { name: 'Continue' }).click();
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    gateway.send({ type: 'chat.delivery', sessionId: 'sess-1', mode: 'auto', outcome: 'queued', ahead: 0 });
    gateway.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'some other frame' });
    await page.waitForTimeout(300);
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await expect(page.getByText('Message not sent: some other frame')).toHaveCount(0);
  });

  test('an answered block opens answered again after visiting another session', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await block.getByLabel('Pro').check();
    await block.getByLabel('Your name').fill('Ada');
    await block.getByRole('button', { name: 'Continue' }).click();
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await selectChatSession(page, 'sess-2');
    await expect(block).toHaveCount(0);
    await selectChatSession(page, 'sess-1');
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await expect(block.getByLabel('Pro')).toBeChecked();
    await expect(block.getByLabel('Your name')).toHaveValue('Ada');
  });

  test('an answer from another tab redraws the block from the server', async ({ authenticatedPage: page }) => {
    const overrides: Record<string, Partial<BlockStub>> = {};
    await stubBlocks(page, overrides);
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    await expect(block.getByLabel('Seats')).toHaveValue('3');
    overrides[PLAN] = { state: { data: { plan: 'pro', seats: 8, name: 'Bo' }, action: { name: 'plan_chosen', componentId: 'go', at: '2026-11-22T10:00:00.000Z' } } };
    gateway.event('chat.message', { role: 'user', content: 'I take pro for 8 seats', injected: true, inlineUiAction: { blockId: PLAN, name: 'plan_chosen', context: { plan: 'pro', seats: 8 } } }, 'sess-1', { source: 'steer:another-tab' });
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await expect(block.getByLabel('Seats')).toHaveValue('8');
  });

  test('a write that cannot land shows an error; the view stays', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(WRITES)]);
    const block = blockOf(page, 'Bad writes');
    await block.getByLabel('Done').first().click();
    await expect(block.getByTestId('inline-ui-view-error')).toContainText('cannot write "/items/0/done"');
    await expect(block.getByTestId('inline-ui-view-failed')).toHaveCount(0);
    await expect(block).toContainText('Still drawn');
    await block.getByLabel('Plan name').fill('x');
    await expect(block.getByTestId('inline-ui-view-error')).toContainText('cannot write "/plan/name"');
    await expect(block.getByTestId('inline-ui-view-failed')).toHaveCount(0);
  });

  test('a number field with a problem holds the answer back and says why', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(PLAN)]);
    const block = blockOf(page, 'Choose a plan');
    const go = block.getByRole('button', { name: 'Continue' });
    await block.getByLabel('Your name').fill('Ada');
    await block.getByLabel('Seats').fill('5');
    await block.getByLabel('Seats').fill('500');
    await expect(go).toBeDisabled();
    await expect(go).toHaveAttribute('title', 'Fix “Seats” first');
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Fix “Seats” to answer.');
    await block.getByLabel('Seats').fill('abc');
    await expect(go).toBeDisabled();
    await block.getByLabel('Seats').fill('6');
    await expect(go).toBeEnabled();
    await go.click();
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')?.inlineUi?.action?.context?.seats).toBe(6);
  });

  test('a set-only button is read-only after the answer until Change answer', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(SETS)]);
    const block = blockOf(page, 'Counter');
    const add = block.getByRole('button', { name: 'Add one' });
    await add.click();
    await expect(block.getByTestId('inline-ui-stat')).toContainText('2');
    await block.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => gateway.sent.filter((m) => m.type === 'chat.send').length).toBe(1);
    await expect(block.getByTestId('inline-ui-view-status')).toContainText('Answer sent');
    await expect(add).toBeDisabled();
    await block.getByRole('button', { name: 'Change answer' }).click();
    await expect(add).toBeEnabled();
  });

  test('a template slider with no number at its path writes the minimum it shows', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(SETS)]);
    const block = blockOf(page, 'Counter');
    await expect(block.getByLabel('Level')).toHaveValue('2');
    await block.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toBeTruthy();
    expect(gateway.sent.find((m) => m.type === 'chat.send')!.inlineUi.action.data).toEqual({ n: 1, items: [{ name: 'a', level: 2 }] });
  });

  test('a button with two events sends only the first', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(SETS)]);
    const block = blockOf(page, 'Counter');
    await block.getByRole('button', { name: 'Twice' }).click();
    await expect.poll(() => gateway.sent.filter((m) => m.type === 'chat.send').length).toBe(1);
    await page.waitForTimeout(200);
    const sends = gateway.sent.filter((m) => m.type === 'chat.send');
    expect(sends).toHaveLength(1);
    expect(sends[0].content).toBe('First');
    expect(sends[0].inlineUi.action.name).toBe('first');
  });

  test('an answer whose data model is over the limit is sent without its data', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    const gateway = await openWithHistory(page, [reply(WIDE)]);
    const block = blockOf(page, 'Wide rows');
    await block.getByLabel('Select r1').check();
    await block.getByLabel('Select r2').check();
    await block.getByLabel('Select r3').check();
    await block.getByRole('button', { name: 'Use these' }).click();
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toBeTruthy();
    const send = gateway.sent.find((m) => m.type === 'chat.send')!;
    expect(send.content).toBe('Use these rows');
    expect(send.inlineUi.action).toMatchObject({ blockId: WIDE, name: 'picked', context: { count: 3 } });
    expect(send.inlineUi.action).not.toHaveProperty('data');
  });

  test('rows that share a rowKey value are selected one by one', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(ROWS)]);
    const block = blockOf(page, 'Same names');
    const table = block.getByTestId('inline-ui-table');
    await expect(table.locator('thead th')).toHaveText(['Selected', 'Name', 'Region', 'Region again']);
    const boxes = table.getByLabel('Select api');
    await boxes.nth(0).check();
    await expect(boxes.nth(0)).toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    const picked = block.getByTestId('inline-ui-stat').filter({ hasText: 'Picked' });
    await expect(picked).toContainText('1');
    await boxes.nth(1).check();
    await expect(picked).toContainText('2');
    await boxes.nth(0).uncheck();
    await expect(boxes.nth(1)).toBeChecked();
    await expect(picked).toContainText('1');
  });

  test('a hidden row child leaves no slot', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(LAYOUT)]);
    const left = blockOf(page, 'Layout').getByText('Left', { exact: true });
    await expect(left).toBeVisible();
    expect(await left.evaluate((el) => el.parentElement?.parentElement?.children.length)).toBe(2);
  });

  test('a chart series keyed x keeps the axis labels', async ({ authenticatedPage: page }) => {
    await stubBlocks(page);
    await openWithHistory(page, [reply(LAYOUT)]);
    const chart = blockOf(page, 'Layout').getByTestId('inline-ui-chart');
    await expect(chart.getByRole('img', { name: 'Bar chart by m, 2 points: Visits from 10 to 20' })).toBeVisible();
    await chart.getByText('Show data').click();
    await expect(chart.locator('details tbody th')).toHaveText(['Jan', 'Feb']);
    await expect(chart.locator('details tbody td')).toHaveText(['10', '20']);
  });
});
