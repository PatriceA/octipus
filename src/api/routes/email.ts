import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import {
  archiveMessage,
  detectProvider,
  draftReply,
  getInbox,
  getMessage,
  markRead,
  replyOptions,
  sendReply,
  summarizeMessage,
  triageInbox,
} from '@/core/email';
import { isAuthenticated } from '@/security/principal';

/**
 * Email triage-lite (feature #7). Read + assist over the connected mailbox,
 * scoped to the calling user's OAuth token. Send is ASK-gated: it requires an
 * explicit `confirm: true` and is never automatic. Archive is similarly explicit.
 */
export const emailRoutes = new Elysia({ prefix: '/email' })
  .use(apiContext)

  // Inbox list (read-only).
  .get(
    '/inbox',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), 50);
        return await getInbox(user.id, limit, query?.pageToken || undefined);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { query: t.Object({ limit: t.Optional(t.String()), pageToken: t.Optional(t.String()) }), detail: { tags: ['email'] } }
  )

  // Mark a message read (clears the unread flag in the provider).
  .post(
    '/message/:id/mark-read',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await markRead(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Propose reply directions for the user to choose BEFORE drafting.
  .post(
    '/message/:id/reply-options',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        return { options: await replyOptions(user.id, message) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Read a full message.
  .get(
    '/message/:id',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) {
          set.status = 400;
          return { error: 'No mailbox connected' };
        }
        return await getMessage(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Summarize a message.
  .post(
    '/message/:id/summarize',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        return { summary: await summarizeMessage(user.id, message) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Draft a reply (NOT sent — opens in the editable draft view).
  .post(
    '/message/:id/draft',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        return await draftReply(user.id, message, body?.instruction);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ instruction: t.Optional(t.String()) }), detail: { tags: ['email'] } }
  )

  // Archive a message (explicit).
  .post(
    '/message/:id/archive',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await archiveMessage(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Send a reply — ASK-gated. Requires confirm:true; never sends automatically.
  .post(
    '/send',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      // Strict identity check — defeats any truthy/coerced value; only a real
      // boolean true passes the gate. A draft is never sent without it.
      if (body.confirm !== true) {
        set.status = 409;
        return { error: 'Sending requires explicit confirmation', requiresConfirmation: true };
      }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await sendReply(user.id, provider, { to: body.to, subject: body.subject, body: body.body });
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        to: t.String({ minLength: 1, maxLength: 320 }),
        subject: t.String({ maxLength: 998 }),
        body: t.String({ minLength: 1, maxLength: 100_000 }),
        confirm: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['email'] },
    }
  )

  // Triage the inbox (opt-in — computes priorities via the model).
  .post(
    '/triage',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const { items } = await getInbox(user.id, 30);
        return { triage: await triageInbox(user.id, items) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { detail: { tags: ['email'] } }
  );
