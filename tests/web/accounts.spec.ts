import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { InboxItem } from '../../src/shared/email';

/** Two Gmail accounts: home (the default) and work. */
const ACCOUNTS = [
  { provider: 'google', address: 'me@home.example', isDefault: true },
  { provider: 'google', address: 'me@work.example', isDefault: false },
];
const row = (id: string, subject: string, minutesAgo: number): InboxItem => ({
  id, threadId: `t-${id}`, provider: 'google', from: { name: 'Sender', email: 'sender@example.com' }, subject, snippet: '', receivedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), unread: false,
});

async function stubTwoGmail(page: Page) {
  const lists: URL[] = [];
  const batches: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  await page.route('**/api/mail/accounts', route => json(route, 200, []));
  await page.route('**/api/email/accounts', route => json(route, 200, { accounts: ACCOUNTS }));
  await page.route('**/api/email/categories', route => json(route, 200, { categories: { work: 'job', other: 'none' }, defaults: {} }));
  await page.route('**/api/email/triage/settings', route => json(route, 200, { saved: false, settings: { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: [], instructions: '', skipDialog: false } }));
  await page.route('**/api/email/triage/run', route => json(route, 200, { run: null }));
  await page.route('**/api/email/messages?**', route => {
    const url = new URL(route.request().url());
    lists.push(url);
    // The server names the account on the rows of a further account.
    const work = url.searchParams.get('account') === 'me@work.example';
    return json(route, 200, { provider: 'google', items: work ? [{ ...row('w1', 'Work mail', 5), account: 'me@work.example' }] : [row('h1', 'Home mail', 1), row('h2', 'Older home mail', 30)] });
  });
  await page.route('**/api/email/messages/batch', route => { batches.push(route.request().postDataJSON()); return json(route, 200, { done: route.request().postDataJSON().ids, failed: [] }); });
  await page.route('**/api/email/send', route => { sends.push(route.request().postDataJSON()); return json(route, 200, { sent: true }); });
  return { lists, batches, sends };
}

test('two Gmail accounts are two mailboxes: each is listed on its own account, and its mail is sent from it', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubTwoGmail(page);
  await page.goto('/email');
  await expect(page.getByText('Home mail', { exact: true })).toBeVisible();
  const mailbox = page.getByRole('combobox', { name: 'Mailbox', exact: true });
  await expect(mailbox.getByRole('option', { name: 'Gmail — me@home.example' })).toBeAttached();
  await expect(mailbox.getByRole('option', { name: 'Gmail — me@work.example' })).toBeAttached();
  // The default account's list names no account; the other one's does.
  expect(box.lists.every((u) => !u.searchParams.has('account'))).toBe(true);
  await mailbox.selectOption('google:me@work.example');
  await expect(page.getByText('Work mail', { exact: true })).toBeVisible();
  await expect(page.getByText('Home mail', { exact: true })).toHaveCount(0);
  expect(box.lists.at(-1)!.searchParams.get('account')).toBe('me@work.example');
  // A new message from this mailbox is sent from this account.
  await page.getByRole('button', { name: 'Compose' }).click();
  const compose = page.getByRole('form', { name: 'New message' });
  await compose.getByLabel('To').fill('someone@example.com');
  await compose.getByLabel('Subject').fill('Hello');
  await compose.getByRole('textbox', { name: 'Message' }).fill('Hi.');
  await compose.getByRole('button', { name: 'Send', exact: true }).click();
  await compose.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => box.sends).toEqual([expect.objectContaining({ to: 'someone@example.com', provider: 'google', account: 'me@work.example', confirm: true })]);
});

