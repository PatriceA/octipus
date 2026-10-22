/**
 * Mail account passwords: vault system secrets `mail:<accountId>:incoming`
 * and `mail:<accountId>:outgoing`. Never returned by the API, never logged.
 * An outgoing server without its own password uses the incoming one.
 */
import { getVault } from '@/security/vault';

export type MailSecretSide = 'incoming' | 'outgoing';

export function mailSecretName(accountId: string, side: MailSecretSide): string {
  return `mail:${accountId}:${side}`;
}

export async function mailPassword(accountId: string, side: MailSecretSide): Promise<string | null> {
  const vault = getVault();
  const own = await vault.getSystemSecret(mailSecretName(accountId, side));
  if (own || side === 'incoming') return own;
  return vault.getSystemSecret(mailSecretName(accountId, 'incoming'));
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
