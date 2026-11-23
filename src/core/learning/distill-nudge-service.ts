/**
 * The post-task "distil this into a skill?" offer (A1-M3,
 * docs/SESSION-LEARNING.md "Offer to distil a finished task"): reading what
 * a finished root turn recorded, making the offer on its answer, and acting
 * on the owner's decision. Eligibility itself is the pure distill-nudge.ts.
 *
 * Nothing is distilled, and no model is called, until the owner accepts.
 * Accepting dispatches `distill_skill` (source `run`) through the tool's own
 * middleware — the `tool:before` waterfall, the permission check, the
 * `permission_granted` audit row — with the owner's click standing in for
 * the approval prompt of a plain ASK only. The result is a pending proposal
 * the owner still approves on Skills → Proposals.
 */
import { and, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { buildAgentContext, fundingFor } from '@/core/agent/context';
import { ToolPolicyRefusalError } from '@/core/tool-execution-error';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { agentEventRepository } from '@/db/repositories/agent-event-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { kvStore } from '@/db/schema/kv';
import { skillProposals } from '@/db/schema/skill-proposals';
import { users } from '@/db/schema/users';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import { ApprovalBlockedError, withDispatchAuthorization } from '@/security/dispatch-authorization';
import { getPermissionManager } from '@/security/permissions';
import type {
  DistillNudgeDecision, DistillNudgeErrorCode, DistillNudgeOutcome, DistillNudgeRecord, DistillNudgeView,
} from '@/shared/distill-nudge';
import { takeRunSkillUse } from '@/skills/run-skill-use';
import type { DistillResult } from '@/tools/skill-distill/distill';
import { coreLogger } from '@/utils/logger';
import {
  boundRunMaterial, type DistillNudgeThresholds, MAX_DISTILL_ATTEMPTS, type NudgeTurnFacts, nudgeSignalsDecision,
  nudgeTurnGate, type RunEventRow, summarizeRunEvents, verificationPassed,
} from './distill-nudge';

/** The `kv_store` key of a user's cool-down; its expiry is the end of the cool-down. */
export const distillNudgeCooldownKey = (userId: string) => `learning:distill-nudge:${userId}`;
/** Action events read per run: far more than a turn's tool calls; a runaway run is complex at any cut. */
const MAX_RUN_EVENTS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A provider error that says the input does not fit: retrying the same material fails the same way. */
const TOO_LARGE_RE = /context (length|window)|too (long|large)|maximum (context|input)|prompt is too long|max_tokens/i;

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

/**
 * One of the user's open, or rejected and still suppressed, proposals came
 * from this session (`session:<id>` from `distill_skill`,
 * `learning:<job>:session:<id>` from a check). The user's rows only (indexed
 * by user), matched on the text of their sources: a session id is a uuid, so
 * `session:<id>"` occurs in no other ref.
 */
async function sessionHasProposal(userId: string, sessionId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: skillProposals.id }).from(skillProposals).where(and(
    eq(skillProposals.userId, userId), ne(skillProposals.kind, 'patch'),
    or(inArray(skillProposals.status, ['pending', 'candidate']),
      and(eq(skillProposals.status, 'rejected'), sql`${skillProposals.rejectedUntil} > now()`)),
    or(eq(skillProposals.sourceRef, `session:${sessionId}`), sql`${skillProposals.sourceRefs}::text LIKE ${`%session:${sessionId}"%`}`),
  )).limit(1);
  return !!row;
}

async function optedOut(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ off: sql<boolean>`coalesce(${users.preferences}->>'distillNudge', 'true') = 'false'` })
    .from(users).where(eq(users.id, userId)).limit(1);
  return row?.off === true;
}

/** The run's tool calls, as far as `summarizeRunEvents` needs them: names only, never the payloads. */
async function runActions(runId: string, userId: string): Promise<RunEventRow[]> {
  const rows = await agentEventRepository.findRunToolCalls(runId, userId, MAX_RUN_EVENTS);
  return rows.map((row) => ({
    agentId: row.agentId,
    type: 'action',
    data: {
      ...(row.kind ? { type: row.kind } : {}),
      ...(row.toolName ? { toolName: row.toolName } : {}),
      ...(Array.isArray(row.toolCalls) && row.toolCalls.length
        ? { toolCalls: row.toolCalls.filter((name): name is string => typeof name === 'string').map((name) => ({ name })) } : {}),
    },
  }));
}

/**
 * Take the user's cool-down: one statement, so of two turns ending at once
 * only one is offered. Returns the claim's value (to release it) or null
 * when the cool-down is running. A cool-down of 0 hours claims nothing.
 */
