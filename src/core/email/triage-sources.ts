/**
 * The mailboxes a triage run (or its preview) covers, checked before anything
 * is read: a Google / Microsoft mailbox must be connected, an IMAP / POP3
 * mailbox must be one the caller's scope reaches (core/email/imap-mailbox.ts).
 * IMAP mail is read from the store, never taken from what the client sent,
 * and mail whose protection level keeps it on local models is left out when
 * the triage models are not local.
 */
import type { ContentRepos } from '@/db/repositories/content';
import { effectiveLevel, imapAccount, imapAiRefusal, type ImapAiDeps, imapItemsByIds, type ImapTriageItem, newestImap } from './imap-mailbox';
import { resolveProvider } from './mailbox';
import type { SourceMail, TriageSource } from './triage-run';
import { type EmailAddress, imapAccountId, type InboxItem, isImapMailbox, isMailboxKey, type MailboxKey } from './types';

export class TriageSourceError extends Error {}

/** IMAP mail the triage models may read; the rest is counted, not sent. */
export async function keepForTriage(userId: string, rows: readonly ImapTriageItem[], deps?: ImapAiDeps): Promise<SourceMail> {
  const verdicts = new Map<number, boolean>();
  const items: InboxItem[] = [];
  let kept = 0;
  for (const row of rows) {
    const level = effectiveLevel(row.level);
    if (!verdicts.has(level)) verdicts.set(level, (await imapAiRefusal(userId, row.level, 'triage', deps)) === null);
    if (verdicts.get(level)) items.push(row.item); else kept++;
  }
  return { items, ...(kept ? { protected: kept } : {}) };
}

/** Is `key` a mailbox this caller may triage? Throws TriageSourceError when not. */
export async function checkMailbox(repos: ContentRepos, userId: string, key: string): Promise<MailboxKey> {
  if (!isMailboxKey(key)) throw new TriageSourceError(`Unknown mailbox: ${key.slice(0, 80)}`);
  if (isImapMailbox(key)) {
    await imapAccount(repos, imapAccountId(key)).catch(() => { throw new TriageSourceError('Mail account not found'); });
    return key;
  }
  const provider = await resolveProvider(userId, key).catch((err: unknown) => { throw new TriageSourceError((err as Error).message); });
  if (!provider) throw new TriageSourceError('No mailbox connected');
  return provider;
}

/**
 * The mailbox a request is about when its mail does not name one: `?provider=`
 * (a provider or an IMAP mailbox), else the user's default Google / Microsoft
 * mailbox. Null when there is none.
 */
export async function fallbackMailbox(repos: ContentRepos, userId: string, named: string | null): Promise<MailboxKey | null> {
  if (named) return checkMailbox(repos, userId, named);
  return resolveProvider(userId, null);
}

export interface RunMail { id: string; from: EmailAddress; subject: string; snippet: string; mailbox?: string }

/** The sources of a run: the given rows by mailbox, or the newest mail of `mailboxes`. */
export async function triageSources(
  repos: ContentRepos,
  userId: string,
  request: { fallback: MailboxKey | null; items?: readonly RunMail[]; mailboxes?: readonly string[] },
  deps?: ImapAiDeps,
): Promise<TriageSource[]> {
  if (request.items) {
    const groups = new Map<string, RunMail[]>();
    for (const it of request.items) {
      const key = it.mailbox ?? request.fallback;
      if (!key) throw new TriageSourceError('No mailbox connected');
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
    const sources: TriageSource[] = [];
    for (const [key, rows] of groups) {
      const mailbox = await checkMailbox(repos, userId, key);
      if (isImapMailbox(mailbox)) {
        const got = await keepForTriage(userId, await imapItemsByIds(repos, imapAccountId(mailbox), rows.map((r) => r.id)), deps);
        sources.push({ mailbox, items: got.items, ...(got.protected ? { protected: got.protected } : {}) });
      } else {
        sources.push({ mailbox, items: rows.map(({ id, from, subject, snippet }) => ({ id, from, subject, snippet, provider: mailbox, receivedAt: '', unread: false })) });
      }
    }
    return sources;
  }
  const keys = request.mailboxes?.length ? request.mailboxes : request.fallback ? [request.fallback] : [];
  if (!keys.length) throw new TriageSourceError('No mailbox connected');
  const sources: TriageSource[] = [];
  for (const key of new Set(keys)) {
    const mailbox = await checkMailbox(repos, userId, key);
    sources.push(isImapMailbox(mailbox)
      ? { mailbox, newest: async (limit) => keepForTriage(userId, await newestImap(repos, imapAccountId(mailbox), limit), deps) }
      : { mailbox });
  }
  return sources;
}
