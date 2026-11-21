/**
 * "Triage inbox" as the owner starts it from the Email page: the settings a
 * run uses, a preview of what a run would do and what the models are told,
 * and the run itself as a background job with progress and cancel.
 *
 * The triage logic is in service.ts (triageInbox). Nothing here asks a model
 * except through it.
 */
import { randomUUID } from 'node:crypto';
import { userRepository } from '@/db/repositories/user-repository';
import type { UserPreferences } from '@/db/schema/users';
import { coreLogger } from '@/utils/logger';
import {
  applyCategoryLabels,
  AUTO_ARCHIVE_CATEGORIES,
  autoArchive,
  autoArchiveIds,
  type Categories,
  cleanInstructions,
  getCategories,
  PRIORITY_RULES,
  rubricKey,
  TriageCancelledError,
  triageInbox,
  triageLlmModel,
  type TriageStage,
} from './service';
import type { MailboxSelection } from './account-context';
import { invalidateEmailCache, listMessages } from './mailbox';
import { type CheckedMailbox, inSource } from './triage-sources';
import { storedTriage, thresholdsFor } from './triage-labels';
import { type EmailProvider, type EmailTriage, type InboxItem, isImapMailbox, type MailboxKey } from './types';

export const TRIAGE_SCOPES = ['untriaged', 'unread', 'all'] as const;
export type TriageScope = (typeof TRIAGE_SCOPES)[number];

export interface TriageSettings {
  /** Which mails a run takes: not triaged yet, unread, or all of them. */
  scope: TriageScope;
  /** Tag each mail with its category in the mailbox (Gmail label / Outlook category `Octipus/<category>`). */
  applyLabels: boolean;
  /** Archive low-priority mail of `archiveCategories` when a run ends. Off: the run only proposes them. */
  autoArchive: boolean;
  archiveCategories: string[];
  /** The owner's standing instructions to the models. */
  instructions: string;
  /** Start a run with these settings without showing them first. */
  skipDialog: boolean;
  /** Triage new inbox mail without being asked (auto-triage.ts). */
  auto: boolean;
}

/** The last automatic run that triaged something or failed. */
export type LastAutoTriage = NonNullable<NonNullable<UserPreferences['emailTriage']>['lastAuto']>;

/** Nothing in the mailbox changes until the owner turns it on. */
export const DEFAULT_TRIAGE_SETTINGS: TriageSettings = {
  scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: [...AUTO_ARCHIVE_CATEGORIES], instructions: '', skipDialog: false, auto: false,
};

/** Stored settings over the defaults, with archive categories that no longer exist dropped. Pure. */
export function resolveTriageSettings(stored: UserPreferences['emailTriage'] | undefined, categories: Categories): TriageSettings {
  const s = stored ?? {};
  const archive = Array.isArray(s.archiveCategories) ? s.archiveCategories : DEFAULT_TRIAGE_SETTINGS.archiveCategories;
  return {
    scope: (TRIAGE_SCOPES as readonly string[]).includes(s.scope ?? '') ? s.scope as TriageScope : DEFAULT_TRIAGE_SETTINGS.scope,
    applyLabels: s.applyLabels === true,
    autoArchive: s.autoArchive === true,
    archiveCategories: [...new Set(archive.filter((c): c is string => typeof c === 'string' && Object.hasOwn(categories, c)))],
    instructions: cleanInstructions(s.instructions),
    skipDialog: s.skipDialog === true,
    auto: s.auto === true,
  };
}

export async function getTriageSettings(userId: string): Promise<{ settings: TriageSettings; saved: boolean; lastAuto: LastAutoTriage | null }> {
  const stored = (await userRepository.findById(userId))?.preferences?.emailTriage;
  return { settings: resolveTriageSettings(stored, await getCategories(userId)), saved: !!stored, lastAuto: stored?.lastAuto ?? null };
}

/**
 * Save a change of some settings; the rest keep their value. Turning
 * automatic triage on remembers when, so it starts with mail that arrives
 * from then on, not with the whole inbox.
 */
export async function setTriageSettings(userId: string, patch: Partial<TriageSettings>, now = new Date()): Promise<TriageSettings> {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error('User not found');
  const categories = await getCategories(userId);
  const stored = user.preferences?.emailTriage ?? {};
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const settings = resolveTriageSettings({ ...resolveTriageSettings(stored, categories), ...given }, categories);
  const autoSince = settings.auto ? (stored.auto === true && stored.autoSince ? stored.autoSince : now.toISOString()) : undefined;
  const { autoSince: _old, ...kept } = stored;
  await userRepository.update(userId, { preferences: { ...(user.preferences ?? {}), emailTriage: { ...kept, ...settings, ...(autoSince ? { autoSince } : {}) } } });
  return settings;
}

