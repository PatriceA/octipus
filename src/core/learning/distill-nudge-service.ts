/**
 * The post-task "distil this into a skill?" offer (A1-M3,
 * docs/SESSION-LEARNING.md "Offer to distil a finished task"): reading what
 * a finished root turn recorded, making the offer on its answer, and acting
 * on the owner's decision. Eligibility itself is the pure distill-nudge.ts.
 *
 * Nothing is distilled, and no model is called, until the owner accepts.
 * Accepting runs the one distillation path (`distillToProposal`, as
 * `distill_skill`), with the run's own messages as the material; the result
 * is a pending proposal the owner still approves on Skills → Proposals.
 */
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { visibleMessages } from '@/db/repositories/message-visibility';
import { userRepository } from '@/db/repositories/user-repository';
import { agentEvents } from '@/db/schema/agent-events';
import { kvStore } from '@/db/schema/kv';
import { messages } from '@/db/schema/messages';
import { skillProposals } from '@/db/schema/skill-proposals';
import { users } from '@/db/schema/users';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import { getPermissionManager } from '@/security/permissions';
import type { DistillNudgeDecision, DistillNudgeOutcome, DistillNudgeRecord, DistillNudgeView } from '@/shared/distill-nudge';
import { takeRunSkillUse } from '@/skills/run-skill-use';
import { distillToProposal } from '@/tools/skill-distill/distill';
import { coreLogger } from '@/utils/logger';
import {
  type DistillNudgeThresholds, type NudgeTurnFacts, nudgeRunDecision, nudgeTurnGate, summarizeRunEvents, verificationPassed,
} from './distill-nudge';

/** The `kv_store` key of a user's cool-down; its expiry is the end of the cool-down. */
export const distillNudgeCooldownKey = (userId: string) => `learning:distill-nudge:${userId}`;
/** Events read per run: far more than a turn's tool calls; a runaway run is complex at any cut. */
const MAX_RUN_EVENTS = 5000;
/** Each message of the run handed to the distiller, at most. */
const MAX_MESSAGE_CHARS = 12_000;

function thresholds(): DistillNudgeThresholds {
  const learning = getConfig().learning;
  return {
    enabled: learning.distillNudge,
    minToolCalls: learning.distillNudgeMinToolCalls,
    minDistinctTools: learning.distillNudgeMinDistinctTools,
  };
}

export interface DistillNudgeTurn {
  runId: string;
  sessionId: string;
  userId: string;
  rootAgentId: string;
  /** The stored answer the offer is attached to. */
  answerMessageId: string;
  startedAt: Date;
  facts: NudgeTurnFacts;
}

