/**
 * Snooze: a conversation leaves the inbox until a chosen time, then comes
 * back unread, on top.
 *
 * Snoozing archives the messages in the mailbox (Gmail: the INBOX label off;
 * Outlook: moved to Archive) and keeps a row in `email_snoozes` with when to
 * wake them and what the Snoozed list shows meanwhile. The cron tick wakes
 * what is due (wakeDueSnoozes): back to the inbox, marked unread, row gone. A
 * wake that fails is tried again later, waiting longer each time (up to six
 * hours), and the Snoozed list shows why.
 *
 * Outlook gives a message a new id when it moves; the row keeps the ids the
 * messages have while archived, which is what the wake needs. The row names
 * the account by its address, the default account too, so a later change of
 * the default does not send the wake to another mailbox.
 */
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type EmailSnooze, emailSnoozes } from '@/db/schema/email-snoozes';
import { coreLogger } from '@/utils/logger';
import { invalidateEmailCache } from './mailbox';
import { inMailbox, selectedAccount } from './account-context';
import { gmailApi, graphApi } from './providers';
import type { EmailAddress, EmailProvider } from './types';

export class SnoozeInputError extends Error {}

/** A snooze must end at least a minute from now and within a year. */
export const SNOOZE_MIN_MS = 60_000;
export const SNOOZE_MAX_MS = 366 * 24 * 60 * 60_000;
/** Messages of one conversation taken out at once. */
export const SNOOZE_MAX_MESSAGES = 100;
/** Rows one tick wakes at most; the rest wait for the next tick. */
export const WAKE_BATCH = 100;

/** How long to wait before trying a failed wake again: 1, 2, 4 … minutes, at most six hours. Pure. */
export function wakeBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Check a requested wake time. Pure. */
export function checkWakeAt(raw: string, now = Date.now()): Date {
  const at = new Date(raw);
  if (!Number.isFinite(+at)) throw new SnoozeInputError('Choose a valid time to snooze until.');
  if (+at - now < SNOOZE_MIN_MS) throw new SnoozeInputError('Choose a time at least a minute from now.');
  if (+at - now > SNOOZE_MAX_MS) throw new SnoozeInputError('Choose a time within the next year.');
  return at;
}

export interface SnoozeView {
  id: string;
  provider: EmailProvider;
  /** The account of the provider, when it is not the default one. */
  account?: string;
  messageIds: string[];
  threadId?: string;
  from: EmailAddress;
  subject: string;
  snippet: string;
  wakeAt: string;
  /** Set when waking failed; it is tried again at `retryAt`. */
  error?: string;
  retryAt?: string;
  /** Waking failed too often and is no longer tried: bring it back by hand, or let it go. */
  gaveUp?: boolean;
}

export const snoozeView = (row: EmailSnooze): SnoozeView => ({
  id: row.id,
  provider: row.provider as EmailProvider,
  ...(row.account ? { account: row.account } : {}),
  messageIds: row.messageIds,
  ...(row.threadId ? { threadId: row.threadId } : {}),
  from: { email: row.fromEmail, ...(row.fromName ? { name: row.fromName } : {}) },
  subject: row.subject,
  snippet: row.snippet,
  wakeAt: row.wakeAt.toISOString(),
  ...(row.lastError ? { error: row.lastError } : {}),
  ...(row.lastError && row.nextAttemptAt && !row.givenUpAt ? { retryAt: row.nextAttemptAt.toISOString() } : {}),
  ...(row.givenUpAt ? { gaveUp: true } : {}),
});

