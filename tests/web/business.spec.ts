import { expect, test } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

const NOW = '2026-10-22T10:00:00.000Z';

const CASE = {
  id: 'c1', userId: 'e2e-user-id', workspaceId: null, title: 'Pay R-4711', kind: 'invoice', status: 'open', summary: null,
  assigneeUserId: null, source: 'user', externalKey: null, closedAt: null, createdAt: NOW, updatedAt: NOW,
};

const TYPE = {
  id: 't1', userId: 'e2e-user-id', workspaceId: null, key: 'invoice', name: 'Invoice', description: null, titleField: 'number',
  fields: [
    { key: 'number', label: 'Number', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'money' },
  ],
  createdAt: NOW, updatedAt: NOW,
};

test.describe('cases, contacts and records', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
  });

  test('a case shows what is linked to it and adds a follow-up', async ({ authenticatedPage: page }) => {
    let followUp: unknown = null;
    await page.route('**/api/cases?**', (route) => json(route, 200, [CASE]));
    await page.route('**/api/cases/c1', (route) => json(route, 200, {
      ...CASE,
      links: [{ id: 'l1', entityType: 'contact', entityId: 'k1', role: 'client', createdAt: NOW, label: 'Maria Muster', detail: 'person' }],
    }));
    await page.route('**/api/cases/c1/follow-ups', async (route) => {
      followUp = route.request().postDataJSON();
      await json(route, 200, { task: { id: 'task1' }, link: {} });
    });
    await page.goto('/cases');
    await page.getByRole('button', { name: /Pay R-4711/ }).click();
    await expect(page.getByText('Maria Muster')).toBeVisible();
    await expect(page.getByText('client', { exact: true })).toBeVisible();
    await page.getByLabel('Follow-up').fill('Check payment');
    await page.getByLabel('Remind on').fill('2030-01-15');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect.poll(() => followUp).toMatchObject({ title: 'Check payment', remindAt: '2030-01-15' });
  });

  test('a refused record lists every problem', async ({ authenticatedPage: page }) => {
    await page.route('**/api/record-types', (route) => json(route, 200, [TYPE]));
    await page.route('**/api/records?**', (route) => json(route, 200, []));
    await page.route('**/api/record-types/t1/form-links', (route) => json(route, 200, []));
    await page.route('**/api/records', (route) => json(route, 400, { error: 'x', problems: ['Number: required', 'Amount: must be a number'] }));
    await page.goto('/records');
    await page.getByRole('button', { name: 'New Invoice' }).click();
    // The browser's own required check stops an empty Number; fill it and let the server refuse.
    await page.getByLabel('Number *').fill('R-1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Number: required');
    await expect(page.getByRole('alert')).toContainText('Amount: must be a number');
  });

  test('switching rows shows the clicked record, never the previous draft', async ({ authenticatedPage: page }) => {
    const row = (id: string, number: string) => ({ id, userId: 'e2e-user-id', workspaceId: null, typeId: 't1', title: number, data: { number }, source: 'user', externalKey: null, createdAt: NOW, updatedAt: NOW });
    await page.route('**/api/record-types', (route) => json(route, 200, [TYPE]));
    await page.route('**/api/records?**', (route) => json(route, 200, [row('r1', 'R-1'), row('r2', 'R-2')]));
    await page.route('**/api/record-types/t1/form-links', (route) => json(route, 200, []));
    await page.goto('/records');
    await page.getByRole('cell', { name: 'R-1' }).click();
    await expect(page.getByLabel('Number *')).toHaveValue('R-1');
    await page.getByLabel('Number *').fill('edited');
    await page.getByRole('cell', { name: 'R-2' }).click();
    await expect(page.getByLabel('Number *')).toHaveValue('R-2');
  });
});

test.describe('public form', () => {
  test('renders without sign-in and sends the answers', async ({ unauthenticatedPage: page }) => {
    let sent: unknown = null;
    await page.route('**/api/forms/tok-123456789012345678', async (route) => {
      if (route.request().method() === 'GET') return json(route, 200, { title: 'Apply now', intro: 'We call back.', fields: TYPE.fields });
      sent = route.request().postDataJSON();
      return json(route, 200, { submitted: true });
    });
    await page.goto('/forms/tok-123456789012345678');
    await expect(page.getByRole('heading', { name: 'Apply now' })).toBeVisible();
    await expect(page.getByText('We call back.')).toBeVisible();
    await page.getByLabel('Number *').fill('R-9');
    await page.getByLabel('Amount').fill('9.99');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(/Thank you/)).toBeVisible();
    expect(sent).toEqual({ data: { number: 'R-9', amount: '9.99' } });
  });

  test('a dead link says so', async ({ unauthenticatedPage: page }) => {
    await page.route('**/api/forms/**', (route) => json(route, 404, { error: 'This form is not available' }));
    await page.goto('/forms/gone-000000000000000000');
    await expect(page.getByText(/not available/)).toBeVisible();
  });
});
