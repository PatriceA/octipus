/**
 * `mail:read`, `mail:draft` and `mail:send` of the plugin host API
 * (docs/PLUGIN-PACKAGES.md#mail-and-calendar): a package reads, drafts and
 * sends the calling user's mail, as that user. Two sources
 * (./host-sources.ts): the Mail module's mailboxes (`mail`) and the
 * connected Gmail or Microsoft 365 inbox (`inbox`).
 *
 * - **Protection.** A Mail module message is at its own level (none: 4); the
 *   inbox's messages carry none and count as 4. What is above the package's
 *   `maxProtection` is left out of a list (in the query, so it neither uses
 *   the limit nor shows that it exists) and refused when named (403
 *   `protection_level`). What is handed over raises the calling session and
 *   the package's level for this user, as a document does.
 * - **Drafts** are the user's, at least at the level of what the call has
 *   read (Mail module), marked with the package and tool (`plugin_source`);
 *   the package may change and send only the drafts it created
 *   (`plugin_items`). An inbox draft goes into the provider's mailbox (level 4).
 * - **Sending** leaves the house: `mail:send` is an egress scope (the package
 *   is clamped to level 1) handed to `external` tools only, whose every call
 *   is asked about; a call holding data above what the package may carry
 *   out (the session's level, or what it read) may not send (403
 *   `read_level`). Recipients are checked and capped as for the user's own
 *   sends (`MAX_RECIPIENTS`).
 */
import type { ContentRepos } from '@/db/repositories/content';
import type { MailAccount, MailMessage } from '@/db/schema/mail';
import type { Principal } from '@/security/principal';
import { effectiveProtectionLevel, UNCLEAR_PROTECTION_LEVEL } from '@/shared/protection';
import type { MailAddress } from '@/shared/mail';
import { coreLogger } from '@/utils/logger';
import type { HostTokenGrant } from './host-api';
import { inboxProvider, type InboxProvider, mailModuleRefusal, type MailSource, type SourceRefusal } from './host-sources';

/** The inbox's messages carry no protection level: unclear. */
export const INBOX_PROTECTION_LEVEL = UNCLEAR_PROTECTION_LEVEL;

/** The most characters of a message's text handed back. */
export const MAIL_TEXT_MAX = 50_000;

/** A provider's message or draft id, as it may appear in a URL path segment. */
const PROVIDER_ID_RE = /^[A-Za-z0-9_=+/-]{1,1024}$/;

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string };

const fail = <T>(r: SourceRefusal): Outcome<T> => ({ ok: false, ...r });
const invalid = <T>(error: string): Outcome<T> => ({ ok: false, status: 400, code: 'invalid', error });
const notFound = <T>(what = 'Message'): Outcome<T> => ({ ok: false, status: 404, code: 'not_found', error: `${what} not found` });
const aboveMax = <T>(level: number, max: number): Outcome<T> => ({
  ok: false, status: 403, code: 'protection_level', error: `It is at protection level ${level}; this package may see up to ${max}`,
});

/** The inbox's provider functions, replaceable in tests. */
export interface InboxDeps {
  detect?: (userId: string) => Promise<InboxProvider | null>;
  list?: (userId: string, limit: number, pageToken?: string) => Promise<{ provider: InboxProvider | null; items: Array<{ id: string; from: unknown; subject: string; snippet: string; receivedAt: string; unread: boolean }>; nextPageToken?: string }>;
  get?: (userId: string, provider: InboxProvider, id: string) => Promise<{ id: string; from: unknown; to?: unknown; subject: string; body: string; receivedAt: string; unread: boolean }>;
  saveReply?: (userId: string, provider: InboxProvider, messageId: string, body: string) => Promise<{ draftId: string; to: string; subject: string }>;
  saveNew?: (userId: string, provider: InboxProvider, msg: { to: string[]; subject: string; body: string }) => Promise<{ draftId: string }>;
  send?: (userId: string, provider: InboxProvider, msg: { to: string; subject: string; body: string }) => Promise<unknown>;
}

