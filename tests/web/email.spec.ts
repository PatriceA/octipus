import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { InboxItem } from '../../src/shared/email';
import type { MailAccountView, MailMessageView } from '../../src/shared/mail';

const now = new Date().toISOString();
const row = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id, threadId: `t-${id}`, provider: 'google', from: { name: 'Boss', email: 'boss@example.com' }, subject: `Subject ${id}`, snippet: `Snippet ${id}`, receivedAt: now, unread: false, ...extra });

interface Mailbox {
  items: InboxItem[];
  lists: URL[];
  batches: Array<{ ids: string[]; action: string; provider?: string }>;
}

/** A Google mailbox behind the routes the Email page reads. */
async function stubMailbox(page: Page, items: InboxItem[], accounts = [{ provider: 'google', address: 'me@example.com' }]): Promise<Mailbox> {
  const box: Mailbox = { items, lists: [], batches: [] };
  await page.route('**/api/mail/accounts', route => json(route, 200, []));
  await page.route('**/api/email/accounts', route => json(route, 200, { accounts }));
  await page.route('**/api/email/categories', route => json(route, 200, { categories: { work: 'job mail', promotion: 'marketing', other: 'none of the above' }, defaults: {} }));
  await page.route('**/api/email/triage/settings', route => json(route, 200, { saved: false, settings: { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: ['promotion'], instructions: '', skipDialog: false } }));
  await page.route('**/api/email/triage/run', route => json(route, 200, { run: null }));
  await page.route('**/api/email/messages?**', route => {
    const url = new URL(route.request().url());
    box.lists.push(url);
    return json(route, 200, { provider: url.searchParams.get('provider'), items: url.searchParams.get('folder') === 'inbox' ? box.items : [], unreadCount: box.items.filter(it => it.unread).length });
  });
  await page.route('**/api/email/messages/batch', route => { box.batches.push(route.request().postDataJSON()); return json(route, 200, { done: route.request().postDataJSON().ids, failed: [] }); });
  return box;
}

test('the mail window is on screen before the list arrives, then shows conversations with their stored triage', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await stubMailbox(page, []);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/email/messages?**', async route => {
    await held;
    return json(route, 200, { provider: 'google', unreadCount: 2, items: [
      row('a2', { threadId: 't-a', unread: true, triage: { priority: 'high', category: 'work', reason: 'Asks for a confirmation today', source: 'llm' } }),
      row('a1', { threadId: 't-a' }),
      row('b1', { subject: 'Sale', triage: { priority: 'low', category: 'promotion', source: 'decision' } }),
    ] });
  });
  await page.goto('/email');
  // The frame does not wait for mail.
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: /Inbox/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();
  await expect(page.getByText('Subject a2')).toHaveCount(0);
  release();
  const list = page.getByRole('region', { name: 'Messages' });
  // Two messages of one conversation are one row.
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByText('high', { exact: true })).toHaveAttribute('title', /LLM — Asks for a confirmation today/);
  await list.getByLabel('Category filter').selectOption({ label: 'promotion (1)' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText('Sale')).toBeVisible();
  await expect(page.getByLabel('2 unread')).toBeVisible();
});

test('folders, search and the unread filter ask the server; bulk archive can be undone', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, [row('a'), row('b'), row('c')]);
  await page.goto('/email');
  await expect(page.getByText('Subject a')).toBeVisible();
  await page.getByLabel('Search mail').fill('invoice');
  await page.getByLabel('Search mail').press('Enter');
  await expect.poll(() => box.lists.some(u => u.searchParams.get('q') === 'invoice')).toBe(true);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect.poll(() => box.lists.some(u => u.searchParams.get('unread') === 'true')).toBe(true);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Select conversation: Subject a').check();
  await page.getByLabel('Select conversation: Subject b').check();
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: 'Archive' }).click();
  await expect.poll(() => box.batches).toEqual([{ ids: ['a', 'b'], action: 'archive', provider: 'google' }]);
  await expect(page.getByText('Subject a')).toHaveCount(0);
  await expect(page.getByText('Subject c')).toBeVisible();
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => box.batches.at(-1)).toEqual({ ids: ['a', 'b'], action: 'unarchive', provider: 'google' });
  await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: 'Sent' }).click();
  await expect.poll(() => box.lists.some(u => u.searchParams.get('folder') === 'sent')).toBe(true);
  await expect(page.getByText('Nothing here.')).toBeVisible();
});