/** Record an automatic run on the stored settings, read again just before so a change made meanwhile is kept. */
export async function recordAutoTriage(userId: string, lastAuto: LastAutoTriage): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user) return;
  await userRepository.update(userId, { preferences: { ...(user.preferences ?? {}), emailTriage: { ...(user.preferences?.emailTriage ?? {}), lastAuto } } });
}

/** The mails of `items` a run with this scope takes. `triaged` holds the ids that already have an answer. Pure. */
export function inScope(items: Array<Pick<InboxItem, 'id' | 'unread'>>, scope: TriageScope, triaged: ReadonlySet<string>): string[] {
  return items.filter(it => (scope === 'all' ? true : scope === 'unread' ? it.unread : !triaged.has(it.id))).map(it => it.id);
}

export interface TriagePreview {
  settings: TriageSettings;
  /** What the run can do with these mailboxes: labels and archiving exist for Google / Microsoft mail only. */
  capabilities: { labels: boolean; archive: boolean; imap: boolean };
  lastAuto: LastAutoTriage | null;
  /** How many of the given mails each scope would take. */
  counts: Record<TriageScope, number>;
  /** Of the given mails: labelled by the owner (kept as they are, no model asked). */
  ownerLabelled: number;
  categories: Categories;
  /** What the models are told, in the words they get. */
  rules: {
    priority: readonly string[];
    /** What of a mail a model sees. */
    sees: string;
    /** The worked examples the decision model is shown. */
    examples: string;
  };
  models: {
    /** The decision model, when one is bound to the `decision` lane. */
    decision: { name: string; local: boolean } | null;
    /** The LLM that answers what the decision model does not, or why none can. */
    llm: { name: string } | { error: string };
  };
  /** Confidence an answer of the decision model needs to be taken, per question. */
  thresholds: { priority: number; category: number } | null;
}

async function decisionModelInfo(): Promise<TriagePreview['models']['decision']> {
  try {
    const { getModelRegistry } = await import('@/models/model-registry');
    const model = await getModelRegistry().getModelForTopic('decision');
    if (!model) return null;
    const { resolveDataPolicy } = await import('@/models/decision');
    const { getConfig } = await import('@/config');
    return { name: model.name, local: resolveDataPolicy(model, getConfig().ollama.url).hosting === 'local' };
  } catch {
    return null;
  }
}

