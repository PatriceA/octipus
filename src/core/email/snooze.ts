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
 * messages have while archived, which is what the wake needs.
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
  ...(row.lastError && row.nextAttemptAt ? { retryAt: row.nextAttemptAt.toISOString() } : {}),
});

/** Where snoozes are kept; the default is the database, tests pass their own. */
export interface SnoozeStore {
  insert(row: Omit<EmailSnooze, 'id' | 'createdAt' | 'attempts' | 'nextAttemptAt' | 'lastError'>): Promise<EmailSnooze>;
  list(userId: string, provider?: EmailProvider): Promise<EmailSnooze[]>;
  get(userId: string, id: string): Promise<EmailSnooze | null>;
  due(now: Date, limit: number): Promise<EmailSnooze[]>;
  remove(id: string): Promise<void>;
  failed(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
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
    .where(and(lte(emailSnoozes.wakeAt, now), or(isNull(emailSnoozes.nextAttemptAt), lte(emailSnoozes.nextAttemptAt, now))))
    .orderBy(asc(emailSnoozes.wakeAt)).limit(limit),
  async remove(id) {
    await getDb().delete(emailSnoozes).where(eq(emailSnoozes.id, id));
  },
  async failed(id, attempts, nextAttemptAt, error) {
    await getDb().update(emailSnoozes).set({ attempts, nextAttemptAt, lastError: error }).where(eq(emailSnoozes.id, id));
  },
};

/** An error's text without provider detail or mail content. */
const safeError = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

/** Take messages out of the inbox. Returns the ids they have afterwards (Outlook moves change them). */
async function archive(userId: string, provider: EmailProvider, ids: string[]): Promise<string[]> {
  if (provider === 'google') {
    await gmailApi(userId, 'POST', '/messages/batchModify', { ids, removeLabelIds: ['INBOX'] });
    return ids;
  }
  const moved: string[] = [];
  for (const id of ids) {
    const answer = (await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: 'archive' })) as { id?: unknown };
    moved.push(typeof answer?.id === 'string' && answer.id ? answer.id : id);
  }
  return moved;
}

/** Put messages back in the inbox, unread if asked. */
async function restore(userId: string, provider: EmailProvider, ids: string[], unread: boolean): Promise<void> {
  if (provider === 'google') {
    await gmailApi(userId, 'POST', '/messages/batchModify', { ids, addLabelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'] });
    return;
  }
  for (const id of ids) {
    const answer = (await graphApi(userId, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: 'inbox' })) as { id?: unknown };
    const now = typeof answer?.id === 'string' && answer.id ? answer.id : id;
    if (unread) await graphApi(userId, 'PATCH', `/me/messages/${encodeURIComponent(now)}`, { isRead: false });
  }
}

export interface SnoozeRequest {
  ids: string[];
  wakeAt: string;
  threadId?: string;
  from: EmailAddress;
  subject: string;
  snippet: string;
}

/** Snooze a conversation: archive it now, wake it at `wakeAt`. */
export async function snooze(userId: string, provider: EmailProvider, request: SnoozeRequest, store: SnoozeStore = dbSnoozeStore, now = Date.now()): Promise<SnoozeView> {
  const ids = [...new Set(request.ids)];
  if (ids.length === 0) throw new SnoozeInputError('Nothing to snooze.');
  if (ids.length > SNOOZE_MAX_MESSAGES) throw new SnoozeInputError(`At most ${SNOOZE_MAX_MESSAGES} messages at once.`);
  const wakeAt = checkWakeAt(request.wakeAt, now);
  const archived = await archive(userId, provider, ids);
  invalidateEmailCache(userId);
  const row = await store.insert({
    userId, provider, account: selectedAccount(provider) ?? null, messageIds: archived, threadId: request.threadId ?? null,
    fromEmail: request.from.email.slice(0, 320), fromName: request.from.name?.slice(0, 320) ?? null,
    subject: request.subject.slice(0, 500), snippet: request.snippet.slice(0, 300), wakeAt,
  });
  coreLogger.info({ userId, provider, messages: archived.length }, 'email: conversation snoozed');
  return snoozeView(row);
}

/** Every snooze of the user; with `provider`, that mailbox's only (the account the request chose). */
export const listSnoozed = async (userId: string, provider?: EmailProvider, store: SnoozeStore = dbSnoozeStore): Promise<SnoozeView[]> => {
  const account = provider ? selectedAccount(provider) ?? null : undefined;
  return (await store.list(userId, provider)).filter((row) => account === undefined || (row.account ?? null) === account).map(snoozeView);
};

/** Run `fn` in the account a snooze was made in: its mail is moved back there, with that account's token. */
const inAccountOf = <T>(row: Pick<EmailSnooze, 'provider' | 'account'>, fn: () => Promise<T>): Promise<T> =>
  inMailbox(row.account ? { provider: row.provider as EmailProvider, account: row.account } : null, fn);

/** Bring a snoozed conversation back now, on the owner's word (not marked unread: they just chose it). */
export async function unsnooze(userId: string, id: string, store: SnoozeStore = dbSnoozeStore): Promise<boolean> {
  const row = await store.get(userId, id);
  if (!row) return false;
  await inAccountOf(row, () => restore(userId, row.provider as EmailProvider, row.messageIds, false));
  await store.remove(row.id);
  invalidateEmailCache(userId);
  return true;
}

/** Wake what is due: back to the inbox, unread. A failure waits and is tried again. Returns how many woke. */
export async function wakeDueSnoozes(now = new Date(), store: SnoozeStore = dbSnoozeStore): Promise<number> {
  let woke = 0;
  for (const row of await store.due(now, WAKE_BATCH)) {
    try {
      await inAccountOf(row, () => restore(row.userId, row.provider as EmailProvider, row.messageIds, true));
      await store.remove(row.id);
      invalidateEmailCache(row.userId);
      woke++;
    } catch (err) {
      const attempts = row.attempts + 1;
      await store.failed(row.id, attempts, new Date(+now + wakeBackoffMs(attempts)), safeError(err));
      coreLogger.warn({ userId: row.userId, provider: row.provider, attempts, error: safeError(err) }, 'email: a snoozed conversation could not be woken; trying again later');
    }
  }
  return woke;
}
