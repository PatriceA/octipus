import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import {
  accountViews,
  createMailAccount,
  deleteMailAccount,
  MailHostError,
  MailInputError,
  messageSummary,
  messageView,
  testMailAccount,
  updateMailAccount,
} from '@/core/mail/accounts';
import { cleanBody, cleanSubject, parseRecipients, replyDraft } from '@/core/mail/drafts';
import { attachmentsOf } from '@/core/mail/parse';
import { MailSendError, sendDraft } from '@/core/mail/send';
import { syncAccount } from '@/core/mail/sync';
import { contentRepos } from '@/db/repositories/content';
import { isAuthenticated } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { MAIL_PROTOCOLS, MAIL_SECURITY, MAIL_STATUSES } from '@/shared/mail';
import { apiLogger } from '@/utils/logger';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };

const SERVER = t.Object({
  host: t.String({ minLength: 1, maxLength: 253 }),
  port: t.Integer({ minimum: 1, maximum: 65535 }),
  security: t.Union(MAIL_SECURITY.map((s) => t.Literal(s))),
  username: t.Optional(t.String({ maxLength: 320 })),
});
const PASSWORDS = t.Object({
  incoming: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
  outgoing: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
});
const ACCOUNT_FIELDS = {
  label: t.Optional(t.String({ maxLength: 100 })),
  displayName: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
  protocol: t.Optional(t.Union(MAIL_PROTOCOLS.map((p) => t.Literal(p)))),
  outgoing: t.Optional(t.Union([SERVER, t.Null()])),
  folder: t.Optional(t.String({ maxLength: 200 })),
  enabled: t.Optional(t.Boolean()),
  passwords: t.Optional(PASSWORDS),
};
const RECIPIENTS = t.Union([t.String({ maxLength: 20_000 }), t.Array(t.String({ maxLength: 400 }), { maxItems: 100 })]);
const ID = t.Object({ id: t.String({ maxLength: 64 }) });

/** A refused change: a role refusal keeps its status through the error handler; anything else a fitting status. */
function refused(err: unknown, set: { status?: number | string }): { error: string } {
  if (err instanceof SpaceError) throw err;
  if (err instanceof MailInputError || err instanceof MailHostError) {
    set.status = 400;
    return { error: err.message };
  }
  if (err instanceof MailSendError) {
    set.status = err.code === 'not_found' ? 404 : err.code === 'invalid' ? 400 : 502;
    return { error: err.message };
  }
  apiLogger.error({ err }, 'mail: request failed');
  set.status = 500;
  return { error: 'The mail request failed' };
}

/** Passwords: an empty string means "not given", null removes. */
function passwordsOf(input: { incoming?: string | null; outgoing?: string | null } | undefined) {
  const pick = (v: string | null | undefined) => (v === undefined || v === '' ? undefined : v);
  return { incoming: pick(input?.incoming), outgoing: pick(input?.outgoing) };
}

/** Content types a browser could run as a page are downloaded as plain bytes. */
function downloadType(contentType: string): string {
  const type = contentType.toLowerCase().split(';')[0].trim();
  return /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript)/.test(type) || !/^[\w.+-]+\/[\w.+-]+$/.test(type)
    ? 'application/octet-stream'
    : type;
}

/**
 * Mail accounts and messages (docs/MAIL.md). Every read and write goes
 * through `contentRepos(principal)`: personally the caller's own mailboxes,
 * in a space its functional mailboxes (members read, editors write and send,
 * owners set them up). An id the scope does not reach is a 404.
 */
