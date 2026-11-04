import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { MailAccountView, MailMessageView } from '../../src/shared/mail';

const account = (id = 'a1', label = 'Work'): MailAccountView => ({
  id, workspaceId: null, label, address: `${id}@example.com`, displayName: null, protocol: 'imap',
  incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: `${id}@example.com` },
  outgoing: { host: 'smtp.example.com', port: 465, security: 'tls', username: `${id}@example.com` },
  folder: 'INBOX', enabled: true, fileAttachments: false, defaultProtectionLevel: null,
  passwordSet: { incoming: true, outgoing: true }, lastSyncAt: null, lastError: null, createdAt: new Date().toISOString(),
});
const message = (id = 'm1', accountId = 'a1'): MailMessageView => ({ id, accountId, revision: 'a'.repeat(64), status: 'received', from: { address: 'sender@example.com' }, to: [{ address: `${accountId}@example.com` }], cc: [], subject: `Mail for ${accountId}`, snippet: 'Hello', date: new Date().toISOString(), unread: true, hasAttachments: false, protectionLevel: 2, messageIdHeader: null, inReplyTo: null, text: 'Safe plain text <script>malicious()</script>', html: '<script>malicious()</script>', attachments: [], rawKept: false, error: null });

test('mailboxes can be added with SMTP, edited without resending credentials, tested and removed', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  let accounts: MailAccountView[] = [];
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  let removes = 0;
  await page.route('**/api/mail/accounts', route => {
    if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); writes.push({ method: 'POST', body }); accounts = [{ ...account(), ...body, passwordSet: { incoming: true, outgoing: true } }]; return json(route, 201, accounts[0]); }
    return json(route, 200, accounts);
  });
  await page.route('**/api/mail/accounts/a1', route => {
    if (route.request().method() === 'DELETE') { removes++; accounts = []; return json(route, 200, { deleted: true }); }
    const body = route.request().postDataJSON(); writes.push({ method: 'PATCH', body }); accounts = [{ ...accounts[0], ...body }]; return json(route, 200, accounts[0]);
  });
  await page.route('**/api/mail/accounts/a1/test', route => json(route, 200, { incoming: null, outgoing: 'SMTP login refused' }));
  await page.goto('/settings?tab=mailboxes');
  await page.getByRole('button', { name: 'Add mailbox', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add mailbox' });
  await form.getByLabel('Email address', { exact: true }).fill('a1@example.com');
  await form.getByLabel('Mailbox label').fill('Work');
  await form.getByLabel('Incoming host').fill('imap.example.com');
  await form.getByLabel('Incoming password').fill('incoming-secret');
  await form.getByLabel('Enable SMTP sending').check();
  await form.getByLabel('Outgoing host').fill('smtp.example.com');
  await form.getByLabel('Outgoing password').fill('outgoing-secret');
  await form.getByRole('button', { name: 'Save mailbox' }).click();
  await expect(page.getByText('Mailbox saved.', { exact: false })).toBeVisible();
  expect(writes[0].body).toMatchObject({ address: 'a1@example.com', passwords: { incoming: 'incoming-secret', outgoing: 'outgoing-secret' } });
  await page.getByRole('button', { name: 'Edit Work', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit mailbox' });
  await expect(edit.getByLabel('Incoming password')).toHaveValue('');
  await edit.getByLabel('Mailbox label').fill('Office');
  await edit.getByRole('button', { name: 'Save mailbox' }).click();
  await expect(page.getByRole('button', { name: 'Edit Office', exact: true })).toBeVisible();
  expect(writes[1].body).toEqual({ label: 'Office', passwords: {} });
  await page.getByRole('button', { name: 'Test login', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('SMTP login refused');
  await page.getByRole('button', { name: 'Remove Office', exact: true }).click();
  expect(removes).toBe(0);
  await page.getByRole('button', { name: 'Confirm removal' }).click();
  await expect.poll(() => removes).toBe(1);
  await expect(page.getByText('No IMAP or POP3 mailboxes connected yet.')).toBeVisible();
});

test('Email switches between OAuth and separate protocol inboxes without mixing messages', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/mail/accounts', route => json(route, 200, [account(), account('a2', 'Personal')]));
  await page.route('**/api/email/inbox', route => json(route, 200, { provider: 'google', items: [{ id: 'google1', provider: 'google', from: { email: 'friend@example.com' }, subject: 'Google message', snippet: '', receivedAt: new Date().toISOString(), unread: false }] }));
  await page.route('**/api/mail/messages?**', route => { const id = new URL(route.request().url()).searchParams.get('account')!; return json(route, 200, [message(`m-${id}`, id)]); });
  await page.route('**/api/mail/messages/m-a2', route => json(route, 200, message('m-a2', 'a2')));
  await page.goto('/email');
  await expect(page.getByText('Google message')).toBeVisible();
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('a1');
  await expect(page.getByRole('button', { name: /Mail for a1/ })).toBeVisible();
  await expect(page.getByText('Google message')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('a2');
  await expect(page.getByRole('button', { name: /Mail for a2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Mail for a1/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Mail for a2/ }).click();
  await expect(page.getByText('Safe plain text <script>malicious()</script>', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Mailbox', exact: true }).selectOption('oauth');
  await expect(page.getByText('Google message')).toBeVisible();
});

test('drafts require saving edits and exact-content confirmation before sending', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/mail/accounts', route => json(route, 200, [account()]));
  await page.route('**/api/mail/messages?**', route => json(route, 200, []));
  let draft = { ...message('d1'), status: 'draft' as const, text: 'Hello', to: [{ address: 'recipient@example.com' }] };
  let sends = 0; const receipts: unknown[] = [];
  await page.route('**/api/mail/drafts', route => { const body = route.request().postDataJSON(); draft = { ...draft, subject: body.subject, text: body.body, to: [{ address: body.to }] }; return json(route, 201, draft); });
  await page.route('**/api/mail/drafts/d1', route => { const body = route.request().postDataJSON(); draft = { ...draft, subject: body.subject, text: body.body, revision: 'b'.repeat(64) }; return json(route, 200, draft); });
  await page.route('**/api/mail/drafts/d1/send', route => { sends++; receipts.push(route.request().postDataJSON()); return json(route, 200, { ...draft, status: 'sent' }); });
  await page.goto('/mail');
  await page.getByRole('button', { name: 'New message' }).click();
  const form = page.getByRole('form', { name: 'Mail draft' });
  await form.getByLabel('To', { exact: true }).fill('recipient@example.com');
  await form.getByLabel('Subject', { exact: true }).fill('First subject');
  await form.getByLabel('Message', { exact: true }).fill('Hello');
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(form.getByRole('button', { name: 'Review send' })).toBeEnabled();
  await form.getByLabel('Subject', { exact: true }).fill('Reviewed subject');
  await expect(form.getByRole('button', { name: 'Review send' })).toBeDisabled();
  expect(sends).toBe(0);
  await form.getByRole('button', { name: 'Save draft' }).click();
  await form.getByRole('button', { name: 'Review send' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Confirm email send' })).toContainText('Reviewed subject');
  expect(sends).toBe(0);
  await page.getByRole('button', { name: 'Confirm send', exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  expect(receipts).toEqual([{ confirm: true, expectedRevision: 'b'.repeat(64) }]);
});

test('calendar displays both providers, creates events and edits without replacing descriptions', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const today = new Date().toISOString().slice(0, 10);
  const event = { id: 'google-event', title: 'Planning', provider: 'google', start: `${today}T09:00:00Z`, end: `${today}T10:00:00Z`, allDay: false, description: 'Original full description', location: 'Office', attendees: [] };
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/calendar/events?**', route => json(route, 200, { providers: ['google', 'microsoft'], partial: false, events: [event, { ...event, id: 'ms-event', provider: 'microsoft', title: 'Outlook meeting' }] }));
  await page.route('**/api/calendar/events', route => { writes.push({ method: route.request().method(), body: route.request().postDataJSON() }); return json(route, 200, { success: true }); });
  await page.route('**/api/calendar/events/google-event', route => { writes.push({ method: 'PATCH', body: route.request().postDataJSON() }); return json(route, 200, { success: true }); });
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Outlook meeting' })).toBeVisible();
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const create = page.getByRole('form', { name: 'New calendar event' });
  await create.getByLabel('Title', { exact: true }).fill('New appointment');
  await expect(create.getByRole('button', { name: 'Save event' })).toBeDisabled();
  await create.getByLabel(/Confirm this change/).check();
  await create.getByRole('button', { name: 'Save event' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ method: 'POST', body: { title: 'New appointment', provider: 'google', confirm: true } });
  await page.getByRole('button', { name: 'Edit Planning', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit calendar event' });
  await edit.getByLabel('Title', { exact: true }).fill('Updated planning');
  await edit.getByLabel('All-day event').check();
  await expect(edit.getByLabel('End (exclusive)')).not.toHaveValue(today);
  await edit.getByLabel(/Confirm this change/).check();
  await edit.getByRole('button', { name: 'Save event' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ method: 'PATCH', body: { title: 'Updated planning', allDay: true, confirm: true } });
  expect(writes[1].body).not.toHaveProperty('description');
  expect(writes[1].body).not.toHaveProperty('attendees');
});

test('read-only shared mailbox users can read but cannot manage or send', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const id = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000001';
  await page.addInitScript(value => localStorage.setItem('octipus.activeWorkspace', value), id);
  const space = { id, name: 'Team', slug: 'team', role: 'viewer', archivedAt: null, memberCount: 2, createdBy: 'owner', createdAt: new Date().toISOString(), funding: 'own' };
  await page.route('**/api/spaces', route => json(route, 200, { spaces: [space] }));
  await page.route(`**/api/spaces/${id}`, route => json(route, 200, space));
  await page.route('**/api/mail/accounts', route => json(route, 200, [{ ...account(), workspaceId: id }]));
  await page.route('**/api/mail/messages?**', route => json(route, 200, [message()]));
  await page.goto('/mail');
  await expect(page.getByRole('button', { name: /Mail for a1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sync inbox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage mailboxes' }).click();
  await expect(page.getByRole('heading', { name: 'Mailboxes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add mailbox', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Work', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test login' })).toHaveCount(0);
});

test('calendar shows incomplete-provider and pagination warnings', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/calendar/events?**', route => json(route, 200, { events: [], providers: ['google'], partial: true, truncated: true }));
  await page.goto('/calendar');
  await expect(page.getByText('Some calendar data could not be loaded.', { exact: false })).toBeVisible();
  await expect(page.getByText('This range contains more events than could be loaded.', { exact: false })).toBeVisible();
});
