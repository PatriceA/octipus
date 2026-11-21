import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { EmailMessage, InboxItem } from '../../src/shared/email';
import type { MailAccountView } from '../../src/shared/mail';

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const ACCOUNT = 'a1';
const BOX = `imap:${ACCOUNT}` as const;

const account = (extra: Partial<MailAccountView> = {}): MailAccountView => ({
  id: ACCOUNT, workspaceId: null, label: 'Office', address: 'info@office.example', displayName: null, protocol: 'imap',
  incoming: { host: 'imap.office.example', port: 993, security: 'tls', username: 'info@office.example' },
  outgoing: { host: 'smtp.office.example', port: 465, security: 'tls', username: 'info@office.example' },
  folder: 'INBOX', enabled: true, fileAttachments: false, defaultProtectionLevel: 3,
  passwordSet: { incoming: true, outgoing: true }, lastSyncAt: at(3), lastError: null, createdAt: at(60 * 24), ...extra,
});
const imapRow = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  id, provider: 'imap', mailbox: BOX, status: 'received', from: { name: 'Clerk', email: 'clerk@court.example' }, to: [{ email: 'info@office.example' }],
  subject: `Court letter ${id}`, snippet: 'Please send the documents', receivedAt: at(10), unread: true, hasAttachments: false, ...extra,
});
const imapMessage = (row: InboxItem, extra: Partial<EmailMessage> = {}): EmailMessage => ({ ...row, cc: [], body: `Body of ${row.subject}`, attachments: [], ...extra });
const gmailRow = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id, threadId: `t-${id}`, provider: 'google', from: { name: 'Boss', email: 'boss@example.com' }, subject: `Gmail ${id}`, snippet: '', receivedAt: at(1), unread: false, ...extra });

interface Stubs {
  lists: URL[];
  changes: Array<{ ids: string[]; action: string; provider?: string }>;
  drafts: Array<{ method: string; body: Record<string, unknown> }>;
  sends: unknown[];
  preview?: Record<string, unknown>;
  run?: Record<string, unknown>;
  settings: Array<Record<string, unknown>>;
  labels: Array<{ url: string; body: unknown }>;
}

