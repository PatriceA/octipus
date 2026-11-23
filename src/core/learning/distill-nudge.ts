/**
 * Whether a finished root turn earns the "distil this into a skill?" offer
 * (A1-M3, docs/SESSION-LEARNING.md "Offer to distil a finished task"). Pure:
 * every fact is read by the caller (distill-nudge-service.ts) from what the
 * run already recorded. No model is called to decide.
 *
 * A run is offered when it was
 *  - attended: a person asked for it (trigger `user`) in a client that can
 *    show the offer, not by voice, not from a hook, schedule, heartbeat,
 *    monitor or webhook, not a one-shot request, not in a shared space or
 *    group thread;
 *  - successful: it answered (`success`), was not refused by a cap or by the
 *    output guard, and the latest verdict of every check recorded during the
 *    run passed (no evidence: the outcome decides);
 *  - complex: it used at least `minDistinctTools` different tools, and either
 *    `minToolCalls` tool calls or a delegation (a child agent or a pipeline);
 *  - new: no skill was loaded for it, it did not call `distill_skill` itself,
 *    and none of the user's open or still suppressed proposals came from
 *    this session;
 *  - wanted: the user has not turned the offers off. The per-user cool-down
 *    is claimed last, by the caller, so only an offer that is made uses it.
 *
 * Time spent is not a signal: on a slow local model every turn takes long
 * (the same reason `learning.reviewEveryToolCalls` counts tools, not time).
 */
import type { AgentTrigger } from '@/core/types';

/** Entry channels whose turns nobody is watching (`triggerForChannel` maps most of them away from `user` already). */
const UNATTENDED_CHANNELS: ReadonlySet<string> = new Set(['hook', 'heartbeat', 'cron', 'monitor', 'webhook']);
/** Voice entry channels: the offer is a click, which a spoken conversation has nowhere to put. */
const VOICE_CHANNELS: ReadonlySet<string> = new Set(['voice', 'mobile-voice', 'phone']);
/** Meta-tools that hand work to other agents. */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['spawn_child', 'create_pipeline', 'spawn_worker', 'collect_children']);
/** `get_skill` in-process, or a CLI agent's call of it through the MCP bridge (as in evidence.ts). */
const GET_SKILL_RE = /(^|[_.:])(octipus_)?get_skill$/;
const DISTILL_RE = /(^|[_.:])(octipus_)?distill_skill$/;

export interface DistillNudgeThresholds {
  enabled: boolean;
  minToolCalls: number;
  minDistinctTools: number;
}

/** Facts about the turn known when it ends, before anything is read. */
export interface NudgeTurnFacts {
  trigger: AgentTrigger;
  channel?: string;
  /** The client listed `skill_nudge` in `renders`. */
  clientRendersNudge: boolean;
  /** Spoken or read aloud. */
  spoken: boolean;
  oneShot: boolean;
  /** A Companion briefing or supervisor input, not the owner speaking. */
  synthetic: boolean;
  /** A space, a room or a group thread: a proposal is personal. */
  shared: boolean;
  /** The session keeps no content of its own (a space on another install). */
  contentStorageOff: boolean;
  outcome: 'success' | 'failed' | 'cancelled' | undefined;
  /** Refused by a spend budget or quota. */
  limited: boolean;
  /** The output guard replaced the answer, or it was withheld. */
  replaced: boolean;
}

/** What the run's recorded events say about it (`summarizeRunEvents`). */
export interface RunSignals {
  toolCalls: number;
  distinctTools: number;
  delegated: boolean;
  /** A skill's body was loaded through `get_skill` (in-process or a CLI's). */
  skillLoaded: boolean;
  /** The run called `distill_skill` itself. */
  distilled: boolean;
}

