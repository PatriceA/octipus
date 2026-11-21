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
  draftReply,
  getInbox,
  getMessage,
  markRead,
  replyOptions,
  sendReply,
  summarizeMessage,
  triageInbox,
  triageReview,
  backlogProgress,
  startLabelBacklog,
  BacklogBusyError,
  setUserLabel,
  storedTriage,
  type InboxItem,
} from '@/core/email';
import { saveReplyDraft } from '@/core/email/drafts';
import { cancelTriageRun, currentTriageRun, getTriageSettings, setTriageSettings, startTriageRun, TRIAGE_SCOPES, TriageBusyError, triagePreview } from '@/core/email/triage-run';
import { upsertUserLabel } from '@/core/email/triage-labels';
import { withMailboxAccount } from '@/core/email/account-context';
import { resolveProvider } from '@/core/email/mailbox';
import { type EmailOutcome, markEmailHandled } from '@/core/email/watch';
import type { EmailProvider } from '@/core/email/types';
import { createTasksFromSource, emailToTask } from '@/core/tasks/sourced';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

/**
 * The owner dealt with a message here: the inbox watch (core/email/watch.ts)
 * must not hand it to the heartbeat as new. Best-effort — the action itself
 * already happened.
 */
function handledByOwner(userId: string, provider: EmailProvider, messageId: string, outcome: EmailOutcome, taskId?: string): void {
  markEmailHandled({ userId, provider, messageId, outcome, note: 'Handled in the inbox page', taskId })
    .catch((err: unknown) => apiLogger.warn({ err, userId }, 'email: could not record a handled message'));
}

/** The mailbox a request names with `?provider=`, else the user's default; throws when the named one is not connected. */
const mailboxOf = (userId: string, request: Request) => resolveProvider(userId, new URL(request.url).searchParams.get('provider'));