/** An IMAP mailbox (and optionally a Gmail one) behind the routes the mail window reads. */
async function stub(page: Page, rows: InboxItem[], opts: { gmail?: InboxItem[]; account?: Partial<MailAccountView>; lastAuto?: Record<string, unknown> } = {}): Promise<Stubs> {
  const s: Stubs = { lists: [], changes: [], drafts: [], sends: [], settings: [], labels: [] };
  const settings = { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: ['promotion'], instructions: '', skipDialog: false, auto: false };
  await page.route('**/api/mail/accounts', route => json(route, 200, [account(opts.account)]));
  await page.route('**/api/email/accounts', route => json(route, 200, { accounts: opts.gmail ? [{ provider: 'google', address: 'me@gmail.example' }] : [] }));
  await page.route('**/api/email/categories', route => json(route, 200, { categories: { work: 'job mail', legal: 'courts and lawyers', other: 'none of the above' }, defaults: {} }));
  await page.route('**/api/email/triage/settings', route => {
    if (route.request().method() === 'PUT') { s.settings.push(route.request().postDataJSON()); return json(route, 200, { saved: true, settings: { ...settings, ...route.request().postDataJSON() } }); }
    return json(route, 200, { saved: false, settings, lastAuto: opts.lastAuto ?? null });
  });
  await page.route('**/api/mail/client/messages?**', route => {
    const url = new URL(route.request().url());
    s.lists.push(url);
    const folder = url.searchParams.get('folder');
    return json(route, 200, { provider: null, mailbox: BOX, items: folder === 'inbox' ? rows : folder === 'drafts' ? rows.filter(r => r.status === 'draft') : [], ...(folder === 'inbox' ? { unreadCount: rows.filter(r => r.unread).length } : {}) });
  });
  for (const row of rows) await page.route(`**/api/mail/client/messages/${row.id}`, route => json(route, 200, imapMessage(row, row.status === 'draft' ? { revision: 'c'.repeat(64), body: 'Draft text', sendError: 'Mailbox full' } : {})));
  await page.route('**/api/mail/client/messages/batch', route => { s.changes.push(route.request().postDataJSON()); return json(route, 200, { done: route.request().postDataJSON().ids, failed: [] }); });
  if (opts.gmail) {
    await page.route('**/api/email/messages?**', route => json(route, 200, { provider: 'google', items: new URL(route.request().url()).searchParams.get('folder') === 'inbox' ? opts.gmail : [], unreadCount: 0 }));
    await page.route('**/api/email/messages/batch', route => { s.changes.push(route.request().postDataJSON()); return json(route, 200, { done: route.request().postDataJSON().ids, failed: [] }); });
  }
  await page.route('**/api/mail/drafts', route => {
    const body = route.request().postDataJSON();
    s.drafts.push({ method: 'POST', body });
    // A reply's recipients, subject and quote come from the original, on the server.
    const reply = !!body.replyTo;
    return json(route, 201, {
      id: 'd1', accountId: ACCOUNT, revision: 'a'.repeat(64), status: 'draft', from: null,
      to: [{ address: reply ? 'clerk@court.example' : body.to }], cc: [], subject: reply ? 'Re: Court letter m1' : body.subject,
      snippet: '', date: at(0), unread: false, hasAttachments: false, protectionLevel: 3, messageIdHeader: null, inReplyTo: null,
      text: reply ? `${body.body}\n\n> Body of Court letter m1` : body.body, html: null, attachments: [], rawKept: false, error: null,
    });
  });
  await page.route('**/api/mail/drafts/d1', route => {
    const body = route.request().postDataJSON();
    s.drafts.push({ method: route.request().method(), body });
    return json(route, 200, { id: 'd1', accountId: ACCOUNT, revision: 'b'.repeat(64), status: 'draft', from: null, to: [{ address: body.to }], cc: [], subject: body.subject, snippet: '', date: at(0), unread: false, hasAttachments: false, protectionLevel: 3, messageIdHeader: null, inReplyTo: null, text: body.body, html: null, attachments: [], rawKept: false, error: null });
  });
  await page.route('**/api/mail/drafts/d1/send', route => { s.sends.push(route.request().postDataJSON()); return json(route, 200, { id: 'd1', status: 'sent' }); });
  await page.route('**/api/email/imap/triage/label/**', route => { s.labels.push({ url: route.request().url(), body: route.request().postDataJSON() }); return json(route, 200, { ok: true }); });
  await page.route('**/api/email/triage/run', route => {
    if (route.request().method() === 'POST') { s.run = route.request().postDataJSON(); return json(route, 202, { run: { id: 'r1', total: 1, done: 0, stage: 'starting', finished: false } }); }
    return json(route, 200, { run: s.run ? { id: 'r1', total: 1, done: 1, stage: 'done', finished: true, result: { triage: { m1: { priority: 'high', category: 'legal', reason: 'Court deadline', source: 'llm' } }, labeled: 0, archived: [], archiveProposed: [], protected: 1 } } : null });
  });
  await page.route('**/api/email/triage/preview**', route => {
    s.preview = route.request().postDataJSON();
    return json(route, 200, {
      settings, capabilities: { labels: !!opts.gmail, archive: !!opts.gmail, imap: true }, lastAuto: opts.lastAuto ?? null,
      counts: { untriaged: rows.length, unread: rows.length, all: rows.length }, ownerLabelled: 0,
      categories: { work: 'job mail', legal: 'courts and lawyers', other: 'none of the above' },
      rules: { priority: ['low', 'normal', 'high'], sees: 'The sender, the subject and the first lines.', examples: 'Up to five earlier mails.' },
      models: { decision: null, llm: { name: 'local-llm' } }, thresholds: null,
    });
  });
  return s;
}

