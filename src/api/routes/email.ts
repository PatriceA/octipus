import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import {
  applyCategoryLabels,
  archiveMessage,
  autoArchive,
  DEFAULT_CATEGORIES,
  getCategories,
  setCategories,
  validateCategories,
  unarchiveMessage,
  detectProvider,
  draftReply,
  getInbox,
  getMessage,
  markRead,
  replyOptions,
  sendReply,
  summarizeMessage,
  triageInbox,
  type InboxItem,
} from '@/core/email';
import { createTasksFromSource, emailToTask } from '@/core/tasks/sourced';
import { isAuthenticated } from '@/security/principal';

/**
 * Email triage-lite (feature #7). Read + assist over the connected mailbox,
 * scoped to the calling user's OAuth token. Send is ASK-gated: it requires an
 * explicit `confirm: true` and is never automatic. Archive is similarly explicit.
 */
export const emailRoutes = new Elysia({ prefix: '/email' })
  .use(apiContext)

  // Triage categories: the user's list (or the presets) and the presets for "reset".
  .get('/categories', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return { categories: await getCategories(user.id), defaults: DEFAULT_CATEGORIES };
  }, { detail: { tags: ['email'] } })

  // Save the list; `categories: null` resets to the presets.
  .put('/categories', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const raw = (body as { categories?: unknown } | undefined)?.categories;
    if (raw === null) return { categories: await setCategories(user.id, null) };
    const clean = validateCategories(raw);
    if (typeof clean === 'string') { set.status = 400; return { error: clean }; }
    return { categories: await setCategories(user.id, clean) };
  }, { detail: { tags: ['email'] } })

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

  // Turn a message into a to-do (source: email). The task carries the
  // subject, sender, snippet and the provider message id so the list links
  // back to the thread; a triaged "high" email lands as a high-priority task.
  .post(
    '/message/:id/task',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        const [task] = await createTasksFromSource(principal, 'email', [emailToTask(message)]);
        return { task: { id: task.id, title: task.title, priority: task.priority } };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Undo an archive (the UI's Undo after auto-archive).
  .post(
    '/message/:id/unarchive',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await unarchiveMessage(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
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
  // `items` = the rows the client already shows (it has sender/subject/snippet),
  // so a 120-mail list is triaged without refetching; absent = first 30 of the
  // inbox (older clients). `autoArchive` archives low-priority spam/marketing.
  .post(
    '/triage',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await detectProvider(user.id);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const req = body as { items?: Array<Pick<InboxItem, 'id' | 'from' | 'subject' | 'snippet'>>; autoArchive?: boolean; applyLabels?: boolean } | undefined;
        const items: InboxItem[] = req?.items
          ? req.items.map((it) => ({ ...it, provider, receivedAt: '', unread: false }))
          : (await getInbox(user.id, 30)).items;
        const triage = await triageInbox(user.id, items);
        // Label first: an archived mail still gets its category label. A label
        // failure (e.g. a token without label scope) must not lose the triage.
        let labeled = 0;
        let labelError: string | undefined;
        if (req?.applyLabels) {
          try { labeled = await applyCategoryLabels(user.id, provider, triage); }
          catch (err) { labelError = (err as Error).message; }
        }
        const archived = req?.autoArchive ? await autoArchive(user.id, provider, triage) : [];
        return { triage, archived, labeled, ...(labelError ? { labelError } : {}) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Optional(t.Object({
        items: t.Optional(t.Array(t.Object({
          id: t.String({ minLength: 1, maxLength: 256 }),
          from: t.Object({ email: t.String({ maxLength: 320 }), name: t.Optional(t.String({ maxLength: 320 })) }),
          subject: t.String({ maxLength: 2000 }),
          snippet: t.String({ maxLength: 2000 }),
        }), { maxItems: 500 })),
        autoArchive: t.Optional(t.Boolean()),
        applyLabels: t.Optional(t.Boolean()),
      })),
      detail: { tags: ['email'] },
    }
  );
