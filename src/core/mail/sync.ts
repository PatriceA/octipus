/**
 * Received mail into `mail_messages` (docs/MAIL.md#sync). The cron tick runs
 * `syncDueMailAccounts`: each enabled account whose last sync is older than
 * `SYNC_INTERVAL_MS` (spaced out after failures) is claimed, its source
 * opened with the stored password, and new messages fetched a batch at a
 * time and stored. Sync state moves forward only with what was stored.
 *
 * The sync acts for no user: it writes rows of the account's own scope
 * (author and workspace copied from the account), and nothing here logs an
 * address, subject or body.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type MailAccount, mailAccounts, mailMessages, mailRaw } from '@/db/schema/mail';
import { coreLogger } from '@/utils/logger';
import { mapLimit } from '@/utils/concurrency';
import { parseRawMessage } from './parse';
import { mailPassword } from './secrets';
import { type FetchedMessage, type MailSource, openSource } from './sources';

/** How often an account is synced. */
export const SYNC_INTERVAL_MS = 5 * 60_000;
/** The longest wait between attempts after failures. */
const MAX_BACKOFF_MS = 60 * 60_000;
/** How far back a first sync looks. */
export const FIRST_SYNC_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Messages per batch, and batches per account per sync. */
const BATCH = 50;
const MAX_BATCHES = 4;
/** Accounts one sweep takes, and how many sync at once. */
const SWEEP_LIMIT = 20;
const CONCURRENCY = 3;

export interface MailSyncDeps {
  open: (account: MailAccount, password: string) => Promise<MailSource>;
  password: (accountId: string) => Promise<string | null>;
}

const defaultDeps: MailSyncDeps = {
  open: openSource,
  password: (id) => mailPassword(id, 'incoming'),
};

/** Accounts synced in this process right now (a manual sync and the sweep never overlap). */
const running = new Set<string>();

export interface SyncResult {
  stored: number;
  more: boolean;
  error?: string;
}

/** Which of `remoteIds` the account already stores. */
async function knownRemoteIds(accountId: string, remoteIds: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < remoteIds.length; i += 1000) {
    const chunk = remoteIds.slice(i, i + 1000);
    const rows = await getDb()
      .select({ remoteId: mailMessages.remoteId })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId), inArray(mailMessages.remoteId, chunk)));
    for (const r of rows) if (r.remoteId) known.add(r.remoteId);
  }
  return known;
}

/** Store one received message; false when it was already there (same remote id or Message-ID). */
export async function storeReceived(account: MailAccount, fetched: FetchedMessage): Promise<boolean> {
  const parsed = await parseRawMessage(fetched.source);
  const note = fetched.truncated
    ? `[This message is ${Math.round(fetched.size / 1024 / 1024)} MB, too large to keep here. Open it in the mail client.]`
    : '';
  const text = note ? `${note}\n\n${parsed.text}`.trim() : parsed.text;
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(mailMessages)
      .values({
        accountId: account.id,
        userId: account.userId,
        workspaceId: account.workspaceId,
        status: 'received',
        remoteId: fetched.remoteId,
        messageIdHeader: parsed.messageIdHeader,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        fromAddress: parsed.from,
        replyTo: parsed.replyTo,
        toAddresses: parsed.to,
        ccAddresses: parsed.cc,
        subject: parsed.subject,
        snippet: note ? note : parsed.snippet,
        bodyText: text,
        bodyHtml: fetched.truncated ? null : parsed.html,
        attachments: fetched.truncated ? [] : parsed.attachments,
        unread: fetched.unread,
        date: fetched.receivedAt ?? parsed.date ?? new Date(),
        size: fetched.size,
      })
      .onConflictDoNothing()
      .returning({ id: mailMessages.id });
    if (!row) return false;
    if (!fetched.truncated) await tx.insert(mailRaw).values({ messageId: row.id, raw: fetched.source });
    return true;
  });
}

/**
 * Take the account for a sync: only if its last sync is the one we saw, so
 * two processes (or a sweep and a manual sync) do not both run it.
 */