test('an IMAP mailbox opens in the three-pane mail window, with its own folders and no actions it cannot do', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const s = await stub(page, [imapRow('m1'), imapRow('m2', { unread: false, hasAttachments: true })], { account: { lastError: 'Login refused' } });
  await page.goto('/email');
  const list = page.getByRole('region', { name: 'Messages' });
  await expect(list.getByText('Court letter m1')).toBeVisible();
  expect(s.lists[0].searchParams.get('account')).toBe(ACCOUNT);
  // An IMAP mailbox has what Octipus stores for it: no archive, trash or stars.
  const folders = page.getByRole('navigation', { name: 'Folders' });
  await expect(folders.getByRole('button')).toHaveText([/Inbox\s*1$/, /Sent$/, /Drafts$/, /Failed sends$/]);
  await expect(page.getByText('Last sync failed — Office: Login refused')).toBeVisible();
  await list.getByRole('button', { name: /Court letter m1/ }).click();
  const reader = page.getByRole('article', { name: 'Conversation: Court letter m1' });
  await expect(reader.getByText('Body of Court letter m1')).toBeVisible();
  await expect.poll(() => s.changes).toEqual([{ ids: ['m1'], action: 'read' }]);
  await expect(reader.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Move to trash' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Star' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Summarize' })).toBeVisible();
  // Bulk: read / unread only.
  await page.getByLabel('Select conversation: Court letter m2').check();
  await expect(list.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await list.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect.poll(() => s.changes.at(-1)).toEqual({ ids: ['m2'], action: 'unread' });
  await folders.getByRole('button', { name: 'Failed sends' }).click();
  await expect.poll(() => s.lists.some(u => u.searchParams.get('folder') === 'failed')).toBe(true);
});

test('a reply from an IMAP mailbox is saved as a draft, confirmed with what was saved, and sent as that revision', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const s = await stub(page, [imapRow('m1')]);
  await page.goto('/email');
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: /Court letter m1/ }).click();
  await page.getByRole('article').getByRole('button', { name: 'Reply', exact: true }).click();
  const form = page.getByRole('form', { name: 'Reply' });
  // Recipients and the quote come from the original, on the server.
  await expect(form.getByText('Recipients, subject and the quoted original are taken from the message', { exact: false })).toBeVisible();
  await expect(form.getByLabel('Bcc')).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Message' }).fill('The documents follow by post.');
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  const confirm = form.getByRole('alertdialog', { name: 'Confirm send' });
  await expect(confirm).toContainText('Send the saved draft from info@office.example to clerk@court.example?');
  await expect(confirm).toContainText('Subject: Re: Court letter m1');
  expect(s.drafts).toEqual([{ method: 'POST', body: { replyTo: 'm1', body: 'The documents follow by post.', all: false } }]);
  expect(s.sends).toEqual([]);
  // A change after saving is saved again (a new revision) before it can go.
  await form.getByRole('textbox', { name: 'Message' }).fill('The documents follow by courier.');
  await expect(confirm).toHaveCount(0);
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(form.getByRole('alertdialog', { name: 'Confirm send' })).toBeVisible();
  expect(s.drafts[1]).toMatchObject({ method: 'PATCH', body: { to: 'clerk@court.example', subject: 'Re: Court letter m1', body: 'The documents follow by courier.' } });
  await form.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => s.sends).toEqual([{ confirm: true, expectedRevision: 'b'.repeat(64) }]);
  await expect(page.getByRole('status')).toContainText('Message sent.');
});

test('a saved draft opens again from Drafts, shows why its send failed, and is sent as saved', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const draft = imapRow('d1', { status: 'draft', subject: 'Unsent answer', unread: false, to: [{ email: 'clerk@court.example' }] });
  const s = await stub(page, [imapRow('m1'), draft]);
  await page.route('**/api/mail/client/messages/d1', route => json(route, 200, imapMessage(draft, { revision: 'c'.repeat(64), body: 'Draft text', sendError: 'Mailbox full' })));
  await page.goto('/email');
  await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: 'Drafts' }).click();
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: /Unsent answer/ }).click();
  const reader = page.getByRole('article', { name: 'Conversation: Unsent answer' });
  await expect(reader.getByText('The last send failed: Mailbox full')).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await reader.getByRole('button', { name: 'Edit draft' }).click();
  const form = page.getByRole('form', { name: 'Draft' });
  await expect(form.getByLabel('To', { exact: true })).toHaveValue('clerk@court.example');
  // Unchanged: no new save, the saved revision is what is confirmed and sent.
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await form.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => s.sends).toEqual([{ confirm: true, expectedRevision: 'c'.repeat(64) }]);
  expect(s.drafts).toEqual([]);
});

