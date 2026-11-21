/**
 * When a provider's default account changes (Settings → Make default, or the
 * default is disconnected and the next account takes its place), the data
 * keyed as "the default account" is moved to stay with its real account:
 *
 * - email triage rows (`email_triage_labels.provider`): the bare provider key
 *   is the default's; `provider:<address>` is any other account's. The old
 *   default's rows get its address, the new default's rows the bare key.
 * - snoozes stored before addresses were kept (`account` null) get the old
 *   default's address, so they wake in the mailbox they were taken from.
 * - the Calendar page's visible calendars (`users.preferences.calendar`):
 *   `google:<id>` is the default's calendar, `google:<account>:<id>` another's.
 *
 * The local mail index is not moved: it is dropped (oauth.ts), it rebuilds.
 * All in one transaction: a half-moved set would mix two mailboxes.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { emailSnoozes } from '@/db/schema/email-snoozes';
import { emailTriageLabels } from '@/db/schema/email-triage-labels';
import { users } from '@/db/schema/users';
import { rekeyCalendarVisibility } from '@/shared/calendar';
import { coreLogger } from '@/utils/logger';

type Provider = 'google' | 'microsoft';

/** Where an old default's triage rows go when its address is not known: a key no account can have. */
export const UNKNOWN_PREVIOUS_DEFAULT = '(previous default)';

export async function moveDefaultAccountData(userId: string, provider: Provider, oldAccount: string | undefined, newAccount: string): Promise<void> {
  const fresh = newAccount.toLowerCase();
  const stale = oldAccount?.toLowerCase();
  if (stale === fresh) return;
  await getDb().transaction(async (tx) => {
    // Triage: swap through a key no row has, so the unique (user, key, message) never sees two rows at once.
    const parked = `${provider}:#moving`;
    const mine = (key: string) => and(eq(emailTriageLabels.userId, userId), eq(emailTriageLabels.provider, key));
    await tx.update(emailTriageLabels).set({ provider: parked }).where(mine(provider));
    await tx.update(emailTriageLabels).set({ provider }).where(mine(`${provider}:${fresh}`));
    await tx.update(emailTriageLabels).set({ provider: `${provider}:${stale ?? UNKNOWN_PREVIOUS_DEFAULT}` }).where(mine(parked));

    // Snoozes kept before addresses were stored: they were the old default's.
    if (stale) {
      await tx.update(emailSnoozes).set({ account: stale })
        .where(and(eq(emailSnoozes.userId, userId), eq(emailSnoozes.provider, provider), isNull(emailSnoozes.account)));
    }

    // The Calendar page's choices.
    const [row] = await tx.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).for('update');
    const visible = row?.preferences?.calendar?.visible;
    if (row && Array.isArray(visible)) {
      const next = rekeyCalendarVisibility(visible, provider, stale, fresh);
      await tx.update(users).set({ preferences: { ...row.preferences, calendar: { ...row.preferences!.calendar, visible: next } } }).where(eq(users.id, userId));
    }
  });
  coreLogger.info({ userId, provider, previousKnown: !!stale }, 'accounts: data keyed to the default account moved to the new default');
}
