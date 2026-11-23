/**
 * Automatic triage (docs/EMAIL-TRIAGE.md): for each user who turned it on,
 * new inbox mail is triaged with their saved settings, without anyone
 * pressing "Triage inbox".
 *
 * - **What:** mail that arrived since automatic triage was turned on and has
 *   no triage yet, in every connected Google / Microsoft account of the user
 *   and their personal IMAP / POP3 mailboxes. A space's shared mailbox is triaged by
 *   hand only: whose run would it be?
 * - **How much:** each user is looked at every AUTO_TRIAGE_EVERY_MS, at most
 *   AUTO_TRIAGE_MAX mails per look. A mail the models gave no answer for is
 *   not tried again in this process.
 * - **Failures** wait twice as long each time, up to AUTO_TRIAGE_MAX_BACKOFF_MS.
 * - **Never** while that user's own run is going, nor without a model that
 *   can answer. Labels and archiving follow the saved settings, as for a
 *   run started by hand (archiving only when the owner turned it on).
 * - The last run that triaged something or failed is kept on the settings
 *   (`lastAuto`) for the Triage window to show.
 *
 * Runs from the cron tick while the inbox module is on (job `inbox-auto-triage`).
 */
import { sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { contentRepos } from '@/db/repositories/content';
import { users } from '@/db/schema/users';
import { backgroundUserPrincipal } from '@/core/tasks/sourced';
import { coreLogger } from '@/utils/logger';
import { newestImap } from './imap-mailbox';
import { connectedProviders } from './providers';
import { listMessages } from './mailbox';
import { triageInbox, triageLlmModel } from './service';
import { storedTriage } from './triage-labels';
import { inSource, keepForTriage } from './triage-sources';
import type { MailboxSelection } from './account-context';
import { getOAuthManager } from '@/security/oauth';
import { applyOutcome, currentTriageRun, getTriageSettings, type LastAutoTriage, recordAutoTriage, type SourceMail, type TriageOutcome, type TriageSettings } from './triage-run';
import { type EmailTriage, imapMailbox, type InboxItem, type MailboxKey } from './types';

/** How often one user's mailboxes are looked at. */
export const AUTO_TRIAGE_EVERY_MS = 5 * 60_000;
/** The most mails one look triages, over all of a user's mailboxes. */
export const AUTO_TRIAGE_MAX = 20;
/** How many of the newest inbox mails of each mailbox a look reads. */
export const AUTO_TRIAGE_LOOK = 25;
/** The longest wait after failures. */
export const AUTO_TRIAGE_MAX_BACKOFF_MS = 60 * 60_000;
/** Mails remembered as tried, per user (oldest forgotten first). */
const TRIED_MAX = 500;

export interface AutoSource {
  mailbox: MailboxKey;
  /** A Google / Microsoft account: null for the default one, the account for a further one. Absent for IMAP. */
  selection?: MailboxSelection | null;
  newest: (limit: number) => Promise<SourceMail>;
}

/** One mailbox's key in the "tried" list: two accounts of one provider are two mailboxes. */
const sourceKey = (source: Pick<AutoSource, 'mailbox' | 'selection'>) => (source.selection ? `${source.mailbox}:${source.selection.account}` : source.mailbox);

export interface AutoTriageDeps {
  /** Users with automatic triage on, and since when. */
  users: () => Promise<Array<{ id: string; since: string | null }>>;
  sources: (userId: string) => Promise<AutoSource[]>;
  /** Of `ids`, those that already have a triage (the owner's or a model's). */
  triaged: (userId: string, mailbox: MailboxKey, ids: string[]) => Promise<Set<string>>;
  /** A model can answer for this user (the everyday lane is bound to one that can). */
  modelReady: (userId: string) => Promise<boolean>;
  /** The user's own run is going. */
  busy: (userId: string) => boolean;
  settings: (userId: string) => Promise<TriageSettings>;
  triage: (userId: string, items: InboxItem[], settings: TriageSettings) => Promise<Record<string, EmailTriage>>;
  apply: (userId: string, mailbox: MailboxKey, triage: Record<string, EmailTriage>, settings: TriageSettings) => Promise<TriageOutcome>;
  record: (userId: string, lastAuto: LastAutoTriage) => Promise<void>;
}

interface UserState { nextAt: number; failures: number; tried: string[]; lastError?: string }
const state = new Map<string, UserState>();

/** Forget every user's schedule (tests). */
export function resetAutoTriage(): void { state.clear(); }

/** When a user is looked at next after `failures` failures in a row. Pure. */
export function nextLook(now: number, failures: number): number {
  return now + (failures === 0 ? AUTO_TRIAGE_EVERY_MS : Math.min(AUTO_TRIAGE_EVERY_MS * 2 ** failures, AUTO_TRIAGE_MAX_BACKOFF_MS));
}

export type AutoTriageResult = 'waiting' | 'busy' | 'no-model' | 'idle' | 'ran' | 'failed';

/** One look at one user's mailboxes. */
export async function autoTriageUser(userId: string, since: string | null, now: Date, deps: AutoTriageDeps): Promise<{ result: AutoTriageResult; triaged: number }> {
  const st = state.get(userId) ?? { nextAt: 0, failures: 0, tried: [] };
  state.set(userId, st);
  const at = now.getTime();
  if (st.nextAt > at) return { result: 'waiting', triaged: 0 };
  // The owner's own run first; this look comes back on the next tick.
  if (deps.busy(userId)) return { result: 'busy', triaged: 0 };
  if (!(await deps.modelReady(userId).catch(() => false))) {
    st.nextAt = nextLook(at, 0);
    const error = 'No model can triage: bind an API or local model to the everyday lane.';
    if (st.lastError !== error) {
      st.lastError = error;
      await deps.record(userId, { at: now.toISOString(), triaged: 0, archived: 0, error }).catch(() => {});
    }
    return { result: 'no-model', triaged: 0 };
  }
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const tried = new Set(st.tried);
  let triaged = 0;
  let archived = 0;
  let skipped = 0;
  try {
    const settings = await deps.settings(userId);
    const work: Array<{ source: AutoSource; items: InboxItem[] }> = [];
    let budget = AUTO_TRIAGE_MAX;
    for (const source of await deps.sources(userId)) {
      if (budget <= 0) break;
      // Everything about a mailbox runs in its account: reading, what is already triaged, triage, labels.
      const read = await inSource(source, () => source.newest(AUTO_TRIAGE_LOOK));
      skipped += read.protected ?? 0;
      const fresh = read.items.filter((it) => !tried.has(`${sourceKey(source)}|${it.id}`)
        && (!Number.isFinite(sinceMs) || !it.receivedAt || Date.parse(it.receivedAt) >= sinceMs));
      if (!fresh.length) continue;
      const done = await inSource(source, () => deps.triaged(userId, source.mailbox, fresh.map((it) => it.id)));
      const items = fresh.filter((it) => !done.has(it.id)).slice(0, budget);
      if (!items.length) continue;
      budget -= items.length;
      work.push({ source, items });
    }
    if (!work.length) {
      st.failures = 0;
      st.nextAt = nextLook(at, 0);
      return { result: 'idle', triaged: 0 };
    }
    for (const { source, items } of work) {
      const mailbox = source.mailbox;
      const answers = await inSource(source, () => deps.triage(userId, items, settings));
      const outcome = await inSource(source, () => deps.apply(userId, mailbox, answers, settings));
      triaged += Object.keys(answers).length;
      archived += outcome.archived.length;
      // Tried, answered or not: a mail the models skip is not sent again and again.
      for (const it of items) st.tried.push(`${sourceKey(source)}|${it.id}`);
    }
    st.tried = st.tried.slice(-TRIED_MAX);
    st.failures = 0;
    st.lastError = undefined;
    st.nextAt = nextLook(at, 0);
    await deps.record(userId, { at: now.toISOString(), triaged, archived, ...(skipped ? { skipped } : {}) }).catch(() => {});
    return { result: 'ran', triaged };
  } catch (err) {
    st.failures += 1;
    st.nextAt = nextLook(at, st.failures);
    // Message only, capped: a provider error can echo mail metadata.
    const error = String((err as Error)?.message ?? err).slice(0, 200);
    st.lastError = error;
    coreLogger.warn({ userId, failures: st.failures, error }, 'email: automatic triage failed');
    await deps.record(userId, { at: now.toISOString(), triaged, archived, ...(skipped ? { skipped } : {}), error }).catch(() => {});
    return { result: 'failed', triaged };
  }
}

/** One look at every user with automatic triage on. Returns the mails triaged. */
export async function autoTriageTick(now = new Date(), deps: AutoTriageDeps = defaultAutoTriageDeps): Promise<number> {
  let total = 0;
  for (const user of await deps.users()) {
    total += (await autoTriageUser(user.id, user.since, now, deps)).triaged;
  }
  return total;
}

export const defaultAutoTriageDeps: AutoTriageDeps = {
  users: async () => {
    const rows = await getDb().select({ id: users.id, preferences: users.preferences }).from(users)
      .where(sql`${users.preferences}->'emailTriage'->>'auto' = 'true'`);
    return rows.map((r) => ({ id: r.id, since: r.preferences?.emailTriage?.autoSince ?? null }));
  },
  sources: async (userId) => {
    // Every connected account of each provider; each is read and triaged in its own account.
    const sources: AutoSource[] = [];
    for (const provider of await connectedProviders(userId)) {
      const accounts = await getOAuthManager().listAccounts(userId, provider).catch(() => []);
      const selections = accounts.length ? accounts.map((a): MailboxSelection | null => (a.isDefault || !a.account ? null : { provider, account: a.account })) : [null];
      for (const selection of selections) {
        sources.push({ mailbox: provider, selection, newest: async (limit) => ({ items: (await listMessages(userId, provider, { folder: 'inbox', limit }, true)).items }) });
      }
    }
    // The user's own IMAP / POP3 mailboxes; a space's shared mailbox is triaged by hand.
    const repos = contentRepos(backgroundUserPrincipal(userId));
    // The email channel's mailbox is the channel's alone (docs/CHANNELS.md#email):
    // a mail it answers is never also triaged or archived.
    const channelMailbox = getConfig().emailChannel.enabled ? getConfig().emailChannel.accountId : '';
    for (const account of await repos.mail.accounts()) {
      if (!account.enabled || account.workspaceId || account.id === channelMailbox) continue;
      sources.push({ mailbox: imapMailbox(account.id), newest: async (limit) => keepForTriage(userId, await newestImap(repos, account.id, limit)) });
    }
    return sources;
  },
  triaged: async (userId, mailbox, ids) => new Set(Object.keys(await storedTriage(userId, mailbox, ids))),
  modelReady: async (userId) => triageLlmModel(userId).then(() => true, () => false),
  busy: (userId) => currentTriageRun(userId)?.finished === false,
  settings: async (userId) => (await getTriageSettings(userId)).settings,
  triage: (userId, items, settings) => triageInbox(userId, items, { instructions: settings.instructions }),
  apply: applyOutcome,
  record: recordAutoTriage,
};