test('a conversation opens as a thread: images held back, attachments, label correction, and a threaded reply sent in two steps', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, [row('m2', { threadId: 't1', unread: true, subject: 'Budget' })]);
  await page.route('**/api/email/thread/t1?**', route => json(route, 200, { messages: [
    { ...row('m1', { threadId: 't1', subject: 'Budget' }), to: [{ email: 'me@example.com' }], body: 'First message' },
    { ...row('m2', { threadId: 't1', subject: 'Budget', unread: true }), to: [{ email: 'me@example.com' }, { email: 'cfo@example.com' }], body: 'Please confirm', html: '<p>Please confirm</p><img data-remote-src="https://track.example/p.gif" alt="logo">', attachments: [{ id: '1', name: 'budget.pdf', size: 20480, contentType: 'application/pdf' }] },
  ] }));
  const sent: Array<Record<string, unknown>> = [];
  const labels: Array<Record<string, unknown>> = [];
  await page.route('**/api/email/send', route => { sent.push(route.request().postDataJSON()); return json(route, 200, { sent: true }); });
  await page.route('**/api/email/triage/label/m2?**', route => { labels.push(route.request().postDataJSON()); return json(route, 200, { ok: true }); });
  let imageRequests = 0;
  await page.route('https://track.example/**', route => { imageRequests++; return route.fulfill({ status: 200, contentType: 'image/gif', body: '' }); });
  await page.goto('/email');
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: /Budget/ }).click();
  const reader = page.getByRole('article', { name: 'Conversation: Budget' });
  // Earlier message folded, newest open, in a frame of its own.
  await expect(reader.getByRole('region', { name: 'Message from Boss' })).toHaveCount(2);
  await expect(reader.frameLocator('iframe').getByText('Please confirm')).toBeVisible();
  await expect(reader.getByText('First message')).toHaveCount(0);
  // Opening reads it.
  await expect.poll(() => box.batches).toContainEqual({ ids: ['m2'], action: 'read', provider: 'google' });
  await expect(reader.getByText('Images are not loaded', { exact: false })).toBeVisible();
  expect(imageRequests).toBe(0);
  await reader.getByRole('button', { name: 'Show images' }).click();
  await expect.poll(() => imageRequests).toBe(1);
  await expect(reader.getByRole('button', { name: /budget\.pdf/ })).toContainText('20 KB');
  // The owner labels it in place.
  await reader.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'high' }).click();
  await expect.poll(() => labels).toEqual([{ priority: 'high', category: 'other', item: { from: { name: 'Boss', email: 'boss@example.com' }, subject: 'Budget', snippet: 'Snippet m2' } }]);
  await expect(reader.getByText('set by you')).toBeVisible();
  // Reply all: sender in To, the other recipient in Cc, never the mailbox itself.
  await reader.getByRole('button', { name: 'Reply all' }).click();
  const compose = page.getByRole('form', { name: 'Reply all' });
  await expect(compose.getByLabel('To')).toHaveValue('boss@example.com');
  await expect(compose.getByLabel('Cc', { exact: true })).toHaveValue('cfo@example.com');
  await expect(compose.getByLabel('Subject')).toHaveValue('Re: Budget');
  await compose.getByRole('textbox', { name: 'Message' }).fill('Confirmed.');
  await compose.getByRole('button', { name: 'Send', exact: true }).click();
  expect(sent).toHaveLength(0);
  await expect(compose.getByRole('alertdialog', { name: 'Confirm send' })).toContainText('Send to boss@example.com, cc cfo@example.com?');
  await compose.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => sent).toEqual([{ to: 'boss@example.com', cc: 'cfo@example.com', subject: 'Re: Budget', body: 'Confirmed.', format: 'rich', confirm: true, provider: 'google', replyTo: 'm2' }]);
  await expect(page.getByRole('status')).toContainText('Message sent.');
});