/** Facts read for a turn that passed the gate. */
export interface NudgeRunFacts {
  signals: RunSignals;
  /** A skill was injected or loaded through the skill registry during the run (src/skills/run-skill-use.ts). */
  skillInjected: boolean;
  /** `verificationPassed` of the checks recorded during the run. */
  verification: boolean | null;
  /** One of the user's open or still suppressed proposals came from this session. */
  sessionProposal: boolean;
  optedOut: boolean;
}

export type NudgeSkipReason =
  | 'disabled' | 'unattended' | 'client' | 'voice' | 'one_shot' | 'synthetic' | 'shared' | 'no_content'
  | 'not_successful' | 'refused'
  | 'simple' | 'skill_used' | 'already_distilled' | 'verification_failed' | 'proposal_exists' | 'opted_out';

/** The skip reason of a turn by what is known when it ends, or null when it may go on to be read. */
export function nudgeTurnGate(turn: NudgeTurnFacts, thresholds: Pick<DistillNudgeThresholds, 'enabled'>): NudgeSkipReason | null {
  if (!thresholds.enabled) return 'disabled';
  if (turn.trigger !== 'user' || (turn.channel !== undefined && UNATTENDED_CHANNELS.has(turn.channel))) return 'unattended';
  if (turn.spoken || (turn.channel !== undefined && VOICE_CHANNELS.has(turn.channel))) return 'voice';
  if (!turn.clientRendersNudge) return 'client';
  if (turn.oneShot) return 'one_shot';
  if (turn.synthetic) return 'synthetic';
  if (turn.shared) return 'shared';
  if (turn.contentStorageOff) return 'no_content';
  if (turn.outcome !== 'success') return 'not_successful';
  if (turn.limited || turn.replaced) return 'refused';
  return null;
}

/** True when the signals make the run complex enough to be worth a skill. */
export function isComplexRun(signals: RunSignals, thresholds: Pick<DistillNudgeThresholds, 'minToolCalls' | 'minDistinctTools'>): boolean {
  if (signals.distinctTools < thresholds.minDistinctTools) return false;
  return signals.toolCalls >= thresholds.minToolCalls || signals.delegated;
}

/** The skip reason by the run's events and skill use alone (the second, cheaper stage the caller reads). */
export function nudgeSignalsDecision(signals: RunSignals, skillInjected: boolean, thresholds: DistillNudgeThresholds): NudgeSkipReason | null {
  if (!isComplexRun(signals, thresholds)) return 'simple';
  if (signals.skillLoaded || skillInjected) return 'skill_used';
  if (signals.distilled) return 'already_distilled';
  return null;
}

/**
 * The skip reason of a gated turn by what its run recorded, or null to offer
 * (subject to the cool-down). In the order the caller reads the facts,
 * cheapest first: the preference, the run's events, then its checks and the
 * user's proposals.
 */
export function nudgeRunDecision(run: NudgeRunFacts, thresholds: DistillNudgeThresholds): NudgeSkipReason | null {
  if (run.optedOut) return 'opted_out';
  const bySignals = nudgeSignalsDecision(run.signals, run.skillInjected, thresholds);
  if (bySignals) return bySignals;
  if (run.verification === false) return 'verification_failed';
  if (run.sessionProposal) return 'proposal_exists';
  return null;
}

/** Bounds of the material an accepted offer hands the distiller (the run's messages). */
export const RUN_MATERIAL_LIMITS = {
  /** As many messages as `distill_skill`'s conversation source reads. */
  messages: 30,
  /** Each message, at most. */
  messageChars: 12_000,
  /** All of it together, the tools line included. */
  totalChars: 40_000,
  /** The tools line, at most. */
  toolsChars: 2_000,
} as const;

/** Accepts of one offer that may fail before it is closed as `failed`. */
export const MAX_DISTILL_ATTEMPTS = 3;

/**
 * The distiller's material for a run: its messages, oldest first, as
 * `role: text`, and the tools it used. Bounded by `RUN_MATERIAL_LIMITS`: the
 * request (first message) and the answer (last) are always kept; what does
 * not fit is dropped from the oldest of the messages between them.
 */