async function claimCooldown(userId: string, hours: number, now = new Date()): Promise<string | null | 'none'> {
  if (hours === 0) return 'none';
  const until = new Date(now.getTime() + hours * 3_600_000);
  const value = `${now.toISOString()} ${crypto.randomUUID()}`;
  const rows = await getDb().insert(kvStore)
    .values({ key: distillNudgeCooldownKey(userId), value, expiresAt: until })
    .onConflictDoUpdate({
      target: kvStore.key,
      set: { value, expiresAt: until },
      setWhere: sql`${kvStore.expiresAt} IS NOT NULL AND ${kvStore.expiresAt} <= ${now.toISOString()}::timestamptz`,
    })
    .returning({ key: kvStore.key });
  return rows.length > 0 ? value : null;
}

/** Give back a claim whose offer was not made: a failed offer costs the user nothing. */
async function releaseCooldown(userId: string, value: string): Promise<void> {
  await getDb().delete(kvStore).where(and(eq(kvStore.key, distillNudgeCooldownKey(userId)), eq(kvStore.value, value)));
}

/** Tell the user's clients an offer was made, so the web chat reads it. Logged, not thrown: the offer is stored. */
async function announce(userId: string, sessionId: string, messageId: string): Promise<void> {
  try {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    getGatewayHub().publishEvent({ type: 'session.skill_nudge', source: 'distill-nudge', userId, sessionId, payload: { messageId } });
  } catch (err) {
    coreLogger.error({ err, sessionId }, 'Distil offer made, but session.skill_nudge could not be published');
  }
}

/**
 * After a root turn's answer is delivered: offer to distil it when it
 * qualifies, by putting an `offered` record on its stored answer, then
 * publishing `session.skill_nudge`. Reads only what the run recorded,
 * cheapest first, and stops at the first reason not to; calls no model.
 * The caller does not wait for it.
 */
export async function offerDistillNudge(turn: DistillNudgeTurn): Promise<{ messageId: string } | null> {
  const skillInjected = takeRunSkillUse(turn.runId);
  const limits = thresholds();
  const skip = (reason: string) => {
    coreLogger.debug({ runId: turn.runId, reason }, 'Distil offer skipped');
    return null;
  };
  const gate = nudgeTurnGate(turn.facts, limits);
  if (gate) return skip(gate);
  if (!UUID_RE.test(turn.userId) || !UUID_RE.test(turn.sessionId)) return skip('not_personal');
  if (await optedOut(turn.userId)) return skip('opted_out');
  const signals = summarizeRunEvents(await runActions(turn.runId, turn.userId), turn.rootAgentId);
  const bySignals = nudgeSignalsDecision(signals, skillInjected, limits);
  if (bySignals) return skip(bySignals);
  const db = getDb();
  const [verdicts, sessionProposal] = await Promise.all([
    db.select({ kind: verificationEvidence.kind, stage: verificationEvidence.stage, nodeId: verificationEvidence.nodeId,
      passed: verificationEvidence.passed, createdAt: verificationEvidence.createdAt }).from(verificationEvidence)
      .where(and(eq(verificationEvidence.sessionId, turn.sessionId), gte(verificationEvidence.createdAt, turn.startedAt))),
    sessionHasProposal(turn.userId, turn.sessionId),
  ]);
  if (verificationPassed(verdicts) === false) return skip('verification_failed');
  if (sessionProposal) return skip('proposal_exists');

  const claim = await claimCooldown(turn.userId, getConfig().learning.distillNudgeCooldownHours);
  if (claim === null) return skip('cooling_down');
  const record: DistillNudgeRecord = {
    state: 'offered', runId: turn.runId, userId: turn.userId,
    startedAt: turn.startedAt.toISOString(), offeredAt: new Date().toISOString(),
  };
  let written = false;
  try {
    written = await messageRepository.putSkillNudge(turn.answerMessageId, turn.sessionId, record);
  } finally {
    if (!written && claim !== 'none') await releaseCooldown(turn.userId, claim);
  }
  if (!written) return skip('answer_gone');
  coreLogger.info({ runId: turn.runId, sessionId: turn.sessionId, signals }, 'Distil offer made');
  await announce(turn.userId, turn.sessionId, turn.answerMessageId);
  return { messageId: turn.answerMessageId };
}

/** The session's latest shown answer: the only one whose offer is open. A personal chat's only. */
const latestAnswer = (sessionId: string) => messageRepository.findLatestPersonalAnswer(sessionId);