test('triage shows what it will do before it starts, runs with progress, and only proposes what to archive', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, [row('a', { unread: true }), row('b', { subject: 'Big sale' }), row('c', { triage: { priority: 'normal', category: 'work', source: 'owner' } })]);
  const calls: Record<string, unknown> = {};
  await page.route('**/api/email/triage/preview**', route => {
    calls.preview = route.request().postDataJSON();
    return json(route, 200, {
      settings: { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: ['promotion'], instructions: '', skipDialog: false },
      counts: { untriaged: 2, unread: 1, all: 3 }, ownerLabelled: 1,
      categories: { work: 'job mail', promotion: 'marketing', other: 'none of the above' },
      rules: { priority: ['low: nothing to do', 'normal: needs a reply', 'high: act today'], sees: 'The sender, the subject and the first lines.', examples: 'Up to five earlier mails from the same sender.' },
      models: { decision: { name: 'local-clef', local: true }, llm: { name: 'everyday-llm' } }, thresholds: { priority: 0.7, category: 0.7 },
    });
  });
  await page.route('**/api/email/triage/settings', route => {
    if (route.request().method() === 'PUT') { calls.settings = route.request().postDataJSON(); return json(route, 200, { saved: true, settings: calls.settings }); }
    return json(route, 200, { saved: false, settings: { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: ['promotion'], instructions: '', skipDialog: false } });
  });
  let polls = 0;
  const running = { id: 'r1', total: 2, done: 1, stage: 'decision', finished: false };
  const finished = { id: 'r1', total: 2, done: 2, stage: 'done', finished: true, result: { triage: { a: { priority: 'high', category: 'work', reason: 'Deadline today', source: 'llm' }, b: { priority: 'low', category: 'promotion', source: 'decision' } }, labeled: 0, archived: [], archiveProposed: ['b'] } };
  await page.route('**/api/email/triage/run**', route => {
    if (route.request().method() === 'POST') { calls.run = route.request().postDataJSON(); return json(route, 202, { run: running }); }
    if (!calls.run) return json(route, 200, { run: null });
    return json(route, 200, { run: ++polls > 1 ? finished : running });
  });
  await page.goto('/email');
  await expect(page.getByText('Subject a')).toBeVisible();
  await page.getByRole('button', { name: 'Triage inbox' }).click();
  const dialog = page.getByRole('dialog', { name: 'Triage inbox' });
  // Nothing has started: the owner first sees the scope, the categories, the rules and the models.
  await expect(dialog.getByText('2 mails will be triaged.', { exact: false })).toBeVisible();
  await expect(dialog.getByText('1 of the loaded mails carry your own label', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Categories' })).toContainText('promotion · marketing');
  await expect(dialog.getByRole('region', { name: 'What the model is told' })).toContainText('high: act today');
  await expect(dialog.getByRole('region', { name: 'What the model is told' })).toContainText('Up to five earlier mails from the same sender.');
  await expect(dialog.getByRole('region', { name: 'Models' })).toContainText('local-clef (decision model, runs on this install)');
  await expect(dialog.getByLabel(/Archive low-priority mail/)).not.toBeChecked();
  expect(calls.run).toBeUndefined();
  await dialog.getByLabel('Your instructions').fill('My accountant is high');
  await dialog.getByRole('button', { name: 'Triage 2 mails' }).click();
  await expect.poll(() => calls.settings).toMatchObject({ scope: 'untriaged', autoArchive: false, instructions: 'My accountant is high' });
  // Only the mails in scope are sent: the one the owner labelled is not.
  await expect.poll(() => (calls.run as { items: Array<{ id: string }> })?.items.map(it => it.id)).toEqual(['a', 'b']);
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await expect(dialog.getByText('1 of 2 mails.', { exact: false })).toBeVisible();
  // The result: counts, who answered, and a proposal instead of a silent archive.
  await expect(dialog.getByText('2 mails triaged.')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('1 decision model · 1 LLM')).toBeVisible();
  await expect(dialog.getByText('1 low-priority mail looks safe to archive')).toBeVisible();
  expect(box.batches).toEqual([]);
  await dialog.getByRole('button', { name: 'Archive 1' }).click();
  await expect.poll(() => box.batches).toEqual([{ ids: ['b'], action: 'archive', provider: 'google' }]);
  await dialog.getByRole('button', { name: 'Done' }).click();
  const list = page.getByRole('region', { name: 'Messages' });
  await expect(list.getByText('Big sale')).toHaveCount(0);
  await expect(list.getByText('high', { exact: true })).toBeVisible();
});