/** Where snoozes are kept; the default is the database, tests pass their own. */
export interface SnoozeStore {
  insert(row: Omit<EmailSnooze, 'id' | 'createdAt' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'givenUpAt'>): Promise<EmailSnooze>;
  list(userId: string, provider?: EmailProvider): Promise<EmailSnooze[]>;
  get(userId: string, id: string): Promise<EmailSnooze | null>;
  due(now: Date, limit: number): Promise<EmailSnooze[]>;
  remove(id: string): Promise<void>;
  /** What is still to be brought back (the rest already is: never moved twice). */
  progress(id: string, messageIds: string[]): Promise<void>;
  failed(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  gaveUp(id: string, attempts: number, error: string, at: Date): Promise<void>;
}

export const dbSnoozeStore: SnoozeStore = {
  async insert(row) {
    const [saved] = await getDb().insert(emailSnoozes).values(row).returning();
    return saved;
  },
  list: (userId, provider) => getDb().select().from(emailSnoozes)
    .where(and(eq(emailSnoozes.userId, userId), provider ? eq(emailSnoozes.provider, provider) : undefined))
    .orderBy(asc(emailSnoozes.wakeAt)),
  async get(userId, id) {
    const [row] = await getDb().select().from(emailSnoozes).where(and(eq(emailSnoozes.userId, userId), eq(emailSnoozes.id, id)));
    return row ?? null;
  },
  due: (now, limit) => getDb().select().from(emailSnoozes)
    .where(and(lte(emailSnoozes.wakeAt, now), isNull(emailSnoozes.givenUpAt), or(isNull(emailSnoozes.nextAttemptAt), lte(emailSnoozes.nextAttemptAt, now))))
    .orderBy(asc(emailSnoozes.wakeAt)).limit(limit),
  async remove(id) {
    await getDb().delete(emailSnoozes).where(eq(emailSnoozes.id, id));
  },
  async progress(id, messageIds) {
    await getDb().update(emailSnoozes).set({ messageIds }).where(eq(emailSnoozes.id, id));
  },
  async failed(id, attempts, nextAttemptAt, error) {
    await getDb().update(emailSnoozes).set({ attempts, nextAttemptAt, lastError: error }).where(eq(emailSnoozes.id, id));
  },
  async gaveUp(id, attempts, error, at) {
    await getDb().update(emailSnoozes).set({ attempts, lastError: error, givenUpAt: at, nextAttemptAt: null }).where(eq(emailSnoozes.id, id));
  },
};

/** An error's text without provider detail or mail content. */
const safeError = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);
/** The provider says the message is not there (deleted, or already moved and renamed): nothing left to do for it. */
const gone = (err: unknown) => /HTTP 404/.test(String((err as Error)?.message ?? err));

/** Wake attempts before giving up: with the backoff that is about a day and a half of trying. */
export const MAX_WAKE_ATTEMPTS = 12;

/** What a move of several messages did: the ids moved (as they are now), the ids not moved, and why. */
interface MoveResult { moved: string[]; left: string[]; error?: unknown }

/** Take messages out of the inbox, as far as it goes. Outlook gives a moved message a new id; `moved` has those. */
async function archive(userId: string, provider: EmailProvider, ids: string[]): Promise<MoveResult> {
  if (provider === 'google') {
    try {
      await gmailApi(userId, 'POST', '/messages/batchModify', { ids, removeLabelIds: ['INBOX'] });
      return { moved: ids, left: [] };
    } catch {
      // One by one, so that one message that cannot be changed does not hold back the rest.
      return oneByOne(ids, async (id) => { await gmailApi(userId, 'POST', `/messages/${encodeURIComponent(id)}/modify`, { removeLabelIds: ['INBOX'] }); return id; }, false);
    }
  }
  return oneByOne(ids, async (id) => {
    const answer = (await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: 'archive' })) as { id?: unknown };
    return typeof answer?.id === 'string' && answer.id ? answer.id : id;
  }, false);
}

