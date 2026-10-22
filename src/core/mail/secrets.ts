/**
 * Mail account passwords: vault system secrets `mail:<accountId>:incoming`
 * and `mail:<accountId>:outgoing`. Never returned by the API, never logged.
 * An outgoing server without its own password uses the incoming one, but
 * only on the same host: a password is never handed to a server it was not
 * entered for.
 */
import type { MailAccount } from '@/db/schema/mail';
import { getVault } from '@/security/vault';

export type MailSecretSide = 'incoming' | 'outgoing';

export function mailSecretName(accountId: string, side: MailSecretSide): string {
  return `mail:${accountId}:${side}`;
}

export async function mailPassword(accountId: string, side: MailSecretSide): Promise<string | null> {
  return getVault().getSystemSecret(mailSecretName(accountId, side));
}

/** The outgoing server's password: its own, or the incoming one when both are the same host. */
export async function outgoingPassword(account: Pick<MailAccount, 'id' | 'incoming' | 'outgoing'>): Promise<string | null> {
  const own = await mailPassword(account.id, 'outgoing');
  if (own || !account.outgoing || account.outgoing.host !== account.incoming.host) return own;
  return mailPassword(account.id, 'incoming');
}

export async function setMailPassword(accountId: string, side: MailSecretSide, value: string | null): Promise<void> {
  const vault = getVault();
  if (value) {
    await vault.setSystemSecret(mailSecretName(accountId, side), value, { description: `Mail account ${side} password`, tags: ['system', 'mail'] });
    return;
  }
  await deleteMailPasswords(accountId, [side]);
}

/** Which passwords are stored for each of `accountIds`, from one vault listing. */
export async function mailPasswordsSet(accountIds: readonly string[]): Promise<Map<string, { incoming: boolean; outgoing: boolean }>> {
  const names = accountIds.length > 0 ? new Set((await getVault().list('system')).map((e) => e.name)) : new Set<string>();
  return new Map(accountIds.map((id) => [id, {
    incoming: names.has(mailSecretName(id, 'incoming')),
    outgoing: names.has(mailSecretName(id, 'outgoing')),
  }]));
}

export async function deleteMailPasswords(accountId: string, sides: readonly MailSecretSide[] = ['incoming', 'outgoing']): Promise<void> {
  const vault = getVault();
  const wanted = new Set(sides.map((side) => mailSecretName(accountId, side)));
  for (const entry of await vault.list('system')) {
    if (wanted.has(entry.name)) await vault.delete('system', entry.id);
  }
}

const SECRET_RE = /^mail:([0-9a-f-]{36}):(incoming|outgoing)$/;

/**
 * Remove passwords whose account is gone: an account removed with its space
 * (purge) or its owner (cascade) never passed through `deleteMailAccount`.
 */
export async function pruneOrphanMailPasswords(): Promise<number> {
  const { getDb } = await import('@/db/postgres');
  const { mailAccounts } = await import('@/db/schema/mail');
  const { inArray } = await import('drizzle-orm');
  const vault = getVault();
  const entries = (await vault.list('system')).filter((e) => SECRET_RE.test(e.name));
  if (entries.length === 0) return 0;
  const ids = [...new Set(entries.map((e) => (SECRET_RE.exec(e.name) as RegExpExecArray)[1]))];
  const live = new Set((await getDb().select({ id: mailAccounts.id }).from(mailAccounts).where(inArray(mailAccounts.id, ids))).map((r) => r.id));
  let removed = 0;
  for (const entry of entries) {
    if (live.has((SECRET_RE.exec(entry.name) as RegExpExecArray)[1])) continue;
    await vault.delete('system', entry.id);
    removed++;
  }
  return removed;
}
