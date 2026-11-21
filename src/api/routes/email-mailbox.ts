import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { withMailboxAccount } from '@/core/email/account-context';
import {
  accountOfRequest,
  batchAction,
  getAttachment,
  getThread,
  isEmailFolder,
  listAccounts,
  listMessages,
  MailboxError,
  resolveProvider,
} from '@/core/email/mailbox';
import { storedTriage } from '@/core/email/triage-labels';
import { type EmailOutcome, markEmailHandled } from '@/core/email/watch';
import { isAuthenticated } from '@/security/principal';
import { EMAIL_BATCH_ACTIONS } from '@/shared/email';
import type { EmailBatchResponse, EmailListResponse, EmailProvider, EmailThreadResponse } from '@/shared/email';
import { apiLogger } from '@/utils/logger';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };
const PROVIDER = t.Optional(t.Union([t.Literal('google'), t.Literal('microsoft')]));
/** Which account of `provider` (its address), when the user connected several. Absent: the default account. */
const ACCOUNT = t.Optional(t.String({ maxLength: 320 }));
/** Provider ids are opaque; they are only ever used as one encoded path segment. */
const ID = t.String({ minLength: 1, maxLength: 1024 });

/** What to answer for an error: a MailboxError carries its status; anything else is a provider failure. */
function failure(err: unknown, set: { status?: number | string }): { error: string } {
  set.status = err instanceof MailboxError ? err.status : 400;
  return { error: (err as Error).message };
}

/** Content types a browser would render or run are served as plain bytes (the posture of routes/mail.ts). */
function downloadType(contentType: string): string {
  const type = contentType.toLowerCase().split(';')[0].trim();
  return /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript)/.test(type) || !/^[\w.+-]+\/[\w.+-]+$/.test(type)
    ? 'application/octet-stream'
    : type;
}

/** The owner dealt with these messages here: the inbox watch must not hand them to the heartbeat as new. Best-effort. */
function handledByOwner(userId: string, provider: EmailProvider, ids: string[], outcome: EmailOutcome, note: string): void {
  for (const messageId of ids) {
    markEmailHandled({ userId, provider, messageId, outcome, note })
      .catch((err: unknown) => apiLogger.warn({ err, userId }, 'email: could not record a handled message'));
  }
}

/**
 * The mailbox as a mail client reads it (docs/plans/email-calendar-ux.md):
 * folders, search, conversations, attachments and actions on several
 * messages. Same scope as routes/email.ts: the calling user's own Google or
 * Microsoft 365 token. `provider` picks the mailbox when both are connected.
 */
export const emailMailboxRoutes = new Elysia({ prefix: '/email' })
  .use(apiContext)

  // Which mailboxes are connected.
  .get('/accounts', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try { return await listAccounts(user.id); } catch (err) { return failure(err, set); }
  }, { detail: { tags: ['email'] } })

  // One page of a folder, newest first, with the stored triage of each mail.
  .get('/messages', withMailboxAccount(async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const folder = query.folder ?? 'inbox';
      if (!isEmailFolder(folder)) { set.status = 400; return { error: `Unknown folder: ${folder.slice(0, 40)}` }; }
      const provider = await resolveProvider(user.id, query.provider);
      if (!provider) return { provider: null, items: [] } satisfies EmailListResponse;
      const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 50);
      const list = await listMessages(user.id, provider, {
        folder, limit, q: query.q || undefined, unread: query.unread === 'true', pageToken: query.pageToken || undefined,
      }, query.refresh === 'true');
      if (list.items.length === 0) return list;
      // Named in each row, so a merged list sends every action to the account the mail is in.
      // Read on every request, not remembered with the page: a triage run or the owner's label shows at once. Never blocks the list.
      const triage = await storedTriage(user.id, provider, list.items.map((it) => it.id)).catch((err: unknown) => {
        apiLogger.warn({ error: String((err as Error)?.message ?? err).slice(0, 200), userId: user.id }, 'email: could not read stored triage');
        return {} as Awaited<ReturnType<typeof storedTriage>>;
      });
      const account = accountOfRequest(provider);
      return { ...list, items: list.items.map((it) => ({ ...it, ...account, ...(triage[it.id] ? { triage: triage[it.id] } : {}) })) } satisfies EmailListResponse;
    } catch (err) { return failure(err, set); }
  }), {
    query: t.Object({
      folder: t.Optional(t.String({ maxLength: 20 })),
      q: t.Optional(t.String({ maxLength: 300 })),
      unread: t.Optional(t.String({ maxLength: 5 })),
      pageToken: t.Optional(t.String({ maxLength: 2100 })),
      limit: t.Optional(t.String({ maxLength: 3 })),
      provider: PROVIDER,
      account: ACCOUNT,
      // `true` skips the 30-second memory of the page (the Refresh button).
      refresh: t.Optional(t.String({ maxLength: 5 })),
    }),
    detail: { tags: ['email'] },
  })

  // Every message of a conversation, oldest first.
  .get('/thread/:threadId', withMailboxAccount(async ({ user, principal, params, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = await resolveProvider(user.id, query.provider);
      if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
      const account = accountOfRequest(provider);
      return { messages: (await getThread(user.id, provider, params.threadId)).map((m) => ({ ...m, ...account })) } satisfies EmailThreadResponse;
    } catch (err) { return failure(err, set); }
  }), { params: t.Object({ threadId: ID }), query: t.Object({ provider: PROVIDER, account: ACCOUNT }), detail: { tags: ['email'] } })

  // One attachment, always as a download: never rendered in the app's origin.
  .get('/message/:id/attachment/:attachmentId', withMailboxAccount(async ({ user, principal, params, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = await resolveProvider(user.id, query.provider);
      if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
      const file = await getAttachment(user.id, provider, params.id, params.attachmentId);
      // A name from the mail is untrusted: no path, no control characters, percent-encoded in the header.
      const name = file.name.replace(/[\\/\u0000-\u001f\u007f]+/g, '_').slice(0, 200) || 'attachment';
      const encoded = encodeURIComponent(name);
      set.headers['Content-Type'] = downloadType(file.contentType);
      set.headers['Content-Disposition'] = `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
      set.headers['X-Content-Type-Options'] = 'nosniff';
      set.headers['Cache-Control'] = 'private, max-age=60';
      return new Response(new Uint8Array(file.content));
    } catch (err) { return failure(err, set); }
  }), { params: t.Object({ id: ID, attachmentId: ID }), query: t.Object({ provider: PROVIDER, account: ACCOUNT }), detail: { tags: ['email'] } })

  // One action on several messages. Nothing is deleted for good: `trash` moves to the trash.
  .post('/messages/batch', withMailboxAccount(async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = await resolveProvider(user.id, body.provider);
      if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
      const result: EmailBatchResponse = await batchAction(user.id, provider, body.ids, body.action);
      if (body.action === 'archive') handledByOwner(user.id, provider, result.done, 'archived', 'Archived in the inbox page');
      if (body.action === 'trash') handledByOwner(user.id, provider, result.done, 'other', 'Moved to the trash in the inbox page');
      return result;
    } catch (err) { return failure(err, set); }
  }), {
    body: t.Object({
      ids: t.Array(ID, { minItems: 1, maxItems: 100 }),
      action: t.Union(EMAIL_BATCH_ACTIONS.map((a) => t.Literal(a))),
      provider: PROVIDER,
      account: ACCOUNT,
    }),
    detail: { tags: ['email'] },
  });
