/**
 * Mail accounts and their messages through one `RepoScope` (docs/MAIL.md),
 * like `CaseRepo`: every read uses the scope's filter, every write stamps the
 * scope's author and workspace and checks the scope's `can`. Personally that
 * is the owner's own mailboxes; in a space the functional mailboxes every
 * member reads, set up by the space's owners (`manage_space`) and written
 * from (drafts, sends, read marks) by its editors. A guest reaches none.
 *
 * There is no admin by-id read: a personal mailbox is its owner's alone.
 * The sync (core/mail/sync.ts) writes received mail outside any scope.
 */
import { and, desc, eq, getTableColumns, ilike, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import type { MailStatus } from '@/shared/mail';
import { getDb } from '../postgres';
import { type MailAccount, mailAccounts, type MailMessage, mailMessages, mailRaw, type NewMailAccount, type NewMailMessage } from '../schema/mail';
import { isUuid, type RepoScope } from './scoped';

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** An account write: the author, workspace, sync state and timestamps are the repository's. */
export type MailAccountWrite = Omit<NewMailAccount, 'id' | 'userId' | 'workspaceId' | 'syncState' | 'lastSyncAt' | 'lastError' | 'failures' | 'createdAt' | 'updatedAt'>;

/** A draft write: what the author composes. */
export type MailDraftWrite = Pick<NewMailMessage, 'toAddresses' | 'ccAddresses' | 'subject' | 'bodyText' | 'inReplyTo' | 'references'>;

export interface MailListFilter {
  accountId?: string;
  status?: MailStatus;
  /** Received mail only, unread only. */
  unread?: boolean;
  /** Matches subject, snippet and the sender. */
  q?: string;
  /** Messages older than this (a cursor: the last row's date and id). */
  before?: { date: Date; id: string };
  limit?: number;
}

/** A message row without its bodies, for lists. */
export type MailSummaryRow = Omit<MailMessage, 'bodyText' | 'bodyHtml'>;

/** A draft can be changed, sent or deleted only while it is not on its way. */
const EDITABLE: readonly MailStatus[] = ['draft', 'failed'];

export class MailRepo {
  constructor(private readonly scope: RepoScope) {}

  private get db() { return getDb(); }

  private accountRows(): SQL[] {
    return this.scope.shared(mailAccounts);
  }

  private messageRows(): SQL[] {
    return this.scope.shared(mailMessages);
  }

  /** Setting a mailbox up: personally the owner, in a space its owners. */
  private canManage(): void {
    if (this.scope.kind === 'space') this.scope.can('manage_space');
  }

  // ── Accounts ──────────────────────────────────────────────────────

  async accounts(): Promise<MailAccount[]> {
    return this.db.select().from(mailAccounts).where(and(...this.accountRows())).orderBy(mailAccounts.label);
  }

  async account(id: string): Promise<MailAccount | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(mailAccounts).where(and(eq(mailAccounts.id, id), ...this.accountRows())).limit(1);
    return row ?? null;
  }

  async createAccount(data: MailAccountWrite): Promise<MailAccount> {
    this.canManage();
    const stamp = { userId: this.scope.stamp().userId, workspaceId: await this.scope.writeWorkspace() };
    const [row] = await this.db.insert(mailAccounts).values({ ...data, ...stamp }).returning();
    return row;
  }

  /**
   * Change an account. A change of server, folder or protocol starts the
   * sync over (`syncState` cleared); messages already stored stay.
   */
  async updateAccount(id: string, patch: Partial<MailAccountWrite>, opts: { resetSync?: boolean } = {}): Promise<MailAccount | null> {
    this.canManage();
    if (!isUuid(id)) return null;
    const reset = opts.resetSync ? { syncState: {}, failures: 0, lastError: null } : {};
    const [row] = await this.db
      .update(mailAccounts)
      .set({ ...patch, ...reset, updatedAt: new Date() })
      .where(and(eq(mailAccounts.id, id), ...this.accountRows()))
      .returning();
    return row ?? null;
  }

  /** Remove an account and every message of it (cascade). */
  async deleteAccount(id: string): Promise<boolean> {
    this.canManage();
    if (!isUuid(id)) return false;
    const rows = await this.db.delete(mailAccounts).where(and(eq(mailAccounts.id, id), ...this.accountRows())).returning({ id: mailAccounts.id });
    return rows.length > 0;
  }

  // ── Messages ──────────────────────────────────────────────────────

  /** Newest first, without bodies. */
  async list(filter: MailListFilter = {}): Promise<MailSummaryRow[]> {
    const filters: SQL[] = [...this.messageRows()];
    if (filter.accountId) {
      if (!isUuid(filter.accountId)) return [];
      filters.push(eq(mailMessages.accountId, filter.accountId));
    }
    if (filter.status) filters.push(eq(mailMessages.status, filter.status));
    if (filter.unread) filters.push(eq(mailMessages.unread, true));
    const q = filter.q?.trim();
    if (q) {
      const pattern = likePattern(q);
      filters.push(or(
        ilike(mailMessages.subject, pattern),
        ilike(mailMessages.snippet, pattern),
        sql`${mailMessages.fromAddress}->>'address' ILIKE ${pattern}`,
        sql`${mailMessages.fromAddress}->>'name' ILIKE ${pattern}`,
      ) as SQL);
    }
    if (filter.before && isUuid(filter.before.id)) {
      filters.push(or(lt(mailMessages.date, filter.before.date), and(eq(mailMessages.date, filter.before.date), lt(mailMessages.id, filter.before.id))) as SQL);
    }
    return this.db
      .select(summaryColumns())
      .from(mailMessages)
      .where(and(...filters))
      .orderBy(desc(mailMessages.date), desc(mailMessages.id))
      .limit(Math.max(1, Math.min(200, filter.limit ?? 50)));
  }

  async message(id: string): Promise<MailMessage | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(mailMessages).where(and(eq(mailMessages.id, id), ...this.messageRows())).limit(1);
    return row ?? null;
  }

  /** Messages of the scope among `ids` (for case links). */
  async findByIds(ids: readonly string[]): Promise<MailSummaryRow[]> {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return [];
    return this.db.select(summaryColumns()).from(mailMessages).where(and(inArray(mailMessages.id, valid), ...this.messageRows()));
  }

  /** The raw source of a message the scope reaches; null when not kept. */
  async raw(id: string): Promise<Buffer | null> {
    const message = await this.message(id);
    if (!message) return null;
    const [row] = await this.db.select({ raw: mailRaw.raw }).from(mailRaw).where(eq(mailRaw.messageId, message.id)).limit(1);
    return row?.raw ?? null;
  }

  async setUnread(id: string, unread: boolean): Promise<MailMessage | null> {
    this.scope.can('write');
    if (!isUuid(id)) return null;
    const [row] = await this.db
      .update(mailMessages)
      .set({ unread, updatedAt: new Date() })
      .where(and(eq(mailMessages.id, id), eq(mailMessages.status, 'received'), ...this.messageRows()))
      .returning();
    return row ?? null;
  }

  // ── Drafts ────────────────────────────────────────────────────────

  /** A new draft in `account` (an account of this scope). */
  async createDraft(account: MailAccount, data: MailDraftWrite): Promise<MailMessage> {
    this.scope.can('write');
    if (!(await this.account(account.id))) throw new Error('Mail account not found');
    const now = new Date();
    const [row] = await this.db
      .insert(mailMessages)
      .values({
        ...data,
        accountId: account.id,
        userId: account.userId,
        workspaceId: account.workspaceId,
        status: 'draft',
        fromAddress: { address: account.address, ...(account.displayName ? { name: account.displayName } : {}) },
        snippet: data.bodyText ? data.bodyText.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
        authorId: this.scope.principal.userId,
        date: now,
      })
      .returning();
    return row;
  }

  /** Change a draft (or a failed send); null when it is not one any more. */
  async updateDraft(id: string, patch: Partial<MailDraftWrite>): Promise<MailMessage | null> {
    this.scope.can('write');
    if (!isUuid(id)) return null;
    const snippet = patch.bodyText !== undefined ? { snippet: (patch.bodyText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) } : {};
    const [row] = await this.db
      .update(mailMessages)
      .set({ ...patch, ...snippet, status: 'draft', error: null, date: new Date(), updatedAt: new Date() })
      .where(and(eq(mailMessages.id, id), inArray(mailMessages.status, [...EDITABLE]), ...this.messageRows()))
      .returning();
    return row ?? null;
  }

  async deleteDraft(id: string): Promise<boolean> {
    this.scope.can('write');
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(mailMessages)
      .where(and(eq(mailMessages.id, id), inArray(mailMessages.status, [...EDITABLE]), ...this.messageRows()))
      .returning({ id: mailMessages.id });
    return rows.length > 0;
  }

  /**
   * Take a draft for sending: `draft`/`failed` → `sending` in one statement,
   * so two sends of one draft cannot both go out. Null when the scope does
   * not reach it or it is already sending or sent.
   */
  async claimForSend(id: string): Promise<MailMessage | null> {
    this.scope.can('write');
    if (!isUuid(id)) return null;
    const [row] = await this.db
      .update(mailMessages)
      .set({ status: 'sending', error: null, authorId: this.scope.principal.userId, updatedAt: new Date() })
      .where(and(eq(mailMessages.id, id), inArray(mailMessages.status, [...EDITABLE]), ...this.messageRows()))
      .returning();
    return row ?? null;
  }
}

/** The columns of a message list: everything but the bodies. */
function summaryColumns() {
  const { bodyText: _text, bodyHtml: _html, ...columns } = getTableColumns(mailMessages);
  return columns;
}

/** After an SMTP send (claimed by `claimForSend`): sent, or failed with why. Outside the scope: the claim checked it. */
export async function finishSend(id: string, outcome: { sent: true; messageIdHeader: string } | { sent: false; error: string }): Promise<void> {
  const now = new Date();
  await getDb()
    .update(mailMessages)
    .set(outcome.sent
      ? { status: 'sent', messageIdHeader: outcome.messageIdHeader, date: now, error: null, updatedAt: now }
      : { status: 'failed', error: outcome.error.slice(0, 500), updatedAt: now })
    .where(and(eq(mailMessages.id, id), eq(mailMessages.status, 'sending')));
}
