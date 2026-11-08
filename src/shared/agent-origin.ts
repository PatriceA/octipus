/**
 * What started an agent run — the "Started by" column of Mission control
 * (docs/MISSION-CONTROL.md). Shared by the backend, which records it on the
 * `agents` row at spawn, and the web client, which labels and filters by it.
 */

export const AGENT_SOURCES = [
  'chat',
  'spawned',
  'heartbeat',
  'schedule',
  'webhook',
  'pipeline',
  'companion',
  'monitor',
  'channel',
  'room',
  'manual',
] as const;

export type AgentSource = (typeof AGENT_SOURCES)[number];

export const AGENT_SOURCE_LABEL: Record<AgentSource, string> = {
  chat: 'You, in chat',
  spawned: 'Spawned by an agent',
  heartbeat: 'Heartbeat',
  schedule: 'Schedule',
  webhook: 'Webhook',
  pipeline: 'Pipeline',
  companion: 'Companion',
  monitor: 'Monitor',
  channel: 'Messaging channel',
  room: 'Shared room',
  manual: 'Manual test',
};

/** Recorded with each agent row (`agents.origin`). Ids only; names are resolved when shown. */
export interface AgentOrigin {
  source: AgentSource;
  /** Entry channel of the turn (`webchat`, `slack`, `heartbeat`, …). */
  channel?: string;
  hookId?: string;
  /** The hook's name when it started the run, so a deleted hook still reads. */
  hookName?: string;
  pipelineId?: string;
  /** Companion supervision goal. */
  goalId?: string;
}

/** One row of Mission control's run list. */
export interface MissionRun {
  id: string;
  sessionId: string;
  role: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle' | 'paused';
  root: boolean;
  parentAgentId: string | null;
  /** Null for rows written before origins were recorded: unknown, not "chat". */
  origin: AgentOrigin | null;
  /** The session's title: what the run was working on. */
  title: string | null;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  totalTokens: number;
  /** Null when no cost was recorded (a CLI subscription, a local model without pricing). */
  costUsd: number | null;
  error: string | null;
  /** Why a finished run stopped (budget, timeout, …) when it recorded one. */
  completionReason: string | null;
}

export interface MissionUpcoming {
  hookId: string;
  name: string;
  /** `heartbeat`, `schedule` … the hook's trigger kind. */
  kind: string;
  /** The role a role heartbeat wakes, when it is one. */
  role: string | null;
  nextRunAt: string | null;
  /** A heartbeat's check interval; it has no fixed next run. */
  everyMinutes: number | null;
  lastError: string | null;
}

/** `GET /api/agents/overview` */
export interface MissionControlResponse {
  /** Start of the day the counts cover, in the server's timezone. */
  since: string;
  runs: MissionRun[];
  counts: {
    live: number;
    today: number;
    failedToday: number;
    bySource: Partial<Record<AgentSource | 'unknown', number>>;
  };
  /** Sum of recorded cost today; requests without a price are not in it. */
  spendTodayUsd: number;
  /** Approvals waiting on this user; null when they could not be read. */
  pendingApprovals: number | null;
  upcoming: MissionUpcoming[];
}