test('Email switches between a Google mailbox and separate IMAP inboxes without mixing messages', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const account = (id: string, label: string): MailAccountView => ({
    id, workspaceId: null, label, address: `${id}@example.com`, displayName: null, protocol: 'imap',
    incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: `${id}@example.com` },
    outgoing: null, folder: 'INBOX', enabled: true, fileAttachments: false, defaultProtectionLevel: null,
    passwordSet: { incoming: true, outgoing: false }, lastSyncAt: null, lastError: null, createdAt: now,
  });
  const message = (id: string, accountId: string): MailMessageView => ({ id, accountId, revision: 'a'.repeat(64), status: 'received', from: { address: 'sender@example.com' }, to: [{ address: `${accountId}@example.com` }], cc: [], subject: `Mail for ${accountId}`, snippet: 'Hello', date: now, unread: true, hasAttachments: false, protectionLevel: 2, messageIdHeader: null, inReplyTo: null, text: 'Safe plain text <script>malicious()</script>', html: '<p>Hello from a2</p><script>parent.document.body.dataset.pwned = "1"</script>', attachments: [], rawKept: false, error: null });
  await stubMailbox(page, [row('g1', { subject: 'Google message' })]);
  await page.route('**/api/mail/accounts', route => json(route, 200, [account('a1', 'Work'), account('a2', 'Personal')]));
  // IMAP mailboxes are read through the client routes, in the same shapes as Google mail.
  const imapRow = (m: MailMessageView): InboxItem => ({ id: m.id, provider: 'imap', mailbox: `imap:${m.accountId}`, status: m.status, from: { email: m.from!.address }, to: m.to.map(a => ({ email: a.address })), subject: m.subject, snippet: m.snippet, receivedAt: m.date, unread: m.unread, hasAttachments: m.hasAttachments });
  await page.route('**/api/mail/client/messages?**', route => { const id = new URL(route.request().url()).searchParams.get('account')!; return json(route, 200, { provider: null, mailbox: `imap:${id}`, items: [imapRow(message(`m-${id}`, id))] }); });
  await page.route('**/api/mail/client/messages/m-a2', route => { const m = message('m-a2', 'a2'); return json(route, 200, { ...imapRow(m), cc: [], body: m.text, html: m.html, attachments: [] }); });
  await page.route('**/api/mail/client/messages/batch', route => json(route, 200, { done: route.request().postDataJSON().ids, failed: [] }));
  await page.goto('/email');
  await expect(page.getByText('Google message')).toBeVisible();
  const mailbox = page.getByRole('combobox', { name: 'Mailbox', exact: true });
  await expect(mailbox.getByRole('option', { name: 'Gmail — me@example.com' })).toBeAttached();
  await mailbox.selectOption('a1');
  await expect(page.getByRole('button', { name: /Mail for a1/ })).toBeVisible();
  await expect(page.getByText('Google message')).toHaveCount(0);
  await mailbox.selectOption('a2');
  await expect(page.getByRole('button', { name: /Mail for a2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Mail for a1/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Mail for a2/ }).click();
  // The mail's HTML is drawn in a frame that can run no script; nothing of it lands in the page itself.
  const frame = page.locator('iframe[title="Message from sender@example.com"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  await expect(page.frameLocator('iframe[title="Message from sender@example.com"]').getByText('Hello from a2')).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
  await mailbox.selectOption('google');
  await expect(page.getByText('Google message')).toBeVisible();
});

test('with no mailbox connected the page says where to connect one', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await stubMailbox(page, [], []);
  await page.goto('/email');
  await expect(page.getByText('No mailbox connected.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings → Integrations' })).toBeVisible();
});

