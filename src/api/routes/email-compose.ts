import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { MailboxError, resolveProvider } from '@/core/email/mailbox';
import { dropUploads, holdUpload } from '@/core/email/outgoing';
import { EmailInputError } from '@/core/email/send-mime';
import { listSnoozed, SnoozeInputError, snooze, unsnooze } from '@/core/email/snooze';
import { markEmailHandled } from '@/core/email/watch';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };
const PROVIDER = t.Optional(t.Union([t.Literal('google'), t.Literal('microsoft')]));

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
  .post('/uploads', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const file = body.file;
      return holdUpload(user.id, { name: file.name || 'attachment', contentType: file.type, content: new Uint8Array(await file.arrayBuffer()) });
    } catch (err) { return failure(err, set); }
  }, { body: t.Object({ file: t.File() }), detail: { tags: ['email'] } })

  // Let go of a held file (the writer removed it).
  .delete('/uploads/:id', ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    dropUploads(user.id, [params.id]);
    return { removed: true };
  }, { params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }), detail: { tags: ['email'] } })

  // Snooze a conversation: archived now, back in the inbox (unread) at `wakeAt`.
  .post('/snooze', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = await resolveProvider(user.id, body.provider);
      if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
      const snoozed = await snooze(user.id, provider, body);
      // The owner dealt with it for now: the heartbeat's inbox watch leaves it alone.
      for (const messageId of body.ids) {
        markEmailHandled({ userId: user.id, provider, messageId, outcome: 'other', note: 'Snoozed in the inbox page' })
          .catch((err: unknown) => apiLogger.warn({ err, userId: user.id }, 'email: could not record a handled message'));
      }
      return { snoozed };
    } catch (err) { return failure(err, set); }
  }, {
    body: t.Object({
      ids: t.Array(t.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 100 }),
      wakeAt: t.String({ minLength: 1, maxLength: 40 }),
      provider: PROVIDER,
      threadId: t.Optional(t.String({ maxLength: 1024 })),
      from: t.Object({ email: t.String({ maxLength: 320 }), name: t.Optional(t.String({ maxLength: 320 })) }),
      subject: t.String({ maxLength: 2000 }),
      snippet: t.String({ maxLength: 2000 }),
    }),
    detail: { tags: ['email'] },
  })

  // The snoozed conversations, soonest first; a wake that failed says why.
  .get('/snoozed', async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      const provider = query.provider ? await resolveProvider(user.id, query.provider) : undefined;
      return { snoozed: await listSnoozed(user.id, provider ?? undefined) };
    } catch (err) { return failure(err, set); }
  }, { query: t.Object({ provider: PROVIDER }), detail: { tags: ['email'] } })

  // Bring a snoozed conversation back now.
  .post('/snoozed/:id/unsnooze', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      if (!(await unsnooze(user.id, params.id))) { set.status = 404; return { error: 'Not snoozed' }; }
      return { unsnoozed: true };
    } catch (err) { return failure(err, set); }
  }, { params: t.Object({ id: t.String({ format: 'uuid' }) }), detail: { tags: ['email'] } });