/** Items grouped by the mailbox they live in; an item without one belongs to `fallback`. Pure. */
export function byMailbox<T extends { mailbox?: MailboxKey }>(items: readonly T[], fallback: MailboxKey): Map<MailboxKey, T[]> {
  const groups = new Map<MailboxKey, T[]>();
  for (const it of items) {
    const key = it.mailbox ?? fallback;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return groups;
}

/** What a run over these mails would do, without asking a model. Each mail may name its mailbox; the rest are in `provider`. */
export async function triagePreview(userId: string, provider: MailboxKey, items: Array<Pick<InboxItem, 'id' | 'unread'> & { mailbox?: string }>, checked: ReadonlyMap<string, CheckedMailbox> = new Map()): Promise<TriagePreview> {
  const categories = await getCategories(userId);
  const { settings, lastAuto } = await getTriageSettings(userId);
  // Grouped by the key the page sent: two accounts of one provider are two groups.
  const groups = new Map<string, Array<Pick<InboxItem, 'id' | 'unread'>>>();
  for (const it of items) { const key = it.mailbox ?? provider; groups.set(key, [...(groups.get(key) ?? []), it]); }
  const sourceOf = (key: string): CheckedMailbox => checked.get(key) ?? { mailbox: key as MailboxKey };
  const answers = await Promise.all([...groups].map(([key, rows]) => {
    const source = sourceOf(key);
    return inSource(source, () => storedTriage(userId, source.mailbox, rows.map(it => it.id))).catch((): Record<string, EmailTriage> => ({}));
  }));
  // Message ids are unique within a mailbox only: count per mailbox.
  const known = answers.flatMap((a) => Object.values(a));
  const triagedIn = new Map([...groups.keys()].map((key, i) => [key, new Set(Object.keys(answers[i]))]));
  const mailboxes = groups.size ? [...groups.keys()].map((key) => sourceOf(key).mailbox) : [provider];
  const oauth = mailboxes.some(m => !isImapMailbox(m));
  const count = (scope: TriageScope) => [...groups].reduce((n, [key, rows]) => n + inScope(rows, scope, triagedIn.get(key)!).length, 0);
  const decision = await decisionModelInfo();
  const llm = await triageLlmModel(userId).then(m => ({ name: m.modelConfigName }), (err: unknown) => ({ error: String((err as Error)?.message ?? err).slice(0, 300) }));
  return {
    settings,
    capabilities: { labels: oauth, archive: oauth, imap: mailboxes.some(isImapMailbox) },
    lastAuto,
    counts: { untriaged: count('untriaged'), unread: count('unread'), all: items.length },
    ownerLabelled: known.filter(t => t.source === 'owner').length,
    categories,
    rules: {
      priority: PRIORITY_RULES,
      sees: 'The sender, the subject and the first lines of each mail. Never the full body or attachments.',
      examples: 'For each mail, up to five earlier mails from the same sender (or the same company domain) and how they were labelled. Your own labels come first and outweigh a model\'s.',
    },
    models: { decision, llm },
    thresholds: decision ? await thresholdsFor(userId, rubricKey(categories, settings.instructions)).catch(() => null) : null,
  };
}

export interface TriageRun {
  id: string;
  /** Mails the models are working through (owner-labelled mail is answered at once). */
  total: number;
  done: number;
  stage: 'starting' | TriageStage | 'applying' | 'done';
  startedAt: string;
  finished: boolean;
  cancelled?: boolean;
  error?: string;
  result?: {
    triage: Record<string, EmailTriage>;
    /** Mails tagged with their category in the mailbox. */
    labeled: number;
    labelError?: string;
    /** Archived by this run (auto-archive on). */
    archived: string[];
    /** Low-priority mail of the archive categories the run did NOT archive (auto-archive off): a proposal. */
    archiveProposed: string[];
    /** IMAP / POP3 mail left out: its protection level keeps it on local models, and the triage models are not local. */
    protected?: number;
  };
}

export class TriageBusyError extends Error {}

/** One run per user, in memory: a restart ends it, and the answers given until then are already stored. */
const runs = new Map<string, { run: TriageRun; abort: AbortController }>();
export const currentTriageRun = (userId: string): TriageRun | null => runs.get(userId)?.run ?? null;

export function cancelTriageRun(userId: string): boolean {
  const entry = runs.get(userId);
  if (!entry || entry.run.finished) return false;
  entry.abort.abort();
  return true;
}

export interface TriageRunRequest {
  /** The rows to triage, as the page shows them (one mailbox: `startTriageRun(userId, provider, …)`). */
  items?: InboxItem[];
  /** Instead of `items`: the newest N mails of each inbox, narrowed by the scope. */
  newest?: number;
  scope?: TriageScope;
}

/** What a mailbox gives a run: its mail, minus what its protection level keeps from the models. */
export interface SourceMail { items: InboxItem[]; protected?: number }

/** One mailbox of a run. */
export interface TriageSource {
  mailbox: MailboxKey;
  /** The account of a Google / Microsoft mailbox (null: its default; absent: the request's own). */
  selection?: MailboxSelection | null;
  /** The rows to triage. Absent: the newest of the inbox. */
  items?: InboxItem[];
  /** Mail kept out before the run (IMAP: protection level). */
  protected?: number;
  /** IMAP / POP3: reads the newest received mail through the request's scope. Google / Microsoft are read here. */
  newest?: (limit: number) => Promise<SourceMail>;
}

/** The newest `limit` inbox mails, over as many pages as that takes. */
async function newestInbox(userId: string, provider: EmailProvider, limit: number, signal: AbortSignal): Promise<InboxItem[]> {
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  let token: string | undefined;
  do {
    if (signal.aborted) throw new TriageCancelledError();
    const page = await listMessages(userId, provider, { folder: 'inbox', limit: Math.min(50, limit - items.length), pageToken: token }, true);
    for (const it of page.items) if (!seen.has(it.id) && items.length < limit) { seen.add(it.id); items.push(it); }
    token = page.nextPageToken;
    if (!page.items.length) break;
  } while (token && items.length < limit);
  return items;
}

/** The mail of one source a run takes. */
async function gather(userId: string, source: TriageSource, request: TriageRunRequest, scope: TriageScope, signal: AbortSignal): Promise<SourceMail> {
  if (source.items) return { items: source.items, protected: source.protected };
  const limit = Math.min(Math.max(request.newest ?? 30, 1), 500);
  const read: SourceMail = source.newest
    ? await source.newest(limit)
    : isImapMailbox(source.mailbox) ? { items: [] } : { items: await newestInbox(userId, source.mailbox, limit, signal) };
  const triaged = scope === 'untriaged' ? new Set(Object.keys(await storedTriage(userId, source.mailbox, read.items.map(it => it.id)))) : new Set<string>();
  const keep = new Set(inScope(read.items, scope, triaged));
  return { items: read.items.filter(it => keep.has(it.id)), protected: read.protected };
}

export interface TriageOutcome {
  triage: Record<string, EmailTriage>;
  labeled: number;
  labelError?: string;
  archived: string[];
  archiveProposed: string[];
}

/**
 * After triage of one mailbox: its category labels and archiving, as the
 * settings say. Google / Microsoft only; an IMAP / POP3 mailbox has neither.
 */
export async function applyOutcome(userId: string, mailbox: MailboxKey, triage: Record<string, EmailTriage>, settings: TriageSettings): Promise<TriageOutcome> {
  if (isImapMailbox(mailbox)) return { triage, labeled: 0, archived: [], archiveProposed: [] };
  // Label first: an archived mail still gets its category label. A label
  // failure (a token without label scope) must not lose the triage.
  let labeled = 0;
  let labelError: string | undefined;
  if (settings.applyLabels) {
    try { labeled = await applyCategoryLabels(userId, mailbox, triage); }
    catch (err) { labelError = String((err as Error)?.message ?? err).slice(0, 200); }
  }
  const archived = settings.autoArchive ? await autoArchive(userId, mailbox, triage, settings.archiveCategories) : [];
  const archiveProposed = settings.autoArchive ? [] : autoArchiveIds(triage, settings.archiveCategories);
  return { triage, labeled, ...(labelError ? { labelError } : {}), archived, archiveProposed };
}

/**
 * Start a triage run in the background with the user's saved settings, over
 * one mailbox (`provider` with `request.items` or `request.newest`) or several
 * (`sources`: "All inboxes"). Progress counts across all of them; each
 * mailbox's mail is triaged, labelled and archived in that mailbox.
 * Returns at once; follow it with currentTriageRun().
 */
export async function startTriageRun(userId: string, target: EmailProvider | TriageSource[], request: TriageRunRequest = {}): Promise<TriageRun> {
  if (runs.get(userId)?.run.finished === false) throw new TriageBusyError('A triage run is already in progress.');
  const sources: TriageSource[] = typeof target === 'string' ? [{ mailbox: target, items: request.items }] : target;
  const given = sources.every(s => s.items);
  // Reserve the slot before any await: two quick clicks must not start two runs.
  const run: TriageRun = { id: randomUUID(), total: given ? sources.reduce((n, s) => n + (s.items?.length ?? 0), 0) : (request.newest ?? 30) * sources.length, done: 0, stage: 'starting', startedAt: new Date().toISOString(), finished: false };
  const abort = new AbortController();
  runs.set(userId, { run, abort });
  void (async () => {
    const { settings } = await getTriageSettings(userId);
    const scope = request.scope ?? settings.scope;
    const mail: Array<{ source: TriageSource; items: InboxItem[] }> = [];
    let kept = 0;
    for (const source of sources) {
      if (abort.signal.aborted) throw new TriageCancelledError();
      const got = await inSource(source, () => gather(userId, source, request, scope, abort.signal));
      kept += got.protected ?? 0;
      if (got.items.length) mail.push({ source, items: got.items });
    }
    run.total = mail.reduce((n, m) => n + m.items.length, 0);
    let before = 0;
    const outcome: TriageOutcome = { triage: {}, labeled: 0, archived: [], archiveProposed: [] };
    for (const { source, items } of mail) {
      const offset = before;
      // Every provider call and stored row of this mailbox is in its own account.
      const triage = await inSource(source, () => triageInbox(userId, items, {
        instructions: settings.instructions,
        signal: abort.signal,
        onProgress: ({ stage, done }) => { run.stage = stage; run.done = offset + done; },
      }));
      before += items.length;
      run.stage = 'applying';
      const applied = await inSource(source, () => applyOutcome(userId, source.mailbox, triage, settings));
      Object.assign(outcome.triage, applied.triage);
      outcome.labeled += applied.labeled;
      if (applied.labelError) outcome.labelError = applied.labelError;
      outcome.archived.push(...applied.archived);
      outcome.archiveProposed.push(...applied.archiveProposed);
    }
    run.done = run.total;
    run.result = { ...outcome, ...(kept ? { protected: kept } : {}) };
    run.stage = 'done';
  })().catch((err: unknown) => {
    if (err instanceof TriageCancelledError || abort.signal.aborted) { run.cancelled = true; return; }
    // Message only, capped: a provider error can echo the prompt (mail metadata).
    run.error = String((err as Error)?.message ?? err).slice(0, 300);
    coreLogger.warn({ error: run.error.slice(0, 200) }, 'email: triage run failed');
  }).finally(() => {
    run.finished = true;
    // The lists a page shows next carry the new triage and miss what was archived.
    invalidateEmailCache(userId);
  });
  return run;
}