test('All inboxes merges Gmail and Outlook by date and acts on each message in its own mailbox', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const box = await stubMailbox(page, [], [{ provider: 'google', address: 'me@gmail.example' }, { provider: 'microsoft', address: 'me@outlook.example' }]);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await page.route('**/api/email/messages?**', route => {
    const url = new URL(route.request().url());
    box.lists.push(url);
    const provider = url.searchParams.get('provider');
    return json(route, 200, provider === 'google'
      ? { provider, unreadCount: 1, items: [row('g-new', { subject: 'Newest, Gmail', receivedAt: at(1) }), row('g-old', { subject: 'Oldest, Gmail', receivedAt: at(30) })] }
      : { provider, unreadCount: 2, items: [row('o-mid', { provider: 'microsoft', subject: 'Middle, Outlook', receivedAt: at(10) })] });
  });
  await page.goto('/email');
  await expect(page.getByText('Newest, Gmail')).toBeVisible();
  await expect(page.getByText('Middle, Outlook')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('all');
  const rows = page.getByRole('region', { name: 'Messages' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Newest, Gmail');
  await expect(rows.nth(1)).toContainText('Middle, Outlook');
  await expect(rows.nth(1)).toContainText('Outlook');
  await expect(rows.nth(2)).toContainText('Oldest, Gmail');
  await expect(page.getByLabel('3 unread')).toBeVisible();
  // Triage covers every inbox of the view.
  await expect(page.getByRole('button', { name: 'Triage inbox' })).toBeVisible();
  await page.getByLabel('Select conversation: Newest, Gmail').check();
  await page.getByLabel('Select conversation: Middle, Outlook').check();
  await page.getByRole('region', { name: 'Messages' }).getByRole('button', { name: 'Archive' }).click();
  await expect.poll(() => box.batches).toEqual([{ ids: ['g-new'], action: 'archive', provider: 'google' }, { ids: ['o-mid'], action: 'archive', provider: 'microsoft' }]);
  // A new message asks which mailbox sends it.
  await page.getByRole('button', { name: 'Compose' }).click();
  await expect(page.getByRole('form', { name: 'New message' }).getByLabel('From')).toHaveValue('google');
});

test('mailbox settings say what the local index keeps, and turning it off deletes it', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await stubMailbox(page, [row('a')]);
  const puts: unknown[] = [];
  let enabled = true;
  await page.route('**/api/email/index', route => {
    if (route.request().method() === 'PUT') { puts.push(route.request().postDataJSON()); enabled = route.request().postDataJSON().enabled; }
    return json(route, 200, enabled
      ? { enabled, mailboxes: [{ provider: 'google', status: 'ready', messages: 1234, coveredFrom: now, lastSyncAt: now, lastError: null }] }
      : { enabled, mailboxes: [] });
  });
  await page.goto('/email');
  await page.getByRole('button', { name: 'Manage mailboxes' }).click();
  const setting = page.getByRole('region', { name: 'Local mail index' });
  await expect(setting).toContainText('Never the body or attachments');
  await expect(setting).toContainText('Gmail: up to date · 1234 messages');
  const box = setting.getByLabel(/Keep a local index/);
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => puts).toEqual([{ enabled: false }]);
  await expect(box).not.toBeChecked();
  await expect(setting).not.toContainText('1234 messages');
});

test('All inboxes keeps one date order when a busy mailbox loads more than a quiet one', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await stubMailbox(page, [], [{ provider: 'google', address: 'me@gmail.example' }, { provider: 'microsoft', address: 'me@outlook.example' }]);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await page.route('**/api/email/messages?**', route => {
    const url = new URL(route.request().url());
    const provider = url.searchParams.get('provider');
    if (provider === 'microsoft') return json(route, 200, { provider, items: [row('quiet', { provider: 'microsoft', subject: 'Quiet, a day old', receivedAt: at(24 * 60) })] });
    // The busy mailbox: three recent mails a page, two pages.
    return url.searchParams.get('pageToken') === 'p2'
      ? json(route, 200, { provider, items: [4, 5, 6].map((n) => row(`busy-${n}`, { subject: `Busy ${n}`, receivedAt: at(n * 10) })) })
      : json(route, 200, { provider, nextPageToken: 'p2', items: [1, 2, 3].map((n) => row(`busy-${n}`, { subject: `Busy ${n}`, receivedAt: at(n * 10) })) });
  });
  await page.goto('/email');
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('all');
  const rows = page.getByRole('region', { name: 'Messages' }).getByRole('listitem');
  // The day-old mail waits: the busy mailbox has newer mail still to load.
  await expect(rows).toHaveCount(3);
  await expect(page.getByText('Quiet, a day old')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(7);
  await expect(rows).toHaveText([/Busy 1/, /Busy 2/, /Busy 3/, /Busy 4/, /Busy 5/, /Busy 6/, /Quiet, a day old/]);
});