/** Put messages back in the inbox, unread if asked. A message the provider no longer has counts as done. */
async function restore(userId: string, provider: EmailProvider, ids: string[], unread: boolean): Promise<MoveResult> {
  const labels = unread ? ['INBOX', 'UNREAD'] : ['INBOX'];
  if (provider === 'google') {
    try {
      await gmailApi(userId, 'POST', '/messages/batchModify', { ids, addLabelIds: labels });
      return { moved: ids, left: [] };
    } catch {
      // A deleted id fails the whole batch: one by one, the others still come back.
      return oneByOne(ids, async (id) => { await gmailApi(userId, 'POST', `/messages/${encodeURIComponent(id)}/modify`, { addLabelIds: labels }); return id; }, true);
    }
  }
  return oneByOne(ids, async (id) => {
    const answer = (await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: 'inbox' })) as { id?: unknown };
    const now = typeof answer?.id === 'string' && answer.id ? answer.id : id;
    // Moved is what counts: a failed "unread" mark must not move it again.
    if (unread) await graphApi(userId, 'PATCH', `/me/messages/${encodeURIComponent(now)}`, { isRead: false }).catch(() => {});
    return now;
  }, true);
}

async function oneByOne(ids: string[], move: (id: string) => Promise<string>, goneIsDone: boolean): Promise<MoveResult> {
  const result: MoveResult = { moved: [], left: [] };
  for (const id of ids) {
    try {
      result.moved.push(await move(id));
    } catch (err) {
      if (goneIsDone && gone(err)) continue;
      result.left.push(id);
      result.error ??= err;
    }
  }
  return result;
}

/** The address of the provider's default account (the account a request without one means). */
async function defaultAccount(userId: string, provider: EmailProvider): Promise<string | null> {
  const { getOAuthManager } = await import('@/security/oauth');
  const accounts = await getOAuthManager().listAccounts(userId, provider).catch(() => []);
  return accounts.find((a) => a.isDefault)?.account ?? null;
}

export interface SnoozeRequest {
  ids: string[];
  wakeAt: string;
  threadId?: string;
  from: EmailAddress;
  subject: string;
  snippet: string;
}

export class SnoozePartialError extends Error {}

/**
 * Snooze a conversation: archive it now, wake it at `wakeAt`. Mail is never
 * left archived without a row to bring it back: what could be moved is
 * snoozed, and the rest stays in the inbox (SnoozePartialError says so).
 */
export async function snooze(userId: string, provider: EmailProvider, request: SnoozeRequest, store: SnoozeStore = dbSnoozeStore, now = Date.now()): Promise<SnoozeView> {
  const ids = [...new Set(request.ids)];
  if (ids.length === 0) throw new SnoozeInputError('Nothing to snooze.');
  if (ids.length > SNOOZE_MAX_MESSAGES) throw new SnoozeInputError(`At most ${SNOOZE_MAX_MESSAGES} messages at once.`);
  const wakeAt = checkWakeAt(request.wakeAt, now);
  // The real address, also for the default account: the default can change before the mail wakes.
  const account = selectedAccount(provider) ?? await defaultAccount(userId, provider);
  const { moved, left, error } = await archive(userId, provider, ids);
  invalidateEmailCache(userId);
  if (moved.length === 0) throw error instanceof Error ? error : new Error(safeError(error));
  let row: EmailSnooze;
  try {
    row = await store.insert({
      userId, provider, account, messageIds: moved, threadId: request.threadId ?? null,
      fromEmail: request.from.email.slice(0, 320), fromName: request.from.name?.slice(0, 320) ?? null,
      subject: request.subject.slice(0, 500), snippet: request.snippet.slice(0, 300), wakeAt,
    });
  } catch (err) {
    // No row, no wake: put the mail back now rather than lose it in the archive.
    await restore(userId, provider, moved, false).catch(() => null);
    throw err;
  }
  coreLogger.info({ userId, provider, messages: moved.length, notMoved: left.length }, 'email: conversation snoozed');
  const view = await viewFor(userId, row);
  if (left.length) throw Object.assign(new SnoozePartialError(`${moved.length} of ${ids.length} messages were snoozed; the other ${left.length} could not be moved and stay in the inbox.`), { snoozed: view });
  return view;
}

