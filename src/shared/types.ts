/**
 * Shared, dependency-free types used by BOTH the backend (`src/`) and the web
 * UI (`web/`). Keep this module free of any runtime imports (no drizzle, no
 * node built-ins) so the browser bundle can import it directly — that
 * constraint is exactly why these types were previously duplicated.
 *
 * Only types that are genuinely the SAME contract on both sides belong here.
 * Server domain models, DB rows, WS wire payloads, and per-page API response
 * shapes that merely share a name are intentionally NOT unified — see
 * `.octipus/audit-2026-05-29.md` (M19) for the rationale.
 */

/** Channels a user can link their account to for notifications / chat. */
export type LinkableChannelType = 'telegram' | 'teams' | 'slack' | 'whatsapp' | 'webchat';

/**
 * A verified link between an Octipus user and their identity on an external
 * channel. Stored embedded on the user record (`users.channelBindings`) and
 * surfaced in the web settings UI — the same shape on both sides.
 */
export interface ChannelBinding {
  channelType: LinkableChannelType;
  channelUserId: string;
  channelUserName?: string;
  isVerified: boolean;
  createdAt: string;
}

/**
 * A group channel enrolment as the API returns it (`/api/me/group-channels`,
 * `/api/admin/group-channels`). See `src/channels/group-channels.ts`.
 */
export interface GroupChannelSummary {
  id: string;
  channelType: string;
  channelId: string;
  /** e.g. `#release`; null when the bot could not read the channel name. */
  label: string | null;
  ownerUserId: string;
  ownerName: string;
  /** False while the owner's account is deactivated: the bot is paused there. */
  ownerActive: boolean;
  createdAt: string;
  updatedAt: string;
}