/** What the call read raises it to: the calling session, and the package's level for this user. */
async function noteRead(grant: HostTokenGrant, level: number): Promise<void> {
  if (level <= 1) return;
  const { raiseSessionLevel } = await import('@/core/protection/session-level');
  const { noteHostRead } = await import('./host-api');
  if (grant.sessionId) raiseSessionLevel(grant.sessionId, level);
  await noteHostRead(grant, level);
}

/** A sent message carries what the call holds: refused when that is above what the package may carry out. */
function sendRefusal(grant: HostTokenGrant): SourceRefusal | null {
  const level = grant.readLevel ?? 1;
  if (level <= grant.maxProtection) return null;
  return {
    status: 403, code: 'read_level',
    error: `This call works at protection level ${level} (what the package has read for this user, or what the calling session holds); `
      + `a package that sends mail may carry out data up to level ${grant.maxProtection} only`,
  };
}

const summaryOf = (m: Omit<MailMessage, 'bodyText' | 'bodyHtml'>) => ({
  id: m.id, source: 'mail' as const, accountId: m.accountId, status: m.status, from: m.fromAddress, to: m.toAddresses, cc: m.ccAddresses,
  subject: m.subject, preview: m.snippet, date: m.date, unread: m.unread, attachments: m.attachments.length,
  protectionLevel: effectiveProtectionLevel(m.protectionLevel),
});

// ── mail:read ───────────────────────────────────────────────────────────────

/** The Mail module's mailboxes the call reaches, and the connected inbox's provider. */
export async function listMailSources(grant: HostTokenGrant, principal: Principal, repos: ContentRepos, deps: InboxDeps = {}): Promise<Outcome<{
  accounts: Array<{ id: string; label: string; address: string; canSend: boolean }>;
  inbox: { provider: InboxProvider; protectionLevel: number } | null;
}>> {
  const accounts = (await mailModuleRefusal(grant, 'read')) ? [] : (await repos.mail.accounts())
    .map((a) => ({ id: a.id, label: a.label, address: a.address, canSend: a.outgoing !== null }));
  const inbox = await inboxProvider(grant, principal, 'read', deps);
  return { ok: true, value: { accounts, inbox: 'provider' in inbox ? { provider: inbox.provider, protectionLevel: INBOX_PROTECTION_LEVEL } : null } };
}

export interface MailListQuery {
  source: MailSource;
  accountId?: string;
  status?: 'received' | 'sent' | 'draft';
  unread?: boolean;
  q?: string;
  limit?: number;
  /** The next page: a Mail module list's `next`, or an inbox list's `nextPageToken`. */
  cursor?: string;
}

/** Messages, newest first, without their text. */
export async function listMail(grant: HostTokenGrant, principal: Principal, repos: ContentRepos, query: MailListQuery, deps: InboxDeps = {}): Promise<Outcome<{
  messages: unknown[]; next: string | null;
}>> {
  const limit = Math.max(1, Math.min(100, query.limit ?? 25));
  if (query.source === 'inbox') {
    const reached = await inboxProvider(grant, principal, 'read', deps);
    if (!('provider' in reached)) return fail(reached);
    if (INBOX_PROTECTION_LEVEL > grant.maxProtection) return aboveMax(INBOX_PROTECTION_LEVEL, grant.maxProtection);
    if (query.accountId || query.status || query.unread || query.q) return invalid('The inbox lists by page only (limit, cursor)');
    const list = deps.list ?? (async (userId: string, n: number, token?: string) => (await import('@/core/email/service')).getInbox(userId, n, token));
    const page = await list(grant.userId, limit, query.cursor);
    await noteRead(grant, INBOX_PROTECTION_LEVEL);
    return {
      ok: true,
      value: {
        messages: page.items.map((m) => ({
          id: m.id, source: 'inbox', provider: page.provider, from: m.from, subject: m.subject, preview: m.snippet, date: m.receivedAt, unread: m.unread,
          protectionLevel: INBOX_PROTECTION_LEVEL,
        })),
        next: page.nextPageToken ?? null,
      },
    };
  }
  const refused = await mailModuleRefusal(grant, 'read');
  if (refused) return fail(refused);
  let before: { date: Date; id: string } | undefined;
  if (query.cursor) {
    const [iso, id] = query.cursor.split('|');
    const date = new Date(iso ?? '');
    if (!id || Number.isNaN(date.getTime())) return invalid('cursor is the "next" of an earlier list');
    before = { date, id };
  }
  const rows = await repos.mail.list({
    accountId: query.accountId, status: query.status ?? 'received', unread: query.unread, q: query.q?.slice(0, 200), before, limit,
    maxLevel: grant.maxProtection,
  });
  await noteRead(grant, Math.max(1, ...rows.map((m) => effectiveProtectionLevel(m.protectionLevel))));
  const last = rows.at(-1);
  return { ok: true, value: { messages: rows.map(summaryOf), next: rows.length === limit && last ? `${last.date.toISOString()}|${last.id}` : null } };
}