/**
 * The session's open offer: on its latest shown answer, still undecided, of
 * `userId`. An offer lapses when another answer follows it. The caller has
 * checked that `userId` may act in the session.
 */
export async function openDistillNudge(sessionId: string, userId: string): Promise<DistillNudgeView | null> {
  const latest = await latestAnswer(sessionId);
  const nudge = latest?.metadata?.skillNudge;
  if (!latest || !nudge || nudge.state !== 'offered' || nudge.userId !== userId) return null;
  return { messageId: latest.id, offeredAt: nudge.offeredAt };
}

export class DistillNudgeError extends Error {
  override name = 'DistillNudgeError';
  /** `failed` only: the offer is closed (`failed`), a retry is not offered. */
  readonly final: boolean;
  constructor(readonly code: DistillNudgeErrorCode, message: string, opts: { final?: boolean } = {}) {
    super(message);
    this.final = opts.final === true;
  }
}

/** Move the offer from `from` to `next`; false when it was not in `from` (decided meanwhile). */
const transition = (messageId: string, from: DistillNudgeRecord['state'], next: DistillNudgeRecord) =>
  messageRepository.moveSkillNudge(messageId, from, next);

/**
 * The material of an offer its owner has just accepted (`distill_skill`
 * source `run`, which only the offer dispatches): the run's messages from its
 * start to the answer, and the tools it used, bounded by `boundRunMaterial`.
 * Refused for any message of the session that does not carry an accepted
 * offer of `userId`, so the source cannot distil anything else.
 */
export async function acceptedRunMaterial(sessionId: string, messageId: string, userId: string): Promise<{ material: string } | { error: string }> {
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(messageId)) return { error: "source='run' is only for an accepted distil offer" };
  const answer = await messageRepository.findPersonalInSession(messageId, sessionId);
  const nudge = answer?.metadata?.skillNudge;
  if (!answer || !nudge || nudge.state !== 'accepted' || nudge.userId !== userId) return { error: "source='run' is only for an accepted distil offer" };
  const [rows, actions] = await Promise.all([
    messageRepository.findPersonalBetween(sessionId, new Date(nudge.startedAt), answer.createdAt),
    runActions(nudge.runId, nudge.userId),
  ]);
  const tools = [...new Set(actions.flatMap(({ data }) => {
    const d = data as { type?: string; toolName?: string };
    return (d.type === 'tool_call' || d.type === 'cli_tool_use') && d.toolName ? [d.toolName] : [];
  }))];
  const material = boundRunMaterial(rows, tools);
  return material ? { material } : { error: 'This run left no messages to distil.' };
}

/**
 * Dispatch `distill_skill` for the accepted offer on `messageId`, through
 * the tool's middleware. The click is the owner's approval of this one call
 * when the policy is ALLOW or a plain ASK (no expiry, no failed condition,
 * no other reason attached): it is handed to the dispatch as a one-call
 * receipt, so the audit row records `approval:distill-nudge:<messageId>`.
 * Any other ASK (an expired policy, a failed condition) gets no receipt: the
 * dispatch finds nobody to ask and refuses (`ApprovalBlockedError`), as for
 * any unattended call. A DENY, or a `tool:before` handler, refuses it.
 */
async function dispatchDistill(sessionId: string, workspaceId: string | null, messageId: string, userId: string): Promise<DistillResult | { error: string; code?: undefined }> {
  const { skillDistillTool } = await import('@/tools/skill-distill');
  if (!skillDistillTool.getTool('distill_skill')) await skillDistillTool.initialize();
  const handler = skillDistillTool.getTool('distill_skill');
  if (!handler) throw new Error('distill_skill is not registered');
  const context = buildAgentContext({
    id: `distill-nudge-${messageId}`, sessionId, userId,
    scope: { workspaceId, space: null, trigger: 'user', funding: fundingFor('user', null) },
    topic: 'background', model: 'distill-nudge', role: 'general',
    // A request has no approval channel: what the click does not cover is refused, not asked.
    attended: false, status: 'running', metadata: { source: 'distill-nudge', messageId },
  });
  const args = { source: 'run', ref: messageId };
  const call = () => handler.execute(args, context) as Promise<DistillResult | { error: string }>;
  const pre = await getPermissionManager().check(userId, 'skill-distill', 'distill', args, context, { defaultLevel: 'ALLOW' });
  const clickApproves = pre.level === 'ALLOW' || (pre.level === 'ASK' && !pre.reason);
  return clickApproves
    ? withDispatchAuthorization(context, 'skill-distill', 'distill', args, `approval:distill-nudge:${messageId}`, call)
    : call();
}

