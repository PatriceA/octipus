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
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type MailAccount, mailAccounts, mailMessages, mailRaw } from '@/db/schema/mail';
import { coreLogger } from '@/utils/logger';
import { mapLimit } from '@/utils/concurrency';
import { ingestDocument } from '@/core/documents/ingest';
import { contentRepos } from '@/db/repositories/content';
import { writerPrincipal } from '@/security/writer-principal';
import { withDeadline } from './deadline';
import { attachmentsOf, parseRawMessage, storable } from './parse';
import { mailPassword, pruneOrphanMailPasswords } from './secrets';
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
/** The longest one account's sync may take, connection included. */
export const SYNC_DEADLINE_MS = 10 * 60_000;
/** A send still `sending` after this long was interrupted (a restart). */
const STUCK_SEND_MS = 15 * 60_000;
/** How often the sweep removes passwords whose account is gone. */
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPrune = 0;

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

/** What storing a fetched message did. */
export type StoreOutcome = 'stored' | 'duplicate';

/**
 * Store one received message: `duplicate` when the account already has it
 * (same remote id, or for received mail the same Message-ID). A message that
 * cannot be stored as it is (a value the database refuses) is stored as a
 * placeholder, so one bad message never blocks the mailbox behind it.
 */
export async function storeReceived(account: MailAccount, fetched: FetchedMessage): Promise<StoreOutcome> {
  try {
    return await insertReceived(account, fetched);
  } catch (err) {
    coreLogger.warn({ accountId: account.id, err: (err as Error).message }, 'mail: a message could not be stored; keeping a placeholder');
    const [row] = await getDb()
      .insert(mailMessages)
      .values({
        accountId: account.id,
        userId: account.userId,
        workspaceId: account.workspaceId,
        status: 'received',
        protectionLevel: account.defaultProtectionLevel,
        remoteId: storable(fetched.remoteId),
        subject: '(this message could not be stored; open it in the mail client)',
        unread: fetched.unread,
        date: fetched.receivedAt ?? new Date(),
        size: fetched.size,
      })
      .onConflictDoNothing()
      .returning({ id: mailMessages.id });
    return row ? 'stored' : 'duplicate';
  }
}

async function insertReceived(account: MailAccount, fetched: FetchedMessage): Promise<StoreOutcome> {
  const parsed = await parseRawMessage(fetched.source);
  const note = fetched.truncated
    ? `[This message is ${Math.round(fetched.size / 1024 / 1024)} MB, too large to keep here. Open it in the mail client.]`
    : '';
  const text = note ? `${note}\n\n${parsed.text}`.trim() : parsed.text;
  const id = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(mailMessages)
      .values({
        accountId: account.id,
        userId: account.userId,
        workspaceId: account.workspaceId,
        status: 'received',
        protectionLevel: account.defaultProtectionLevel,
        remoteId: storable(fetched.remoteId),
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
    if (!row) return null;
    if (!fetched.truncated) await tx.insert(mailRaw).values({ messageId: row.id, raw: fetched.source });
    return row.id;
  });
  if (!id) return 'duplicate';
  if (account.fileAttachments && !fetched.truncated && parsed.attachments.length > 0) {
    await fileMailAttachments(account, id, parsed.subject, fetched.source, [], account.defaultProtectionLevel);
  }
  return 'stored';
}

/**
 * File a received message's attachments into the documents of the
 * account's scope (a fax-to-mail or scanner-to-mail drop), written as the
 * account's author. Each attachment on its own: the ones filed are recorded
 * on the message (`filed_attachments`), the reason the rest are not in
 * `filing_error`, and those are tried again on later syncs
 * (`retryUnfiledAttachments`). The message itself is stored either way.
 * Returns whether every attachment is filed now.
 */
export async function fileMailAttachments(
  account: MailAccount, messageId: string, subject: string, raw: Buffer, alreadyFiled: readonly number[] = [],
  /** The message's level now: its attachments start there (a message raised since is not filed lower). */
  protectionLevel: number | null = account.defaultProtectionLevel,
): Promise<boolean> {
  const filed = new Set(alreadyFiled);
  let error: string | null = null;
  try {
    const principal = await writerPrincipal(account.userId, account.workspaceId);
    if (!principal) throw new Error('The account\'s author can no longer add documents here');
    const repos = contentRepos(principal);
    const attachments = await attachmentsOf(raw);
    for (const [index, attachment] of attachments.entries()) {
      if (filed.has(index)) continue;
      try {
        const result = await ingestDocument(repos, {
          buffer: attachment.content,
          originalName: attachment.filename,
          mimeType: attachment.contentType,
          protectionLevel,
          metadata: { source: 'mail', mailAccountId: account.id, mailMessageId: messageId, mailSubject: subject.slice(0, 200) },
        });
        // Stored but not queued is still filed: the document exists and says why.
        filed.add(index);
        if (result.error) error ??= result.error;
      } catch (err) {
        error ??= (err as Error).message;
      }
    }
    if (filed.size < attachments.length) error ??= 'Not every attachment could be filed';
    else error = null;
  } catch (err) {
    error = (err as Error).message;
  }
  if (error) coreLogger.warn({ accountId: account.id, messageId, error }, 'mail: attachment filing incomplete');
  await getDb()
    .update(mailMessages)
    .set({ filedAttachments: [...filed].sort((a, b) => a - b), filingError: error ? `An attachment could not be filed: ${error}`.slice(0, 300) : null })
    .where(eq(mailMessages.id, messageId));
  return error === null;
}