test('All inboxes merges both accounts by date and sends each action to the account the mail is in', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubTwoGmail(page);
  await page.goto('/email');
  await expect(page.getByText('Home mail', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('all');
  const rows = page.getByRole('region', { name: 'Messages' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Home mail');
  await expect(rows.nth(1)).toContainText('Work mail');
  // Two accounts of one provider: each row says which address it is in.
  await expect(rows.nth(1)).toContainText('me@work.example');
  await expect(rows.nth(0)).toContainText('me@home.example');
  await page.getByLabel('Select conversation: Home mail').check();
  await page.getByLabel('Select conversation: Work mail').check();
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: 'Archive' }).click();
  await expect.poll(() => box.batches).toEqual([
    { ids: ['h1'], action: 'archive', provider: 'google' },
    { ids: ['w1'], action: 'archive', provider: 'google', account: 'me@work.example' },
  ]);
});

test('Settings lists each connected account: add another, make one the default, disconnect one', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  let accounts = [{ account: 'me@home.example', isDefault: true }, { account: 'me@work.example', isDefault: false }];
  const calls: Array<{ path: string; body?: unknown }> = [];
  await page.route('**/api/auth/oauth/microsoft/status', route => json(route, 200, { connected: false, provider: 'microsoft' }));
  await page.route('**/api/auth/oauth/google/status', route => json(route, 200, { connected: accounts.length > 0, provider: 'google', email: accounts[0]?.account, accounts: accounts.length }));
  await page.route('**/api/auth/oauth/google/accounts', route => json(route, 200, { provider: 'google', accounts }));
  await page.route('**/api/auth/oauth/google/authorize**', route => { calls.push({ path: new URL(route.request().url()).pathname + new URL(route.request().url()).search }); return json(route, 200, { url: 'about:blank' }); });
  await page.route('**/api/auth/oauth/google/accounts/default', route => {
    const body = route.request().postDataJSON() as { account: string };
    calls.push({ path: '/default', body });
    accounts = accounts.map((a) => ({ ...a, isDefault: a.account === body.account })).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return json(route, 200, { success: true });
  });
  await page.route('**/api/auth/oauth/google/disconnect', route => {
    const body = route.request().postDataJSON() as { account?: string } | null;
    calls.push({ path: '/disconnect', body });
    accounts = accounts.filter((a) => a.account !== body?.account).map((a, i) => ({ ...a, isDefault: i === 0 }));
    return json(route, 200, { success: true });
  });
  await page.goto('/settings?tab=integrations');
  const list = page.getByRole('list', { name: 'Google Workspace accounts' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').nth(0)).toContainText('me@home.example');
  await expect(list.getByRole('listitem').nth(0)).toContainText('Default');

  // Add another account: the connect asks for a further account, not the default again.
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Add another account' }).first().click();
  await (await popup).close();
  await expect.poll(() => calls.find((c) => c.path.includes('/authorize'))?.path).toBe('/api/auth/oauth/google/authorize?addAccount=true');

  await list.getByRole('button', { name: 'Make default' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/default')?.body).toEqual({ account: 'me@work.example' });
  await expect(list.getByRole('listitem').nth(0)).toContainText('me@work.example');
  await expect(list.getByRole('listitem').nth(0)).toContainText('Default');

  await list.getByRole('button', { name: 'Disconnect me@home.example' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/disconnect')?.body).toEqual({ account: 'me@home.example' });
  // One account left: no list, the card says who is connected.
  await expect(page.getByRole('list', { name: 'Google Workspace accounts' })).toHaveCount(0);
  await expect(page.getByText('Connected as:')).toContainText('me@work.example');
});

test('All inboxes with two Gmail accounts and an IMAP mailbox: triage names each mailbox, and only Gmail mail offers attachments', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await stubTwoGmail(page);
  const imapId = '5c0f2a1e-1111-4222-8333-444455556666';
  await page.route('**/api/mail/accounts', route => json(route, 200, [{
    id: imapId, workspaceId: null, label: 'Office', address: 'info@office.example', displayName: null, protocol: 'imap',
    incoming: { host: 'imap.office.example', port: 993, security: 'tls', username: 'info@office.example' },
    outgoing: { host: 'smtp.office.example', port: 465, security: 'tls', username: 'info@office.example' },
    folder: 'INBOX', enabled: true, fileAttachments: false, defaultProtectionLevel: null,
    passwordSet: { incoming: true, outgoing: true }, lastSyncAt: null, lastError: null, createdAt: new Date().toISOString(),
  }]));
  await page.route('**/api/mail/client/messages?**', route => json(route, 200, { provider: null, items: [{
    id: 'i1', provider: 'imap', mailbox: `imap:${imapId}`, status: 'received', from: { email: 'clerk@court.example' }, subject: 'Office mail',
    snippet: '', receivedAt: new Date(Date.now() - 10 * 60_000).toISOString(), unread: false,
  }] }));
  let preview: { items: Array<{ id: string; mailbox?: string }> } | undefined;
  await page.route('**/api/email/triage/preview**', route => {
    preview = route.request().postDataJSON();
    return json(route, 200, { error: 'stop here' });
  });
  await page.goto('/email');
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('all');
  const rows = page.getByRole('region', { name: 'Messages' }).getByRole('listitem');
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Triage inbox' }).click();
  // Each row names its own mailbox: the default account bare, the other by its address, IMAP by its id.
  await expect.poll(() => Object.fromEntries((preview?.items ?? []).map((it) => [it.id, it.mailbox]))).toEqual({
    h1: 'google', h2: 'google', w1: 'google:me@work.example', i1: `imap:${imapId}`,
  });
  await page.keyboard.press('Escape');
  // A reply in the work account can carry files; one in the IMAP mailbox says it cannot.
  await page.route('**/api/email/thread/t-w1?**', route => json(route, 200, { messages: [{ ...row('w1', 'Work mail', 5), account: 'me@work.example', body: 'Hi', attachments: [] }] }));
  await page.route('**/api/mail/client/messages/i1', route => json(route, 200, { id: 'i1', provider: 'imap', mailbox: `imap:${imapId}`, status: 'received', from: { email: 'clerk@court.example' }, subject: 'Office mail', snippet: '', receivedAt: new Date().toISOString(), unread: false, cc: [], body: 'Letter', attachments: [] }));
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: /Work mail/ }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Reply' }).getByRole('button', { name: 'Attach files' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Reply' }).getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  await page.getByRole('form', { name: 'Reply' }).getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: /Office mail/ }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const imapReply = page.getByRole('form', { name: 'Reply' });
  await expect(imapReply.getByText('An IMAP / POP3 mailbox sends plain text without attachments.')).toBeVisible();
  await expect(imapReply.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
});
