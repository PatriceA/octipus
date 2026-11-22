import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { withMailboxAccount } from '@/core/email/account-context';
import { MailboxError, resolveProvider } from '@/core/email/mailbox';
import { dropUploads, holdUpload } from '@/core/email/outgoing';
import { MAX_ATTACHMENT_BYTES } from '@/core/email/send-mime';

/** The request body, or null as soon as it passes `max` bytes (nothing more is read). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** One file plus the multipart framing around it. */
const UPLOAD_BODY_MAX = MAX_ATTACHMENT_BYTES + 64 * 1024;
import { EmailInputError } from '@/core/email/send-mime';
import { dismissSnooze, listSnoozed, SnoozeInputError, SnoozePartialError, type SnoozeView, snooze, unsnooze } from '@/core/email/snooze';
import { markEmailHandled } from '@/core/email/watch';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };
const PROVIDER = t.Optional(t.Union([t.Literal('google'), t.Literal('microsoft')]));
/** Which connected account of the provider; the default one otherwise (core/email/account-context.ts). */
const ACCOUNT = t.Optional(t.String({ maxLength: 320 }));

function failure(err: unknown, set: { status?: number | string }): { error: string } {
  set.status = err instanceof MailboxError ? err.status : err instanceof EmailInputError || err instanceof SnoozeInputError ? 400 : 502;
  return { error: (err as Error).message };
}

/**
 * Writing and snoozing on the Email page (docs/plans/email-calendar-ux.md):
 * files held for a mail about to be sent (core/email/outgoing.ts), and
 * conversations taken out of the inbox until later (core/email/snooze.ts).
 * The calling user's own mailbox only, like routes/email.ts.
 */
export const emailComposeRoutes = new Elysia({ prefix: '/email' })
  .use(apiContext)

  // Hold one file for a mail being written. Nothing is sent: the send names it.
  // The route reads the body itself, with a cap: a declared length over the
  // limit is refused at once, an undeclared one stops at the limit. (The
  // framework's own body parse, src/api/http/app.ts, runs before routing.)
  .post('/uploads', async ({ user, principal, request, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const tooLarge = { error: `A file may be at most ${MAX_ATTACHMENT_BYTES / 1048576} MB.` };
    // A declared length over the limit is refused unread; an undeclared one is read only up to the limit.
    if (Number(request.headers.get('content-length')) > UPLOAD_BODY_MAX) { set.status = 413; return tooLarge; }
    try {
      const bytes = await readCapped(request, UPLOAD_BODY_MAX);
      if (!bytes) { set.status = 413; return tooLarge; }
      const file = (await new Response(bytes as unknown as BodyInit, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData()).get('file');
      if (!(file instanceof File)) { set.status = 400; return { error: 'Send the file as the form field "file".' }; }
      if (file.size > MAX_ATTACHMENT_BYTES) { set.status = 413; return { error: `A file may be at most ${MAX_ATTACHMENT_BYTES / 1048576} MB.` }; }
      return holdUpload(user.id, { name: file.name || 'attachment', contentType: file.type, content: new Uint8Array(await file.arrayBuffer()) });
    } catch (err) { return failure(err, set); }
  }, { parse: () => ({}), detail: { tags: ['email'] } })

  // Let go of a held file (the writer removed it).
  .delete('/uploads/:id', ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    dropUploads(user.id, [params.id]);
    return { removed: true };
  }, { params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }), detail: { tags: ['email'] } })

  // Snooze a conversation: archived now, back in the inbox (unread) at `wakeAt`.
  .post('/snooze', withMailboxAccount(async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = await resolveProvider(user.id, body.provider);
      if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
      let snoozed: SnoozeView;
      let warning: string | undefined;
      let handled = body.ids;
      try {
        snoozed = await snooze(user.id, provider, body);
      } catch (err) {
        // Some messages could not be moved: those stay in the inbox; the rest is snoozed.
        if (!(err instanceof SnoozePartialError)) throw err;
        snoozed = err.snoozed;
        handled = err.snoozedIds;
        warning = err.message;
      }
      // The owner dealt with what was snoozed, for now: the heartbeat's inbox
      // watch leaves it alone. What stayed in the inbox is still watched.
      for (const messageId of handled) {
        markEmailHandled({ userId: user.id, provider, messageId, outcome: 'other', note: 'Snoozed in the inbox page' })
          .catch((err: unknown) => apiLogger.warn({ err, userId: user.id }, 'email: could not record a handled message'));
      }
      return { snoozed, ...(warning ? { warning } : {}) };
    } catch (err) { return failure(err, set); }
  }), {
    body: t.Object({
      ids: t.Array(t.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 100 }),
      wakeAt: t.String({ minLength: 1, maxLength: 40 }),
      provider: PROVIDER,
      account: ACCOUNT,
      threadId: t.Optional(t.String({ maxLength: 1024 })),
      from: t.Object({ email: t.String({ maxLength: 320 }), name: t.Optional(t.String({ maxLength: 320 })) }),
      subject: t.String({ maxLength: 2000 }),
      snippet: t.String({ maxLength: 2000 }),
    }),
    detail: { tags: ['email'] },
  })

  // The snoozed conversations, soonest first; a wake that failed says why.
  .get('/snoozed', withMailboxAccount(async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = query.provider ? await resolveProvider(user.id, query.provider) : undefined;
      return { snoozed: await listSnoozed(user.id, provider ?? undefined) };
    } catch (err) { return failure(err, set); }
  }), { query: t.Object({ provider: PROVIDER, account: ACCOUNT }), detail: { tags: ['email'] } })

  // Bring a snoozed conversation back now.
  .post('/snoozed/:id/unsnooze', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      if (!(await unsnooze(user.id, params.id))) { set.status = 404; return { error: 'Not snoozed' }; }
      return { unsnoozed: true };
    } catch (err) { return failure(err, set); }
  }, { params: t.Object({ id: t.String({ format: 'uuid' }) }), detail: { tags: ['email'] } })

  // Let a snooze go: nothing is moved, the mail stays in the archive.
  .post('/snoozed/:id/dismiss', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      if (!(await dismissSnooze(user.id, params.id))) { set.status = 404; return { error: 'Not snoozed' }; }
      return { dismissed: true };
    } catch (err) { return failure(err, set); }
  }, { params: t.Object({ id: t.String({ format: 'uuid' }) }), detail: { tags: ['email'] } });