/** Defaults per provider, asked once per call. */
function defaults(userId: string) {
  const known = new Map<string, Promise<string | null>>();
  return (provider: EmailProvider) => {
    if (!known.has(provider)) known.set(provider, defaultAccount(userId, provider));
    return known.get(provider)!;
  };
}

/** A row as the page sees it: `account` only for a further account, as everywhere else on the page. */
async function viewFor(userId: string, row: EmailSnooze, defaultOf = defaults(userId)): Promise<SnoozeView> {
  const view = snoozeView(row);
  if (row.account && row.account === await defaultOf(row.provider as EmailProvider)) delete view.account;
  return view;
}

/** Every snooze of the user; with `provider`, that mailbox's only (the account the request chose). */
export const listSnoozed = async (userId: string, provider?: EmailProvider, store: SnoozeStore = dbSnoozeStore): Promise<SnoozeView[]> => {
  const defaultOf = defaults(userId);
  const views = await Promise.all((await store.list(userId, provider)).map((row) => viewFor(userId, row, defaultOf)));
  if (!provider) return views;
  const account = selectedAccount(provider);
  return views.filter((view) => view.account === account);
};

/** Run `fn` in the account a snooze was made in: its mail is moved back there, with that account's token. */
const inAccountOf = <T>(row: Pick<EmailSnooze, 'provider' | 'account'>, fn: () => Promise<T>): Promise<T> =>
  inMailbox(row.account ? { provider: row.provider as EmailProvider, account: row.account } : null, fn);

/** Bring a snoozed conversation back now, on the owner's word (not marked unread: they just chose it). */
export async function unsnooze(userId: string, id: string, store: SnoozeStore = dbSnoozeStore): Promise<boolean> {
  const row = await store.get(userId, id);
  if (!row) return false;
  const { left, error } = await inAccountOf(row, () => restore(userId, row.provider as EmailProvider, row.messageIds, false));
  invalidateEmailCache(userId);
  if (left.length) {
    await store.progress(row.id, left);
    throw new Error(`${left.length} of ${row.messageIds.length} messages could not be brought back: ${safeError(error)}`);
  }
  await store.remove(row.id);
  return true;
}

/** Let a snooze go without moving anything: the mail stays where it is (in the archive). */
export async function dismissSnooze(userId: string, id: string, store: SnoozeStore = dbSnoozeStore): Promise<boolean> {
  const row = await store.get(userId, id);
  if (!row) return false;
  await store.remove(row.id);
  return true;
}

/**
 * Wake what is due: back to the inbox, unread. What came back is struck from
 * the row at once, so a retry never moves a message twice (Outlook renames a
 * moved message, and the old id would answer 404). A failure waits and is
 * tried again; after MAX_WAKE_ATTEMPTS the row is given up and says so.
 */
export async function wakeDueSnoozes(now = new Date(), store: SnoozeStore = dbSnoozeStore): Promise<number> {
  let woke = 0;
  for (const row of await store.due(now, WAKE_BATCH)) {
    try {
      const { left, error } = await inAccountOf(row, () => restore(row.userId, row.provider as EmailProvider, row.messageIds, true));
      invalidateEmailCache(row.userId);
      if (left.length === 0) {
        await store.remove(row.id);
        woke++;
        continue;
      }
      if (left.length < row.messageIds.length) await store.progress(row.id, left);
      throw error instanceof Error ? error : new Error(safeError(error));
    } catch (err) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        await store.gaveUp(row.id, attempts, safeError(err), now);
        coreLogger.warn({ userId: row.userId, provider: row.provider, attempts }, 'email: gave up waking a snoozed conversation');
      } else {
        await store.failed(row.id, attempts, new Date(+now + wakeBackoffMs(attempts)), safeError(err));
        coreLogger.warn({ userId: row.userId, provider: row.provider, attempts, error: safeError(err) }, 'email: a snoozed conversation could not be woken; trying again later');
      }
    }
  }
  return woke;
}