/** One message with its plain text (capped). */
export async function readMail(grant: HostTokenGrant, principal: Principal, repos: ContentRepos, source: MailSource, id: string, deps: InboxDeps = {}): Promise<Outcome<unknown>> {
  if (source === 'inbox') {
    const reached = await inboxProvider(grant, principal, 'read', deps);
    if (!('provider' in reached)) return fail(reached);
    if (INBOX_PROTECTION_LEVEL > grant.maxProtection) return aboveMax(INBOX_PROTECTION_LEVEL, grant.maxProtection);
    if (!PROVIDER_ID_RE.test(id)) return notFound();
    const get = deps.get ?? (async (userId: string, provider: InboxProvider, mid: string) => (await import('@/core/email/service')).getMessage(userId, provider, mid));
    // getMessage puts the id into its path as it is.
    const m = await get(grant.userId, reached.provider, encodeURIComponent(id));
    await noteRead(grant, INBOX_PROTECTION_LEVEL);
    return {
      ok: true,
      value: {
        id: m.id, source: 'inbox', provider: reached.provider, from: m.from, to: m.to ?? [], subject: m.subject, date: m.receivedAt, unread: m.unread,
        text: m.body.slice(0, MAIL_TEXT_MAX), truncated: m.body.length > MAIL_TEXT_MAX, protectionLevel: INBOX_PROTECTION_LEVEL,
      },
    };
  }
  const refused = await mailModuleRefusal(grant, 'read');
  if (refused) return fail(refused);
  const m = await repos.mail.message(id);
  if (!m) return notFound();
  const level = effectiveProtectionLevel(m.protectionLevel);
  if (level > grant.maxProtection) return aboveMax(level, grant.maxProtection);
  await noteRead(grant, level);
  return {
    ok: true,
    value: {
      ...summaryOf(m), text: m.bodyText.slice(0, MAIL_TEXT_MAX), truncated: m.bodyText.length > MAIL_TEXT_MAX,
      attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    },
  };
}

// ── mail:draft and mail:send ────────────────────────────────────────────────

export interface MailCompose {
  source: MailSource;
  /** Mail module: the account to send from (not with replyTo). */
  accountId?: string;
  /** Recipients: "a@x.de, Jane <j@y.de>" or a list (not with replyTo). */
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  body: string;
  /** Answer this received message: its sender, subject and thread. */
  replyTo?: string;
  /** With replyTo, Mail module only: also its other recipients. */
  replyAll?: boolean;
}

type ComposeError = { error: string };

/** A Mail module draft composed from `req`: the account, what to store, the level it is at (at least the call's). */
async function composeMailDraft(grant: HostTokenGrant, repos: ContentRepos, req: MailCompose): Promise<
  { account: MailAccount; data: Parameters<ContentRepos['mail']['createDraft']>[1]; level: number } | ComposeError | null