test('All inboxes merges Gmail and IMAP mail, and each action goes only where it can', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const s = await stub(page, [imapRow('m1', { receivedAt: at(5) })], { gmail: [gmailRow('g1', { receivedAt: at(1) }), gmailRow('g2', { receivedAt: at(30) })] });
  await page.goto('/email');
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('all');
  const rows = page.getByRole('region', { name: 'Messages' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Gmail g1');
  await expect(rows.nth(1)).toContainText('Court letter m1');
  await expect(rows.nth(1)).toContainText('Office');
  await expect(rows.nth(2)).toContainText('Gmail g2');
  // Gmail's folders and the IMAP mailbox's failed sends.
  await expect(page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: 'Failed sends' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: 'Archive' })).toBeVisible();
  await page.getByLabel('Select conversation: Gmail g1').check();
  await page.getByLabel('Select conversation: Court letter m1').check();
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: 'Archive' }).click();
  // The IMAP mail stays where it is: nothing on its server is changed.
  await expect.poll(() => s.changes).toEqual([{ ids: ['g1'], action: 'archive', provider: 'google' }]);
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('Court letter m1')).toBeVisible();
  // A new message asks which mailbox sends it, IMAP included.
  await page.getByRole('button', { name: 'Compose' }).click();
  await expect(page.getByRole('form', { name: 'New message' }).getByLabel('From').locator('option')).toHaveText(['me@gmail.example', 'info@office.example']);
});

test('triage on an IMAP mailbox names the mailbox, offers only what works there, and turns automatic triage on', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const s = await stub(page, [imapRow('m1')], { lastAuto: { at: at(30), triaged: 3, archived: 0, skipped: 2 } });
  await page.goto('/email');
  await expect(page.getByText('Court letter m1')).toBeVisible();
  await page.getByRole('button', { name: 'Triage inbox' }).click();
  const dialog = page.getByRole('dialog', { name: 'Triage inbox' });
  await expect(dialog.getByText('1 mail will be triaged.', { exact: false })).toBeVisible();
  expect(s.preview).toEqual({ items: [{ id: 'm1', unread: true, mailbox: BOX }] });
  // No labels or archiving for an IMAP mailbox: the dialog says so instead of offering them.
  await expect(dialog.getByRole('region', { name: 'After triage' })).toContainText('An IMAP or POP3 mailbox keeps its mail as it is');
  await expect(dialog.getByLabel(/Label each mail/)).toHaveCount(0);
  // Automatic triage, what it costs, and how the last run went.
  const auto = dialog.getByRole('region', { name: 'Automatic triage' });
  await expect(auto).toContainText('Every run asks the models above');
  await expect(auto).toContainText('3 triaged, 2 kept from the models by their protection level');
  await auto.getByLabel(/Triage new mail automatically/).check();
  await dialog.getByRole('button', { name: 'Triage 1 mail' }).click();
  await expect.poll(() => s.settings.at(-1)).toMatchObject({ auto: true });
  await expect.poll(() => s.run).toEqual({ items: [{ id: 'm1', from: { name: 'Clerk', email: 'clerk@court.example' }, subject: 'Court letter m1', snippet: 'Please send the documents', mailbox: BOX }] });
  // The result says what protection kept back.
  await expect(dialog.getByText('1 IMAP mail was left out', { exact: false })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  const list = page.getByRole('region', { name: 'Messages' });
  await expect(list.getByText('high', { exact: true })).toBeVisible();
  // The owner's own label on IMAP mail goes to the IMAP route.
  await list.getByRole('button', { name: /Court letter m1/ }).click();
  await page.getByRole('article').getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'low' }).click();
  await expect.poll(() => s.labels.map(l => [new URL(l.url).pathname, l.body])).toEqual([['/api/email/imap/triage/label/m1', { priority: 'low', category: 'legal' }]]);
});