export function boundRunMaterial(rows: ReadonlyArray<{ role: string; content: string }>, tools: readonly string[]): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  let lines = rows.map((m) => `${m.role}: ${clip(m.content, RUN_MATERIAL_LIMITS.messageChars)}`);
  if (lines.length > RUN_MATERIAL_LIMITS.messages) lines = [lines[0], ...lines.slice(-(RUN_MATERIAL_LIMITS.messages - 1))];
  const toolsLine = tools.length ? [clip(`Tools used, in order of first use: ${tools.join(', ')}`, RUN_MATERIAL_LIMITS.toolsChars)] : [];
  const size = () => [...lines, ...toolsLine].reduce((n, line) => n + line.length + 2, 0);
  while (lines.length > 2 && size() > RUN_MATERIAL_LIMITS.totalChars) lines.splice(1, 1);
  return [...lines, ...toolsLine].join('\n\n').trim();
}

/** Both stages at once (what the caller does in two steps, reading in between). */
export function decideDistillNudge(turn: NudgeTurnFacts, run: NudgeRunFacts, thresholds: DistillNudgeThresholds): NudgeSkipReason | null {
  return nudgeTurnGate(turn, thresholds) ?? nudgeRunDecision(run, thresholds);
}

/** An `agent_events` row of the run, as far as the signals need it. */
export interface RunEventRow {
  agentId: string;
  type: string;
  data: unknown;
}

function toolNamesOf(data: Record<string, unknown>): string[] {
  if ((data.type === 'tool_call' || data.type === 'cli_tool_use') && typeof data.toolName === 'string') return [data.toolName];
  // Tool calls recovered from text are one action row carrying them all.
  if (Array.isArray(data.toolCalls)) {
    return data.toolCalls.flatMap((call) => (call && typeof (call as { name?: unknown }).name === 'string' ? [(call as { name: string }).name] : []));
  }
  return [];
}

/**
 * Tool calls, distinct tools, delegation and skill use of a run, from the
 * `agent_events` rows stamped with its run id (its children's included).
 * A row of another agent than the root is a child that ran: delegation.
 */
export function summarizeRunEvents(rows: readonly RunEventRow[], rootAgentId: string): RunSignals {
  const names = new Set<string>();
  let toolCalls = 0;
  let delegated = false;
  let skillLoaded = false;
  let distilled = false;
  for (const row of rows) {
    if (row.agentId !== rootAgentId) delegated = true;
    if (row.type !== 'action' || !row.data || typeof row.data !== 'object') continue;
    const data = row.data as Record<string, unknown>;
    if (data.type === 'skill_load') { skillLoaded = true; continue; }
    for (const name of toolNamesOf(data)) {
      toolCalls++;
      names.add(name);
      if (DELEGATION_TOOLS.has(name)) delegated = true;
      if (GET_SKILL_RE.test(name)) skillLoaded = true;
      if (DISTILL_RE.test(name)) distilled = true;
    }
  }
  return { toolCalls, distinctTools: names.size, delegated, skillLoaded, distilled };
}

/** A verification record of the run, as far as the verdict needs it. */
export interface RunVerdictRow {
  kind: string;
  stage: string | null;
  nodeId: string | null;
  passed: boolean;
  createdAt: Date;
}

/**
 * Did the run's checks pass? The latest verdict of each check (kind, stage,
 * node) counts, so a check that failed and passed on retry passed. Null when
 * nothing was checked.
 */
export function verificationPassed(rows: readonly RunVerdictRow[]): boolean | null {
  if (rows.length === 0) return null;
  const latest = new Map<string, RunVerdictRow>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.stage ?? ''}\u0000${row.nodeId ?? ''}`;
    const seen = latest.get(key);
    if (!seen || row.createdAt >= seen.createdAt) latest.set(key, row);
  }
  return [...latest.values()].every((row) => row.passed);
}