/** A thrown dispatch error that is a refusal (policy, plugin, approval), not a failure of the work. */
function isRefusal(err: unknown): boolean {
  return err instanceof ToolPolicyRefusalError || err instanceof ApprovalBlockedError
    || /denied by policy|Permission denied|not granted|revoked/i.test((err as Error)?.message ?? '');
}

/**
 * The owner's decision on the offer on `messageId`, which must be the
 * session's latest answer (`lapsed` otherwise). Each offer takes one
 * decision: a second one is `decided`. `never` also turns the offers off for
 * the user. `accept` distils the run into a pending proposal. When that does
 * not happen the offer is open again, unless retrying would fail the same way
 * (the reply was cut off, the material is too large for the model) or it has
 * failed `MAX_DISTILL_ATTEMPTS` times: then it is closed as `failed`.
 *
 * The caller has checked that `userId` may act in the session and is its owner.
 */
export async function resolveDistillNudge(sessionId: string, messageId: string, userId: string, decision: DistillNudgeDecision): Promise<DistillNudgeOutcome> {
  const row = await messageRepository.findPersonalInSession(messageId, sessionId);
  const nudge = row?.metadata?.skillNudge;
  if (!row || !nudge || nudge.userId !== userId) throw new DistillNudgeError('not_found', 'No offer to distil this answer.');
  if (nudge.state !== 'offered') throw new DistillNudgeError('decided', `This offer was already ${nudge.state}.`);
  if ((await latestAnswer(sessionId))?.id !== messageId) {
    throw new DistillNudgeError('lapsed', 'This offer lapsed: another answer followed it. Ask the agent to distil the conversation into a skill instead.');
  }
  const decidedAt = new Date().toISOString();

  if (decision !== 'accept') {
    if (!(await transition(messageId, 'offered', { ...nudge, state: 'dismissed', decidedAt }))) {
      throw new DistillNudgeError('decided', 'This offer was already decided.');
    }
    if (decision === 'never') {
      await userRepository.setDistillNudge(userId, false);
      await auditRepository.log({ userId, action: 'settings_changed', resourceType: 'user', resourceId: userId,
        details: { setting: 'preferences.distillNudge', enabled: false, via: 'distill-nudge' } })
        .catch((error) => coreLogger.error({ error, userId }, 'Distil offer preference saved but audit write failed'));
    }
    return decision === 'never'
      ? { state: 'dismissed', optedOut: true, message: 'You will not be offered this again. Turn it back on under Settings → Profile.' }
      : { state: 'dismissed', message: 'Not distilled.' };
  }

  // Taken before the model call, so a second click cannot distil twice.
  const accepted: DistillNudgeRecord = { ...nudge, state: 'accepted', decidedAt };
  if (!(await transition(messageId, 'offered', accepted))) throw new DistillNudgeError('decided', 'This offer was already decided.');
  /** Back to `offered` (counting a failure that spent a model call), or closed as `failed`. */
  const settle = async (code: DistillNudgeErrorCode, message: string, opts: { spent?: boolean; final?: boolean } = {}): Promise<never> => {
    const failures = (nudge.failures ?? 0) + (opts.spent ? 1 : 0);
    const final = opts.final === true || failures >= MAX_DISTILL_ATTEMPTS;
    const next: DistillNudgeRecord = final
      ? { ...nudge, state: 'failed', failures, decidedAt, error: message }
      : { ...nudge, ...(failures ? { failures } : {}) };
    if (!(await transition(messageId, 'accepted', next))) coreLogger.warn({ messageId }, 'Distil offer could not be settled after a failed accept');
    throw new DistillNudgeError(code, final ? `${message} The offer is closed.` : message, { final });
  };

  let result: Awaited<ReturnType<typeof dispatchDistill>>;
  try {
    const session = await sessionRepository.findById(sessionId);
    result = await dispatchDistill(sessionId, session?.workspaceId ?? null, messageId, userId);
  } catch (err) {
    if (isRefusal(err)) return settle('refused', `Distilling a skill is not allowed here: ${(err as Error).message}`);
    coreLogger.error({ err, messageId }, 'Distil offer: distillation failed');
    const message = `Distillation failed: ${(err as Error).message}`;
    return settle('failed', message, { spent: true, final: TOO_LARGE_RE.test(message) });
  }
  if ('error' in result) {
    if (result.code === 'truncated') return settle('failed', result.error, { spent: true, final: true });
    if (result.code === 'malformed') return settle('failed', result.error, { spent: true });
    return settle('failed', result.error);
  }
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
