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

/** `GET /api/agents/pulse`: the sidebar's live and needs-you counts. */
export interface AgentPulse {
  live: number;
  /** Null when approvals could not be read. */
  pendingApprovals: number | null;
}

/** One role on the Roster (`GET /api/agents/roster`). */
export interface RosterRole {
  role: string;
  /** The root agent's role (`general`): it answers chat; it takes no to-dos. */
  root: boolean;
  description: string | null;
  /** The lane its model comes from. */
  lane: string;
  toolGroups: number;
  readOnly: boolean;
  /** In the registry; a role only seen on old to-dos or hooks is not. */
  known: boolean;
  heartbeat: {
    enabled: boolean;
    hookId: string | null;
    nextCheckAt: string | null;
    intervalMinutes: number | null;
    /** The latest decision today, from `heartbeat_checks`. */
    lastCheck: { at: string; ran: boolean; reason: string | null } | null;
  };
  tasks: { active: number; total: number };
  runsToday: number;
  liveRuns: number;
  lastRun: { id: string; status: MissionRun['status']; createdAt: string; title: string | null; source: AgentSource | null } | null;
}

export interface RosterResponse {
  roles: RosterRole[];
  /** tasks/write is ALLOW; without it no role heartbeat can work its to-dos. */
  boardWritesAllowed: boolean;
  /** The server's heartbeat switch. */
  heartbeatEnabled: boolean;
}

/** What a run ended with, what its tools wrote, what it said it wrote, and the checks it was held to. */
export interface RunOutcome {
  status: MissionRun['status'];
  completionReason: string | null;
  error: string | null;
  durationMs: number | null;
  totalTokens: number;
  /** Null when no priced request was recorded. */
  costUsd: number | null;
  /** The run's final answer, clipped; null when it recorded none. */
  answer: string | null;
  answerClipped: boolean;
  /** Files a write tool recorded as written (from `file_change` events), last action per path. */
  files: Array<{ path: string; action: string; at: string }>;
  /** Paths the answer says were saved; `confirmed` only when a recorded write matches. */
  claims: Array<{ path: string; confirmed: boolean }>;
  toolCalls: Array<{ name: string; count: number }>;
  /** Rows of `verification_evidence` that judged this run. */
  checks: Array<{ kind: string; passed: boolean; stage: string | null; summary: string | null; at: string }>;
}

/** `GET /api/agents/:id/run`: why a run exists, where it sits in its tree, and what its prompt held. */
export interface RunDetailResponse {
  id: string;
  role: string;
  root: boolean;
  status: MissionRun['status'];
  sessionId: string;
  sessionTitle: string | null;
  createdAt: string;
  origin: AgentOrigin | null;
  /** The provenance chain, outermost first: what started the tree, then each step down to this run. */
  chain: Array<{ kind: 'source' | 'hook' | 'heartbeat' | 'pipeline' | 'goal' | 'parent'; label: string; detail: string | null; href: string | null }>;
  parent: { id: string; role: string; root: boolean } | null;
  children: Array<{ id: string; role: string; status: MissionRun['status']; totalTokens: number }>;
  outcome: RunOutcome;
  /** The run's measured prompt; null when it was not measured (CLI models, older runs). */
  prompt: (Omit<import('./prompt-composition').PromptComposition, 'sections'> & {
    sections: import('./prompt-composition').PromptSectionWithText[];
    textAvailable: boolean;
  }) | null;
}
