/**
 * The email channel's mailbox (`emailChannel.accountId`, docs/CHANNELS.md#email)
 * holds every linked user's conversations with Octipus. It is the channel's
 * alone: automatic triage skips it and its owner's agent (the `mail` tool)
 * neither lists, reads, answers from nor sends from it — whether or not the
 * channel is on right now, since the conversations stay in it. The owner
 * still sees it in the Mail page (docs/CHANNELS.md#email says so).
 */
import { getConfig } from '@/config';

/** The channel's mailbox id, or null when none is configured. */
export function emailChannelAccountId(): string | null {
  const id = getConfig().emailChannel?.accountId?.trim();
  return id ? id : null;
}

/** Is this mail account the email channel's mailbox? */
export function isEmailChannelMailbox(accountId: string | null | undefined): boolean {
  const id = emailChannelAccountId();
  return !!id && !!accountId && accountId === id;
}