/** `sessionId` as a proposal records it: `session:<id>` from `distill_skill`, `learning:<job>:session:<id>` from a check. */
function fromSession(sessionId: string) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${skillProposals.sourceRefs}) AS ref(value)
    WHERE ref.value = ${`session:${sessionId}`} OR ref.value LIKE ${`%:session:${sessionId}`})`;
}

/** One of the user's open, or rejected and still suppressed, proposals came from this session. */
async function sessionHasProposal(userId: string, sessionId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: skillProposals.id }).from(skillProposals).where(and(
    eq(skillProposals.userId, userId), ne(skillProposals.kind, 'patch'),
    or(inArray(skillProposals.status, ['pending', 'candidate']),
      and(eq(skillProposals.status, 'rejected'), sql`${skillProposals.rejectedUntil} > now()`)),
    or(eq(skillProposals.sourceRef, `session:${sessionId}`), fromSession(sessionId)),
  )).limit(1);
  return !!row;
}

async function optedOut(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ off: sql<boolean>`coalesce(${users.preferences}->>'distillNudge', 'true') = 'false'` })
    .from(users).where(sql`${users.id}::text = ${userId}`).limit(1);
  return row?.off === true;
}

/**
 * Take the user's cool-down: one statement, so of two turns ending at once
 * only one is offered. A cool-down of 0 hours always succeeds.
 */
async function claimCooldown(userId: string, hours: number, now = new Date()): Promise<boolean> {
  if (hours === 0) return true;
  const until = new Date(now.getTime() + hours * 3_600_000);
  const rows = await getDb().insert(kvStore)
    .values({ key: distillNudgeCooldownKey(userId), value: now.toISOString(), expiresAt: until })
    .onConflictDoUpdate({
      target: kvStore.key,
      set: { value: now.toISOString(), expiresAt: until },
      setWhere: sql`${kvStore.expiresAt} IS NOT NULL AND ${kvStore.expiresAt} <= ${now.toISOString()}::timestamptz`,
    })
    .returning({ key: kvStore.key });
  return rows.length > 0;
}

/**
 * At the end of a root turn: offer to distil it when it qualifies, by putting
 * an `offered` record on its stored answer. Returns the answer's id when an
 * offer was made. Reads only what the run recorded; calls no model.
 */
export async function offerDistillNudge(turn: DistillNudgeTurn): Promise<{ messageId: string } | null> {
  const skillInjected = takeRunSkillUse(turn.runId);
  const limits = thresholds();
  const gate = nudgeTurnGate(turn.facts, limits);
  if (gate) {
    coreLogger.debug({ runId: turn.runId, reason: gate }, 'Distil offer skipped');
    return null;
  }
  const db = getDb();
  const [events, verdicts, sessionProposal, off] = await Promise.all([
    db.select({ agentId: agentEvents.agentId, type: agentEvents.type, data: agentEvents.data }).from(agentEvents)
      .where(and(eq(agentEvents.runId, turn.runId), eq(agentEvents.userId, turn.userId))).limit(MAX_RUN_EVENTS),
    db.select({ kind: verificationEvidence.kind, stage: verificationEvidence.stage, nodeId: verificationEvidence.nodeId,
      passed: verificationEvidence.passed, createdAt: verificationEvidence.createdAt }).from(verificationEvidence)
      .where(and(sql`${verificationEvidence.sessionId}::text = ${turn.sessionId}`, gte(verificationEvidence.createdAt, turn.startedAt))),
    sessionHasProposal(turn.userId, turn.sessionId),
    optedOut(turn.userId),
  ]);
  const signals = summarizeRunEvents(events, turn.rootAgentId);
  const reason = nudgeRunDecision({ signals, skillInjected, verification: verificationPassed(verdicts), sessionProposal, optedOut: off }, limits);
  if (reason) {
    coreLogger.debug({ runId: turn.runId, reason, signals }, 'Distil offer skipped');
    return null;
  }
  if (!(await claimCooldown(turn.userId, getConfig().learning.distillNudgeCooldownHours))) {
    coreLogger.debug({ runId: turn.runId, reason: 'cooling_down' }, 'Distil offer skipped');
    return null;
  }
  const record: DistillNudgeRecord = {
    state: 'offered', runId: turn.runId, userId: turn.userId,
    startedAt: turn.startedAt.toISOString(), offeredAt: new Date().toISOString(),
  };
  await db.update(messages).set({ metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ skillNudge: record })}::jsonb` })
    .where(and(eq(messages.id, turn.answerMessageId), eq(messages.sessionId, turn.sessionId)));
  coreLogger.info({ runId: turn.runId, sessionId: turn.sessionId, signals }, 'Distil offer made');
  return { messageId: turn.answerMessageId };
}

/**
 * The session's open offer: on its latest shown answer, still undecided, of
 * `userId`. An offer lapses when another answer follows it. The caller has
 * checked that `userId` may act in the session.
 */
export async function openDistillNudge(sessionId: string, userId: string): Promise<DistillNudgeView | null> {
  const [latest] = await getDb().select({ id: messages.id, metadata: messages.metadata }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant'), visibleMessages,
      sql`coalesce(${messages.metadata}->>'kind', '') <> 'progress'`))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  const nudge = latest?.metadata?.skillNudge;
  if (!nudge || nudge.state !== 'offered' || nudge.userId !== userId) return null;
  return { messageId: latest.id, offeredAt: nudge.offeredAt };
}

export type DistillNudgeErrorCode = 'not_found' | 'decided' | 'refused' | 'failed';

export class DistillNudgeError extends Error {
  override name = 'DistillNudgeError';
  constructor(readonly code: DistillNudgeErrorCode, message: string) { super(message); }
}

/** Move the offer from `from` to `next`; false when it was not in `from` (decided meanwhile). */
async function transition(messageId: string, from: DistillNudgeRecord['state'], next: DistillNudgeRecord): Promise<boolean> {
  const rows = await getDb().update(messages)
    .set({ metadata: sql`jsonb_set(${messages.metadata}, '{skillNudge}', ${JSON.stringify(next)}::jsonb)` })
    .where(and(eq(messages.id, messageId), sql`${messages.metadata}->'skillNudge'->>'state' = ${from}`))
    .returning({ id: messages.id });
  return rows.length > 0;
}

/**
 * What the distiller reads for an accepted offer: the run's own messages
 * (the request, progress updates and the answer) and the tools it used, in
 * the shape `distill_skill`'s conversation source has.
 */