> {
  const { cleanBody, cleanSubject, MailInputError, parseRecipients, replyDraft, replyProtectionLevel } = await import('@/core/mail/drafts');
  try {
    if (req.replyTo) {
      if (req.accountId || req.to || req.cc || req.subject) return { error: 'A reply takes its account, recipients and subject from replyTo' };
      const original = await repos.mail.message(req.replyTo);
      if (!original || original.status !== 'received') return null;
      const originalLevel = effectiveProtectionLevel(original.protectionLevel);
      if (originalLevel > grant.maxProtection) return { error: `protection_level:${originalLevel}` };
      const account = await repos.mail.account(original.accountId);
      if (!account) return null;
      // The draft quotes the original, and its answer names the original's people and subject.
      await noteRead(grant, originalLevel);
      return {
        account,
        data: replyDraft(account, original, cleanBody(req.body), req.replyAll === true),
        level: Math.max(grant.readLevel ?? 1, effectiveProtectionLevel(replyProtectionLevel(account, original))),
      };
    }
    if (req.replyAll) return { error: 'replyAll goes with replyTo' };
    const account = req.accountId ? await repos.mail.account(req.accountId) : null;
    if (!account) return { error: 'Name the account to send from (accountId, from GET /mail/accounts) or a message to reply to (replyTo)' };
    const to = parseRecipients(req.to);
    if (to.length === 0) return { error: 'A new message needs at least one recipient' };
    return {
      account,
      data: { toAddresses: to, ccAddresses: parseRecipients(req.cc), subject: cleanSubject(req.subject), bodyText: cleanBody(req.body), inReplyTo: null, references: null },
      level: Math.max(grant.readLevel ?? 1, effectiveProtectionLevel(account.defaultProtectionLevel)),
    };
  } catch (err) {
    if (err instanceof MailInputError) return { error: err.message };
    throw err;
  }
}

/** A composed draft's refusal, as an outcome. */
function composeRefusal<T>(c: ComposeError | null, what = 'Message'): Outcome<T> {
  if (c === null) return notFound(what);
  const level = /^protection_level:(\d)$/.exec(c.error)?.[1];
  if (level) return { ok: false, status: 403, code: 'protection_level', error: `The message replied to is at protection level ${level}, above what this package may see` };
  return invalid(c.error);
}

/** Inbox recipients: plain addresses (the providers' send takes one, a draft several). */
async function inboxRecipients(input: MailCompose['to']): Promise<string[] | ComposeError> {
  const { MailInputError, parseRecipients } = await import('@/core/mail/drafts');
  try {
    return parseRecipients(input).map((a: MailAddress) => a.address);
  } catch (err) {
    if (err instanceof MailInputError) return { error: err.message };
    throw err;
  }
}

/** Save a draft (`POST /api/plugin-host/mail/drafts`). Never sends. */
export async function createMailDraft(grant: HostTokenGrant, principal: Principal, repos: ContentRepos, req: MailCompose, deps: InboxDeps = {}): Promise<Outcome<{
  id: string; source: MailSource; provider?: InboxProvider; protectionLevel: number;
}>> {
  if (req.source === 'inbox') {
    const reached = await inboxProvider(grant, principal, 'draft', deps);
    if (!('provider' in reached)) return fail(reached);
    const { cleanBody, cleanSubject } = await import('@/core/mail/drafts');
    const body = cleanBody(req.body);
    if (!body.trim()) return invalid('A draft needs a body');
    if (req.replyTo) {
      if (req.to || req.cc || req.subject || req.accountId || req.replyAll) return invalid('An inbox reply takes its recipient and subject from replyTo');
      if (!PROVIDER_ID_RE.test(req.replyTo)) return notFound();
      const saveReply = deps.saveReply ?? (async (u: string, p: InboxProvider, mid: string, b: string) => (await import('@/core/email/drafts')).saveReplyDraft(u, p, mid, b));
      // saveReplyDraft encodes the id into its path itself.
      const saved = await saveReply(grant.userId, reached.provider, req.replyTo, body);
      await noteRead(grant, INBOX_PROTECTION_LEVEL);
      return { ok: true, value: { id: saved.draftId, source: 'inbox', provider: reached.provider, protectionLevel: INBOX_PROTECTION_LEVEL } };
    }
    if (req.accountId || req.cc || req.replyAll) return invalid('An inbox draft takes to, subject and body');
    const to = await inboxRecipients(req.to);
    if ('error' in to) return invalid(to.error);
    if (to.length === 0) return invalid('A new message needs at least one recipient');
    const { MAX_RECIPIENTS } = await import('@/core/mail/send');
    if (to.length > MAX_RECIPIENTS) return invalid(`A message can have at most ${MAX_RECIPIENTS} recipients`);
    const saveNew = deps.saveNew ?? saveInboxDraft;
    const saved = await saveNew(grant.userId, reached.provider, { to, subject: cleanSubject(req.subject), body });
    return { ok: true, value: { id: saved.draftId, source: 'inbox', provider: reached.provider, protectionLevel: INBOX_PROTECTION_LEVEL } };
  }
  const refused = await mailModuleRefusal(grant, 'draft');
  if (refused) return fail(refused);
  repos.can('write');
  const composed = await composeMailDraft(grant, repos, req);
  if (composed === null || 'error' in composed) return composeRefusal(composed);
  const draft = await repos.mail.createDraft(composed.account, composed.data, composed.level, { plugin: grant.plugin, tool: grant.tool });
  const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
  await pluginItemsRepository.record({ plugin: grant.plugin, userId: grant.userId, kind: 'mail_draft', provider: 'mail', itemId: draft.id });
  return { ok: true, value: { id: draft.id, source: 'mail', protectionLevel: composed.level } };
}