const triageItem = t.Object({
  from: t.Object({ email: t.String({ maxLength: 320 }), name: t.Optional(t.String({ maxLength: 320 })) }),
  subject: t.String({ maxLength: 2000 }),
  snippet: t.String({ maxLength: 2000 }),
});
const triageScope = t.Union(TRIAGE_SCOPES.map((s) => t.Literal(s)));

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
    withMailboxAccount(async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), 50);
        const inbox = await getInbox(user.id, limit, query?.pageToken || undefined);
        if (!inbox.provider || inbox.items.length === 0) return inbox;
        // Earlier triage (and the owner's own labels) come back with the list:
        // without it every reload showed an untriaged inbox. Never blocks the list.
        const triage = await storedTriage(user.id, inbox.provider, inbox.items.map((it) => it.id))
          .catch((err: unknown) => { apiLogger.warn({ error: String((err as Error)?.message ?? err).slice(0, 200), userId: user.id }, 'email: could not read stored triage'); return {} as Record<string, never>; });
        return { ...inbox, items: inbox.items.map((it) => (triage[it.id] ? { ...it, triage: triage[it.id] } : it)) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { query: t.Object({ limit: t.Optional(t.String()), pageToken: t.Optional(t.String()) }), detail: { tags: ['email'] } }
  )

  // Mark a message read (clears the unread flag in the provider).
  .post(
    '/message/:id/mark-read',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await markRead(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Propose reply directions for the user to choose BEFORE drafting.
  .post(
    '/message/:id/reply-options',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        return { options: await replyOptions(user.id, message) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Read a full message.
  .get(
    '/message/:id',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) {
          set.status = 400;
          return { error: 'No mailbox connected' };
        }
        return await getMessage(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Summarize a message.
  .post(
    '/message/:id/summarize',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        return { summary: await summarizeMessage(user.id, message) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Draft a reply (NOT sent — opens in the editable draft view).
  .post(
    '/message/:id/draft',
    withMailboxAccount(async ({ request, user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        return await draftReply(user.id, message, body?.instruction);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), body: t.Object({ instruction: t.Optional(t.String()) }), detail: { tags: ['email'] } }
  )

  // Turn a message into a to-do (source: email). The task carries the
  // subject, sender, snippet and the provider message id so the list links
  // back to the thread; a triaged "high" email lands as a high-priority task.
  .post(
    '/message/:id/task',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const message = await getMessage(user.id, provider, params.id);
        const [task] = await createTasksFromSource(principal, 'email', [emailToTask(message)]);
        handledByOwner(user.id, provider, params.id, 'task', task.id);
        return { task: { id: task.id, title: task.title, priority: task.priority } };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Undo an archive (the UI's Undo after auto-archive).
  .post(
    '/message/:id/unarchive',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await unarchiveMessage(user.id, provider, params.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Archive a message (explicit).
  .post(
    '/message/:id/archive',
    withMailboxAccount(async ({ request, user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const archived = await archiveMessage(user.id, provider, params.id);
        handledByOwner(user.id, provider, params.id, 'archived');
        return archived;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    { params: t.Object({ id: t.String() }), detail: { tags: ['email'] } }
  )

  // Save a reply as a draft in the mailbox (Gmail Drafts / Outlook Drafts),
  // threaded under the message. Nothing is sent.
  .post(
    '/message/:id/save-draft',
    withMailboxAccount(async ({ request, user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const draft = await saveReplyDraft(user.id, provider, params.id, body.body);
        handledByOwner(user.id, provider, params.id, 'drafted');
        return { saved: true, ...draft };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ body: t.String({ minLength: 1, maxLength: 100_000 }) }),
      detail: { tags: ['email'] },
    }
  )

  // Send a reply — ASK-gated. Requires confirm:true; never sends automatically.
  .post(
    '/send',
    withMailboxAccount(async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      // Strict identity check — defeats any truthy/coerced value; only a real
      // boolean true passes the gate. A draft is never sent without it.
      if (body.confirm !== true) {
        set.status = 409;
        return { error: 'Sending requires explicit confirmation', requiresConfirmation: true };
      }
      try {
        const provider = await resolveProvider(user.id, body.provider);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const sent = await sendReply(user.id, provider, { to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, body: body.body, replyTo: body.replyTo });
        if (body.replyTo) handledByOwner(user.id, provider, body.replyTo, 'replied');
        return sent;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    {
      body: t.Object({
        // Comma-separated address lists; validated (and capped at 50 recipients) before anything is sent.
        to: t.String({ minLength: 1, maxLength: 8000 }),
        cc: t.Optional(t.String({ maxLength: 8000 })),
        bcc: t.Optional(t.String({ maxLength: 8000 })),
        // Which connected mailbox sends, when both are; the default one otherwise.
        provider: t.Optional(t.Union([t.Literal('google'), t.Literal('microsoft')])),
        // Which account of that provider sends, when the user connected several; the default otherwise.
        account: t.Optional(t.String({ maxLength: 320 })),
        subject: t.String({ maxLength: 998 }),
        body: t.String({ minLength: 1, maxLength: 100_000 }),
        confirm: t.Optional(t.Boolean()),
        // The message this answers: the reply is threaded under it.
        replyTo: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
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
    withMailboxAccount(async ({ request, user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const req = body as { items?: Array<Pick<InboxItem, 'id' | 'from' | 'subject' | 'snippet'>>; autoArchive?: boolean; applyLabels?: boolean } | undefined;
        const items: InboxItem[] = req?.items
          ? req.items.map((it) => ({ ...it, provider, receivedAt: '', unread: false }))
          : (await getInbox(user.id, 30)).items;
        const { settings } = await getTriageSettings(user.id);
        const triage = await triageInbox(user.id, items, { instructions: settings.instructions });
        // Label first: an archived mail still gets its category label. A label
        // failure (e.g. a token without label scope) must not lose the triage.
        let labeled = 0;
        let labelError: string | undefined;
        if (req?.applyLabels) {
          try { labeled = await applyCategoryLabels(user.id, provider, triage); }
          catch (err) { labelError = (err as Error).message; }
        }
        const archived = req?.autoArchive ? await autoArchive(user.id, provider, triage, settings.archiveCategories) : [];
        return { triage, archived, labeled, ...(labelError ? { labelError } : {}) };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
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
  )

  // Triage review queue: mails the decision model was unsure of or that it and
  // the reference model disagree on, plus how well it does against the labels.
  .get(
    '/triage/review',
    withMailboxAccount(async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      return { ...(await triageReview(user.id)), progress: backlogProgress(user.id) };
    }),
    { detail: { tags: ['email'] } }
  )

  // The owner's label for one mail: it wins over every model from now on.
  .put(
    '/triage/label/:id',
    withMailboxAccount(async ({ request, user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      const categories = await getCategories(user.id);
      if (!Object.hasOwn(categories, body.category)) { set.status = 400; return { error: `Unknown category: ${body.category}` }; }
      const provider = await mailboxOf(user.id, request).catch(() => null);
      const label = { priority: body.priority, category: body.category };
      // With the row itself (the inbox list sends it) any mail can be labelled, seen by triage or not.
      if (body.item && provider) {
        await upsertUserLabel(user.id, provider, { ...body.item, id: params.id, provider, receivedAt: '', unread: false }, label);
        return { ok: true };
      }
      if (!(await setUserLabel(user.id, params.id, label, provider ?? undefined))) { set.status = 404; return { error: 'Triage has not seen this mail yet' }; }
      return { ok: true };
    }),
    {
      params: t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) }),
      body: t.Object({
        priority: t.Union([t.Literal('low'), t.Literal('normal'), t.Literal('high')]),
        category: t.String({ minLength: 1, maxLength: 100 }),
        item: t.Optional(triageItem),
      }),
      detail: { tags: ['email'] },
    }
  )

  // Label the inbox backlog with a model the owner picks, then run the decision
  // model over it: the thresholds are fitted from the first triage on.
  .post(
    '/triage/backlog',
    withMailboxAccount(async ({ request, user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        if (!(await mailboxOf(user.id, request).catch(() => null))) { set.status = 400; return { error: 'No mailbox connected' }; }
        await startLabelBacklog(user.id, body.model, body.limit);
        return { started: true, progress: backlogProgress(user.id) };
      } catch (err) {
        set.status = err instanceof BacklogBusyError ? 409 : 400;
        return { error: (err as Error).message };
      }
    }),
    {
      body: t.Object({ model: t.String({ minLength: 1, maxLength: 200 }), limit: t.Integer({ minimum: 1, maximum: 2000 }) }),
      detail: { tags: ['email'] },
    }
  )

  // How "Triage inbox" runs for this user. `saved: false` = never changed (defaults).
  .get('/triage/settings', withMailboxAccount(async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return getTriageSettings(user.id);
  }), { detail: { tags: ['email'] } })

  .put(
    '/triage/settings',
    withMailboxAccount(async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      return { settings: await setTriageSettings(user.id, body), saved: true };
    }),
    {
      body: t.Object({
        scope: t.Optional(triageScope),
        applyLabels: t.Optional(t.Boolean()),
        autoArchive: t.Optional(t.Boolean()),
        archiveCategories: t.Optional(t.Array(t.String({ maxLength: 32 }), { maxItems: 21 })),
        instructions: t.Optional(t.String({ maxLength: 1000 })),
        skipDialog: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['email'] },
    }
  )

  // What a run over these rows would do and what the models are told. Asks no model.
  .post(
    '/triage/preview',
    withMailboxAccount(async ({ request, user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        return await triagePreview(user.id, provider, body.items);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    }),
    {
      body: t.Object({ items: t.Array(t.Object({ id: t.String({ minLength: 1, maxLength: 256 }), unread: t.Boolean() }), { maxItems: 500 }) }),
      detail: { tags: ['email'] },
    }
  )

  // Start a triage run in the background with the saved settings: either the
  // rows the page shows (`items`) or the newest N of the inbox (`newest`).
  .post(
    '/triage/run',
    withMailboxAccount(async ({ request, user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        const provider = await mailboxOf(user.id, request);
        if (!provider) { set.status = 400; return { error: 'No mailbox connected' }; }
        const items: InboxItem[] | undefined = body.items?.map((it: Pick<InboxItem, 'id' | 'from' | 'subject' | 'snippet'>) => ({ ...it, provider, receivedAt: '', unread: false }));
        set.status = 202;
        return { run: await startTriageRun(user.id, provider, { items, newest: body.newest, scope: body.scope }) };
      } catch (err) {
        set.status = err instanceof TriageBusyError ? 409 : 400;
        return { error: (err as Error).message };
      }
    }),
    {
      body: t.Object({
        items: t.Optional(t.Array(t.Object({
          id: t.String({ minLength: 1, maxLength: 256 }),
          from: t.Object({ email: t.String({ maxLength: 320 }), name: t.Optional(t.String({ maxLength: 320 })) }),
          subject: t.String({ maxLength: 2000 }),
          snippet: t.String({ maxLength: 2000 }),
        }), { maxItems: 500 })),
        newest: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
        scope: t.Optional(triageScope),
      }),
      detail: { tags: ['email'] },
    }
  )

  // The user's current (or last) run: progress, then the result.
  .get('/triage/run', withMailboxAccount(async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return { run: currentTriageRun(user.id) };
  }), { detail: { tags: ['email'] } })

  .post('/triage/run/cancel', withMailboxAccount(async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return { cancelled: cancelTriageRun(user.id), run: currentTriageRun(user.id) };
  }), { detail: { tags: ['email'] } });