async function runMaterial(sessionId: string, nudge: DistillNudgeRecord, answerAt: Date): Promise<string> {
  const db = getDb();
  const [rows, events] = await Promise.all([
    db.select({ role: messages.role, content: messages.content }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.role, ['user', 'assistant']), visibleMessages,
        gte(messages.createdAt, new Date(nudge.startedAt)), lte(messages.createdAt, answerAt)))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
    db.select({ agentId: agentEvents.agentId, type: agentEvents.type, data: agentEvents.data }).from(agentEvents)
      .where(and(eq(agentEvents.runId, nudge.runId), eq(agentEvents.userId, nudge.userId), eq(agentEvents.type, 'action')))
      .orderBy(asc(agentEvents.id)).limit(MAX_RUN_EVENTS),
  ]);
  const tools = [...new Set(events.flatMap(({ data }) => {
    const d = (data ?? {}) as { type?: string; toolName?: unknown };
    return (d.type === 'tool_call' || d.type === 'cli_tool_use') && typeof d.toolName === 'string' ? [d.toolName] : [];
  }))];
  const transcript = rows.map((m) => `${m.role}: ${m.content.length > MAX_MESSAGE_CHARS ? `${m.content.slice(0, MAX_MESSAGE_CHARS)}…` : m.content}`);
  return [...transcript, ...(tools.length ? [`Tools used, in order of first use: ${tools.join(', ')}`] : [])].join('\n\n').trim();
}

/**
 * The owner's decision on the offer on `messageId`. Each offer takes one
 * decision: a second one is `decided`. `never` also turns the offers off for
 * the user. `accept` distils the run into a pending proposal; when that fails
 * (no background model, a malformed reply, the permission refused) the offer
 * is open again so it can be retried, and the error is thrown.
 *
 * The caller has checked that `userId` may act in the session and is its owner.
 */
export async function resolveDistillNudge(sessionId: string, messageId: string, userId: string, decision: DistillNudgeDecision): Promise<DistillNudgeOutcome> {
  const [row] = await getDb().select({ metadata: messages.metadata, createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId))).limit(1);
  const nudge = row?.metadata?.skillNudge;
  if (!row || !nudge || nudge.userId !== userId) throw new DistillNudgeError('not_found', 'No offer to distil this answer.');
  if (nudge.state !== 'offered') throw new DistillNudgeError('decided', `This offer was already ${nudge.state}.`);
  const decidedAt = new Date().toISOString();

  if (decision !== 'accept') {
    if (!(await transition(messageId, 'offered', { ...nudge, state: 'dismissed', decidedAt }))) {
      throw new DistillNudgeError('decided', 'This offer was already decided.');
    }
    if (decision === 'never') await userRepository.setDistillNudge(userId, false);
    return decision === 'never'
      ? { state: 'dismissed', optedOut: true, message: 'You will not be offered this again. Turn it back on under Settings → Profile.' }
      : { state: 'dismissed', message: 'Not distilled.' };
  }

  // Taken before the model call, so a second click cannot distil twice.
  const accepted: DistillNudgeRecord = { ...nudge, state: 'accepted', decidedAt };
  if (!(await transition(messageId, 'offered', accepted))) throw new DistillNudgeError('decided', 'This offer was already decided.');
  const reopen = async (code: DistillNudgeErrorCode, message: string): Promise<never> => {
    if (!(await transition(messageId, 'accepted', nudge))) coreLogger.warn({ messageId }, 'Distil offer could not be reopened after a failed accept');
    throw new DistillNudgeError(code, message);
  };

  // The owner's click is the answer an ASK would wait for; only a DENY stops it.
  const permission = await getPermissionManager().check(userId, 'skill-distill', 'distill', { source: 'run' },
    { sessionId }, { defaultLevel: 'ALLOW' });
  if (permission.level === 'DENY') return reopen('refused', 'Distilling a skill is denied for you (tool skill-distill, action distill).');

  const material = await runMaterial(sessionId, nudge, row.createdAt);
  if (!material) return reopen('failed', 'This run left no messages to distil.');
  let result: Awaited<ReturnType<typeof distillToProposal>>;
  try {
    result = await distillToProposal(material, `session:${sessionId}`, userId);
  } catch (err) {
    coreLogger.error({ err, messageId }, 'Distil offer: distillation failed');
    return reopen('failed', `Distillation failed: ${(err as Error).message}`);
  }
  if ('error' in result) return reopen('failed', result.error);
  const proposalId = 'proposalId' in result ? result.proposalId : undefined;
  if (proposalId && !(await transition(messageId, 'accepted', { ...accepted, proposalId }))) {
    coreLogger.warn({ messageId, proposalId }, 'Distil offer: the proposal id could not be recorded');
  }
  return {
    state: 'accepted',
    distilled: result.distilled,
    ...(proposalId ? { proposalId } : {}),
    ...('status' in result && result.status ? { status: result.status } : {}),
    message: ('message' in result && result.message) || (result.distilled ? 'Filed for review on Skills → Proposals.' : 'Nothing worth distilling into a reusable skill.'),
  };
}