/** A new draft in the connected provider's mailbox. */
async function saveInboxDraft(userId: string, provider: InboxProvider, msg: { to: string[]; subject: string; body: string }): Promise<{ draftId: string }> {
  const { gmailApi, graphApi } = await import('@/core/email/providers');
  if (provider === 'google') {
    const { buildGmailRaw } = await import('@/core/email/service');
    const draft = (await gmailApi(userId, 'POST', '/drafts', { message: { raw: buildGmailRaw(msg.to.join(', '), msg.subject, msg.body) } })) as { id?: string };
    return { draftId: draft.id ?? '' };
  }
  const draft = (await graphApi(userId, 'POST', '/me/messages', {
    subject: msg.subject, body: { contentType: 'Text', content: msg.body }, toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
  })) as { id?: string };
  coreLogger.info({ userId, provider }, 'plugin-host: inbox draft saved'); // no address, subject or body logged
  return { draftId: draft.id ?? '' };
}

/** A Mail module draft the package created for this user, within its maxProtection; or the refusal. */
async function ownDraft(grant: HostTokenGrant, repos: ContentRepos, id: string): Promise<Outcome<MailMessage>> {
  const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
  const draft = await repos.mail.message(id);
  if (!draft || (draft.status !== 'draft' && draft.status !== 'failed')) return notFound('Draft');
  if (!(await pluginItemsRepository.owns({ plugin: grant.plugin, userId: grant.userId, kind: 'mail_draft', provider: 'mail', itemId: draft.id }))) {
    return { ok: false, status: 403, code: 'not_created_by_plugin', error: 'This package may change only the drafts it created' };
  }
  const level = effectiveProtectionLevel(draft.protectionLevel);
  if (level > grant.maxProtection) return aboveMax(level, grant.maxProtection);
  return { ok: true, value: draft };
}

export interface MailDraftChange { to?: string | string[]; cc?: string | string[]; subject?: string; body?: string }

/** Change a Mail module draft this package created (`PUT /api/plugin-host/mail/drafts/:id`); its level only rises. */
export async function updateMailDraft(grant: HostTokenGrant, repos: ContentRepos, id: string, req: MailDraftChange): Promise<Outcome<{ id: string; protectionLevel: number }>> {
  const refused = await mailModuleRefusal(grant, 'draft');
  if (refused) return fail(refused);
  repos.can('write');
  const own = await ownDraft(grant, repos, id);
  if (!own.ok) return own;
  const { cleanBody, cleanSubject, MailInputError, parseRecipients } = await import('@/core/mail/drafts');
  let patch: Parameters<ContentRepos['mail']['updateDraft']>[1];
  try {
    patch = {
      ...(req.to !== undefined ? { toAddresses: parseRecipients(req.to) } : {}),
      ...(req.cc !== undefined ? { ccAddresses: parseRecipients(req.cc) } : {}),
      ...(req.subject !== undefined ? { subject: cleanSubject(req.subject) } : {}),
      ...(req.body !== undefined ? { bodyText: cleanBody(req.body) } : {}),
    };
  } catch (err) {
    if (err instanceof MailInputError) return invalid(err.message);
    throw err;
  }
  if (Object.keys(patch).length === 0) return invalid('Change at least one of to, cc, subject, body');
  const updated = await repos.mail.updateDraft(own.value.id, patch);
  if (!updated) return notFound('Draft');
  const level = Math.max(grant.readLevel ?? 1, effectiveProtectionLevel(own.value.protectionLevel));
  if (level > effectiveProtectionLevel(own.value.protectionLevel)) await repos.mail.setProtectionLevel(updated.id, level, true);
  return { ok: true, value: { id: updated.id, protectionLevel: level } };
}