async function claim(account: MailAccount, now: Date): Promise<boolean> {
  const seen = account.lastSyncAt;
  const rows = await getDb()
    .update(mailAccounts)
    .set({ lastSyncAt: now })
    .where(and(eq(mailAccounts.id, account.id), seen ? eq(mailAccounts.lastSyncAt, seen) : isNull(mailAccounts.lastSyncAt)))
    .returning({ id: mailAccounts.id });
  return rows.length > 0;
}

/** A failure as the account's owners see it: one line, no secrets (the password never is in it). */
function describe(err: unknown): string {
  const e = err as { message?: string; responseText?: string; authenticationFailed?: boolean; code?: string };
  if (e?.authenticationFailed) return 'The server refused the login';
  const text = e?.responseText || e?.message || String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'The mailbox could not be read';
}

/**
 * Sync one account now. Fetches up to `MAX_BATCHES` batches; what is left
 * waits for the next sync. Never throws: a failure is recorded on the account.
 */
export async function syncAccount(account: MailAccount, deps: MailSyncDeps = defaultDeps, now = new Date()): Promise<SyncResult> {
  if (running.has(account.id)) return { stored: 0, more: true, error: 'A sync of this mailbox is already running' };
  if (!(await claim(account, now))) return { stored: 0, more: true, error: 'A sync of this mailbox is already running' };
  running.add(account.id);
  let stored = 0;
  let more = false;
  let source: MailSource | null = null;
  let state = account.syncState;
  try {
    const password = await deps.password(account.id);
    if (!password) throw new Error('No password is stored for this mailbox');
    source = await deps.open(account, password);
    const since = new Date(now.getTime() - FIRST_SYNC_WINDOW_MS);
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await source.fetchNew(state, { since, limit: BATCH, known: (ids) => knownRemoteIds(account.id, ids) });
      for (const message of batch.messages) {
        if (await storeReceived(account, message)) stored++;
      }
      // Every message of the batch is stored: the state may move past them.
      state = batch.state;
      await getDb().update(mailAccounts).set({ syncState: state }).where(eq(mailAccounts.id, account.id));
      more = batch.more;
      if (!batch.more) break;
    }
    await getDb().update(mailAccounts).set({ lastError: null, failures: 0 }).where(eq(mailAccounts.id, account.id));
    return { stored, more };
  } catch (err) {
    const error = describe(err);
    coreLogger.warn({ accountId: account.id, error }, 'mail: sync failed');
    await getDb()
      .update(mailAccounts)
      .set({ lastError: error, failures: sql`${mailAccounts.failures} + 1` })
      .where(eq(mailAccounts.id, account.id));
    return { stored, more, error };
  } finally {
    running.delete(account.id);
    await source?.close().catch(() => undefined);
  }
}

/** Accounts due for a sync: enabled, last synced longer ago than the interval (doubled per failure, capped). */
async function dueAccounts(now: Date): Promise<MailAccount[]> {
  const wait = sql`least(${SYNC_INTERVAL_MS} * power(2, least(${mailAccounts.failures}, 6)), ${MAX_BACKOFF_MS}) * interval '1 millisecond'`;
  return getDb()
    .select()
    .from(mailAccounts)
    .where(and(
      eq(mailAccounts.enabled, true),
      or(isNull(mailAccounts.lastSyncAt), lt(mailAccounts.lastSyncAt, sql`${now.toISOString()}::timestamptz - ${wait}`)),
    ))
    .orderBy(sql`${mailAccounts.lastSyncAt} ASC NULLS FIRST`)
    .limit(SWEEP_LIMIT);
}

/** The cron tick's sweep: sync every due account. Returns how many messages were stored. */
export async function syncDueMailAccounts(now = new Date(), deps: MailSyncDeps = defaultDeps): Promise<number> {
  const due = await dueAccounts(now);
  if (due.length === 0) return 0;
  const results = await mapLimit(due, CONCURRENCY, (account) => syncAccount(account, deps, now));
  return results.reduce((sum, r) => sum + r.stored, 0);
}