export const mailRoutes = new Elysia({ prefix: '/mail' })
  .use(apiContext)

  // ── Accounts ──────────────────────────────────────────────────────

  .get('/accounts', async ({ principal, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    return accountViews(await contentRepos(principal).mail.accounts());
  }, { detail: { tags: ['mail'] } })

  .post('/accounts', async ({ principal, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const { passwords, ...input } = body;
      const account = await createMailAccount(contentRepos(principal), input, passwordsOf(passwords));
      set.status = 201;
      return (await accountViews([account]))[0];
    } catch (err) {
      return refused(err, set);
    }
  }, {
    body: t.Object({ address: t.String({ maxLength: 320 }), incoming: SERVER, ...ACCOUNT_FIELDS }),
    detail: { tags: ['mail'] },
  })

  .patch('/accounts/:id', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const { passwords, ...input } = body;
      const account = await updateMailAccount(contentRepos(principal), params.id, input, passwordsOf(passwords));
      if (!account) { set.status = 404; return { error: 'Mail account not found' }; }
      return (await accountViews([account]))[0];
    } catch (err) {
      return refused(err, set);
    }
  }, {
    params: ID,
    body: t.Object({ address: t.Optional(t.String({ maxLength: 320 })), incoming: t.Optional(SERVER), ...ACCOUNT_FIELDS }),
    detail: { tags: ['mail'] },
  })

  .delete('/accounts/:id', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      if (!(await deleteMailAccount(contentRepos(principal), params.id))) { set.status = 404; return { error: 'Mail account not found' }; }
      return { deleted: true };
    } catch (err) {
      return refused(err, set);
    }
  }, { params: ID, detail: { tags: ['mail'] } })

  // Log in with the stored passwords: what failed, per server.
  .post('/accounts/:id/test', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const repos = contentRepos(principal);
    const account = await repos.mail.account(params.id);
    if (!account) { set.status = 404; return { error: 'Mail account not found' }; }
    // A login attempt with the stored passwords is a setup step: owners only in a space.
    repos.mail.assertManage();
    return testMailAccount(account);
  }, { params: ID, detail: { tags: ['mail'] } })

  // Fetch new mail now instead of at the next sync.
  .post('/accounts/:id/sync', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const repos = contentRepos(principal);
    repos.can('write');
    const account = await repos.mail.account(params.id);
    if (!account) { set.status = 404; return { error: 'Mail account not found' }; }
    return syncAccount(account);
  }, { params: ID, detail: { tags: ['mail'] } })

  // ── Messages ──────────────────────────────────────────────────────

  .get('/messages', async ({ principal, query, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const before = query.before && query.beforeId ? { date: new Date(query.before), id: query.beforeId } : undefined;
    if (before && !Number.isFinite(before.date.getTime())) { set.status = 400; return { error: 'before is not a date' }; }
    const rows = await contentRepos(principal).mail.list({
      accountId: query.account,
      status: query.status,
      unread: query.unread === 'true',
      q: query.q,
      before,
      limit: query.limit ? Number.parseInt(query.limit, 10) || 50 : 50,
    });
    return rows.map(messageSummary);
  }, {
    query: t.Object({
      account: t.Optional(t.String({ maxLength: 64 })),
      status: t.Optional(t.Union(MAIL_STATUSES.map((s) => t.Literal(s)))),
      unread: t.Optional(t.String({ maxLength: 5 })),
      q: t.Optional(t.String({ maxLength: 200 })),
      before: t.Optional(t.String({ maxLength: 40 })),
      beforeId: t.Optional(t.String({ maxLength: 64 })),
      limit: t.Optional(t.String({ maxLength: 4 })),
    }),
    detail: { tags: ['mail'] },
  })

  .get('/messages/:id', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const repo = contentRepos(principal).mail;
    const row = await repo.message(params.id);
    if (!row) { set.status = 404; return { error: 'Message not found' }; }
    const raw = row.attachments.length > 0 ? await repo.raw(row.id) : null;
    return messageView(row, raw !== null);
  }, { params: ID, detail: { tags: ['mail'] } })

  .patch('/messages/:id', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const row = await contentRepos(principal).mail.setUnread(params.id, body.unread);
    if (!row) { set.status = 404; return { error: 'Message not found' }; }
    return messageSummary(row);
  }, { params: ID, body: t.Object({ unread: t.Boolean() }), detail: { tags: ['mail'] } })

  // One attachment of a received message, always as a download.
  .get('/messages/:id/attachments/:index', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const raw = await contentRepos(principal).mail.raw(params.id);
    if (!raw) { set.status = 404; return { error: 'Attachment not found' }; }
    const attachment = (await attachmentsOf(raw))[Number(params.index)];
    if (!attachment) { set.status = 404; return { error: 'Attachment not found' }; }
    const encoded = encodeURIComponent(attachment.filename);
    set.headers['Content-Type'] = downloadType(attachment.contentType);
    set.headers['Content-Disposition'] = `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['Cache-Control'] = 'private, max-age=60';
    return new Response(new Uint8Array(attachment.content));
  }, {
    params: t.Object({ id: t.String({ maxLength: 64 }), index: t.String({ pattern: '^[0-9]{1,4}$' }) }),
    detail: { tags: ['mail'] },
  })

  // ── Drafts ────────────────────────────────────────────────────────

  // A new draft, or with `replyTo` a reply to a received message.
  .post('/drafts', async ({ principal, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const repo = contentRepos(principal).mail;
      if (body.replyTo) {
        const original = await repo.message(body.replyTo);
        if (!original || original.status !== 'received') { set.status = 404; return { error: 'Message not found' }; }
        const account = await repo.account(original.accountId);
        if (!account) { set.status = 404; return { error: 'Mail account not found' }; }
        const draft = await repo.createDraft(account, replyDraft(account, original, body.body ?? '', body.all === true));
        set.status = 201;
        return messageView(draft, false);
      }
      const account = body.accountId ? await repo.account(body.accountId) : null;
      if (!account) { set.status = 404; return { error: 'Mail account not found' }; }
      const draft = await repo.createDraft(account, {
        toAddresses: parseRecipients(body.to ?? []),
        ccAddresses: parseRecipients(body.cc ?? []),
        subject: cleanSubject(body.subject),
        bodyText: cleanBody(body.body),
        inReplyTo: null,
        references: null,
      });
      set.status = 201;
      return messageView(draft, false);
    } catch (err) {
      return refused(err, set);
    }
  }, {
    body: t.Object({
      accountId: t.Optional(t.String({ maxLength: 64 })),
      replyTo: t.Optional(t.String({ maxLength: 64 })),
      all: t.Optional(t.Boolean()),
      to: t.Optional(RECIPIENTS),
      cc: t.Optional(RECIPIENTS),
      subject: t.Optional(t.String({ maxLength: 500 })),
      body: t.Optional(t.String({ maxLength: 100_000 })),
    }),
    detail: { tags: ['mail'] },
  })

  .patch('/drafts/:id', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const row = await contentRepos(principal).mail.updateDraft(params.id, {
        ...(body.to !== undefined ? { toAddresses: parseRecipients(body.to) } : {}),
        ...(body.cc !== undefined ? { ccAddresses: parseRecipients(body.cc) } : {}),
        ...(body.subject !== undefined ? { subject: cleanSubject(body.subject) } : {}),
        ...(body.body !== undefined ? { bodyText: cleanBody(body.body) } : {}),
      });
      if (!row) { set.status = 404; return { error: 'Draft not found' }; }
      return messageView(row, false);
    } catch (err) {
      return refused(err, set);
    }
  }, {
    params: ID,
    body: t.Object({
      to: t.Optional(RECIPIENTS),
      cc: t.Optional(RECIPIENTS),
      subject: t.Optional(t.String({ maxLength: 500 })),
      body: t.Optional(t.String({ maxLength: 100_000 })),
    }),
    detail: { tags: ['mail'] },
  })

  .delete('/drafts/:id', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    if (!(await contentRepos(principal).mail.deleteDraft(params.id))) { set.status = 404; return { error: 'Draft not found' }; }
    return { deleted: true };
  }, { params: ID, detail: { tags: ['mail'] } })

  // Send a draft. Never implicit: `confirm: true` is required.
  .post('/drafts/:id/send', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    if (body.confirm !== true) { set.status = 400; return { error: 'Sending needs confirm: true' }; }
    try {
      const repo = contentRepos(principal).mail;
      const sent = await sendDraft(repo, params.id);
      const row = await repo.message(sent.id);
      return row ? messageView(row, false) : { id: sent.id, status: 'sent' };
    } catch (err) {
      return refused(err, set);
    }
  }, { params: ID, body: t.Object({ confirm: t.Boolean() }), detail: { tags: ['mail'] } });