/** Send a Mail module draft through the account's server; the item is the package's no more. */
async function sendOwnDraft(grant: HostTokenGrant, repos: ContentRepos, draft: MailMessage): Promise<Outcome<{ id: string; source: 'mail' }>> {
  const { MailSendError, sendDraft } = await import('@/core/mail/send');
  const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
  try {
    const sent = await sendDraft(repos.mail, draft.id);
    await pluginItemsRepository.forget({ plugin: grant.plugin, userId: grant.userId, kind: 'mail_draft', provider: 'mail', itemId: draft.id });
    return { ok: true, value: { id: sent.id, source: 'mail' } };
  } catch (err) {
    if (err instanceof MailSendError) return { ok: false, status: 422, code: 'not_sent', error: `Not sent: ${err.message}` };
    throw err;
  }
}

/** Send a Mail module draft this package created (`POST /api/plugin-host/mail/drafts/:id/send`). */
export async function sendMailDraft(grant: HostTokenGrant, repos: ContentRepos, id: string): Promise<Outcome<{ id: string; source: 'mail' }>> {
  const refused = (await mailModuleRefusal(grant, 'send')) ?? sendRefusal(grant);
  if (refused) return fail(refused);
  repos.can('write');
  const own = await ownDraft(grant, repos, id);
  if (!own.ok) return own;
  return sendOwnDraft(grant, repos, own.value);
}

/** Compose and send a message now (`POST /api/plugin-host/mail/send`). */
export async function sendMail(grant: HostTokenGrant, principal: Principal, repos: ContentRepos, req: MailCompose, deps: InboxDeps = {}): Promise<Outcome<{
  id: string | null; source: MailSource; provider?: InboxProvider;
}>> {
  if (req.source === 'inbox') {
    const reached = await inboxProvider(grant, principal, 'send', deps);
    if (!('provider' in reached)) return fail(reached);
    const refused = sendRefusal(grant);
    if (refused) return fail(refused);
    if (req.replyTo || req.cc || req.accountId || req.replyAll) return invalid('An inbox send takes one recipient (to), a subject and a body');
    const to = await inboxRecipients(req.to);
    if ('error' in to) return invalid(to.error);
    if (to.length !== 1) return invalid('An inbox send goes to exactly one recipient');
    const { cleanBody, cleanSubject } = await import('@/core/mail/drafts');
    const body = cleanBody(req.body);
    if (!body.trim()) return invalid('A message needs a body');
    const send = deps.send ?? (async (u: string, p: InboxProvider, msg: { to: string; subject: string; body: string }) => (await import('@/core/email/service')).sendReply(u, p, msg));
    await send(grant.userId, reached.provider, { to: to[0], subject: cleanSubject(req.subject), body });
    return { ok: true, value: { id: null, source: 'inbox', provider: reached.provider } };
  }
  const refused = (await mailModuleRefusal(grant, 'send')) ?? sendRefusal(grant);
  if (refused) return fail(refused);
  repos.can('write');
  const composed = await composeMailDraft(grant, repos, req);
  if (composed === null || 'error' in composed) return composeRefusal(composed);
  // A reply may have raised the call's level (the original it quotes): checked again.
  const after = sendRefusal(grant);
  if (after) return fail(after);
  const draft = await repos.mail.createDraft(composed.account, composed.data, composed.level, { plugin: grant.plugin, tool: grant.tool });
  const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
  await pluginItemsRepository.record({ plugin: grant.plugin, userId: grant.userId, kind: 'mail_draft', provider: 'mail', itemId: draft.id });
  return sendOwnDraft(grant, repos, draft);
}