/** Messages whose attachments are not all filed yet, tried again (a few per sync). */
async function retryUnfiledAttachments(account: MailAccount): Promise<void> {
  if (!account.fileAttachments) return;
  const pending = await getDb()
    .select({ id: mailMessages.id, subject: mailMessages.subject, filed: mailMessages.filedAttachments, level: mailMessages.protectionLevel, raw: mailRaw.raw })
    .from(mailMessages)
    .innerJoin(mailRaw, eq(mailRaw.messageId, mailMessages.id))
    .where(and(eq(mailMessages.accountId, account.id), sql`${mailMessages.filingError} IS NOT NULL`))
    .limit(10);
  for (const m of pending) await fileMailAttachments(account, m.id, m.subject, m.raw, m.filed, m.level);
}

/** Why the account's attachments are not all filed, or null. */
async function filingProblem(accountId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ error: mailMessages.filingError })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), sql`${mailMessages.filingError} IS NOT NULL`))
    .orderBy(desc(mailMessages.date))
    .limit(1);
  return row?.error ?? null;
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
  const progress = { stored: 0, more: false };
  let source: MailSource | null = null;
  try {
    await withDeadline((async () => {
      const password = await deps.password(account.id);
      if (!password) throw new Error('No password is stored for this mailbox');
      source = await deps.open(account, password);
      await fetchBatches(account, source, now, progress);
      await retryUnfiledAttachments(account);
    })(), SYNC_DEADLINE_MS, 'The mail sync', () => (source as MailSource | null)?.destroy());
    // A sync that went well still says when attachments wait to be filed.
    await getDb().update(mailAccounts).set({ lastError: await filingProblem(account.id), failures: 0 }).where(eq(mailAccounts.id, account.id));
    return { ...progress };
  } catch (err) {
    const error = describe(err);
    coreLogger.warn({ accountId: account.id, error }, 'mail: sync failed');
    await getDb()
      .update(mailAccounts)
      .set({ lastError: error, failures: sql`${mailAccounts.failures} + 1` })
      .where(eq(mailAccounts.id, account.id));
    return { ...progress, error };
  } finally {
    running.delete(account.id);
    await (source as MailSource | null)?.close().catch(() => undefined);
  }
}

/**
 * Fetch and store up to `MAX_BATCHES` batches. After each batch the state
 * moves past what it held, unless the account was changed meanwhile (new
 * servers start over: an old server's state must not land on the new one).
 */
async function fetchBatches(account: MailAccount, source: MailSource, now: Date, progress: { stored: number; more: boolean }): Promise<void> {
  const since = new Date(now.getTime() - FIRST_SYNC_WINDOW_MS);
  let state = account.syncState;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await source.fetchNew(state, { since, limit: BATCH, known: (ids) => knownRemoteIds(account.id, ids) });
    const duplicates: string[] = [];
    for (const message of batch.messages) {
      if ((await storeReceived(account, message)) === 'stored') progress.stored++;
      else duplicates.push(message.remoteId);
    }
    state = batch.state;
    // A POP3 duplicate (same Message-ID, another UIDL) is stored under no
    // remote id: remember it, or it would be fetched again on every sync.
    if (account.protocol === 'pop3' && duplicates.length > 0) {
      state = { ...state, skipped: [...new Set([...(state.skipped ?? []), ...duplicates])] };
    }
    const saved = await getDb()
      .update(mailAccounts)
      .set({ syncState: state })
      .where(and(eq(mailAccounts.id, account.id), eq(mailAccounts.updatedAt, account.updatedAt)))
      .returning({ id: mailAccounts.id });
    progress.more = batch.more;
    if (saved.length === 0 || !batch.more) break;
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
      // An archived space reads only: its mailboxes rest.
      sql`NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${mailAccounts.workspaceId} AND w.archived_at IS NOT NULL)`,
      or(isNull(mailAccounts.lastSyncAt), lt(mailAccounts.lastSyncAt, sql`${now.toISOString()}::timestamptz - ${wait}`)),
    ))
    .orderBy(sql`${mailAccounts.lastSyncAt} ASC NULLS FIRST`)
    .limit(SWEEP_LIMIT);
}

/**
 * Sends still `sending` long after they started were cut off (a restart
 * between the claim and the outcome). Mark them failed, saying they may have
 * gone out, so the author can check before sending again.
 */
export async function reapStuckSends(now = new Date()): Promise<number> {
  const rows = await getDb()
    .update(mailMessages)
    .set({ status: 'failed', error: 'The send was interrupted and may have gone out. Check the Sent folder before sending it again.', updatedAt: now })
    .where(and(eq(mailMessages.status, 'sending'), lt(mailMessages.updatedAt, new Date(now.getTime() - STUCK_SEND_MS))))
    .returning({ id: mailMessages.id });
  return rows.length;
}

/** The cron tick's sweep: sync every due account. Returns how many messages were stored. */
export async function syncDueMailAccounts(now = new Date(), deps: MailSyncDeps = defaultDeps): Promise<number> {
  await reapStuckSends(now);
  if (now.getTime() - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = now.getTime();
    // Accounts removed with their space or their owner leave passwords behind.
    await pruneOrphanMailPasswords().catch((err: unknown) => coreLogger.warn({ err }, 'mail: password cleanup failed'));
  }
  const due = await dueAccounts(now);
  if (due.length === 0) return 0;
  const results = await mapLimit(due, CONCURRENCY, (account) => syncAccount(account, deps, now));
  return results.reduce((sum, r) => sum + r.stored, 0);
}
