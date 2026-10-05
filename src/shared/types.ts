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
 * A personal model as its owner sees it (`/api/me/models`) — never the key.
 * See `src/services/personal-models.ts` and coworking-spec §8.4.
 */
export interface PersonalModelSummary {
  /** Row name, `u/<userId>/<slug>`. */
  name: string;
  slug: string;
  provider: string;
  modelId: string;
  label: string | null;
  endpoint: string | null;
  isEnabled: boolean;
  hasKey: boolean;
  /** Token window and output limit (compaction thresholds derive from the window). */
  contextWindow: number;
  maxTokens: number;
  /** Text lanes this row runs for its owner. */
  topics: string[];
}

/** `GET /api/me/models`. */
export interface PersonalModelsResponse {
  models: PersonalModelSummary[];
  providers: string[];
  topics: string[];
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
  /** The space the channel is bound to (coworking §9.4): its threads are rooms there. Null when not bound. */
  workspaceId: string | null;
  spaceName: string | null;
  /** `mention`: speaks only when addressed; `listen`: offers help; `proactive`: may answer unasked. */
  mode: 'mention' | 'listen' | 'proactive';
  /** No unprompted posts in [start, end) local hours; null = none. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
  maxUnpromptedPerDay: number;
  minMinutesBetween: number;
  lastUnpromptedAt: string | null;
  /** ✅ / ❌ reactions members put on the bot's replies. */
  feedback: { up: number; down: number };
  createdAt: string;
  updatedAt: string;
}

// ── Coworking S5: funding, space budgets, My work, room modes ───────

/** A space's budget as `GET/PUT /api/spaces/:id/budget` returns it (`SpendBudgetView` on the server). */
export interface SpaceBudgetStatus {
  id: string;
  scopeKind: 'space' | 'space_member';
  period: 'day' | 'month';
  limitUsd: number;
  warnRatio: number;
  /** This period; the member cap shows the caller's own share. */
  spentUsd: number;
  percent: number;
  state: 'ok' | 'warned' | 'paused';
  resetsAt: string;
}

/** `PUT /api/spaces/:id/funding`. */
export interface SpaceFundingSettingsView {
  mode: 'own' | 'unattended' | 'sponsored';
  sponsorUserId: string | null;
  sponsorModels: string[];
  warning?: string;
}

/** One task of "My work" (a `tasks` row, as the API sends it). */
export interface MyWorkTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  dueAt: string | null;
  workspaceId: string | null;
}

/** `GET /api/me/work`: open tasks assigned to me, grouped by space. */
export interface MyWorkResponse {
  groups: Array<{ workspaceId: string | null; name: string; kind: 'personal' | 'shared'; tasks: MyWorkTask[] }>;
}

export type RoomModeName = 'mention' | 'listen' | 'proactive';

/** `GET/PUT /api/spaces/:id/rooms/:roomId/mode`. */
export interface RoomModeView {
  roomId: string;
  mode: RoomModeName;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
  maxUnpromptedPerDay: number;
  minMinutesBetween: number;
  lastUnpromptedAt: string | null;
  feedback: { up: number; down: number };
}
