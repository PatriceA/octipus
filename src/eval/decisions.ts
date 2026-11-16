/**
 * Fixed-label decision sets (after n8n's nod `decisions.ts`).
 *
 * Some authorization checks can be graded without a model at all: the input
 * is a conversation and a proposed basis, the answer is allow or refuse, and
 * the label is written down before anything runs. This runs Companion's
 * "because you said…" check — `verifyCompanionBasis` in
 * src/core/companion/basis.ts — against such a set, with the real query
 * against a real (throwaway) database, and reports the two ways to be wrong
 * separately:
 *
 *  - an UNSAFE ALLOW: a basis that should have been refused was accepted —
 *    the Companion could act on words the owner never said;
 *  - an EXTRA REFUSAL: a basis that should have been accepted was refused —
 *    the owner is asked again for what they already said.
 *
 * They are not the same cost and are never summed into one accuracy number.
 *
 * Holdout cases (`group: holdout`) were written to probe the rule from a
 * different angle than the cases the code was developed against: paraphrases,
 * quotes lifted from assistant text, monitor rows, internal rows and cleared
 * conversations. Passing them is evidence the rule generalises, not proof.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentTrigger } from '@/core/types';
import { parseYaml } from './loader';

/** Companion writes and whether they need the owner's words from the current message. */
const ACTIONS = {
  start_session: false, message_session: false, steer_session: false, control_session: false, start_maintenance: false,
  create_goal: true, raise_budget: true, cancel_goal: true, retry_incident: true,
} as const;

const triggerSchema = z.enum(['user', 'room', 'schedule', 'monitor', 'listen', 'remote']) satisfies z.ZodType<AgentTrigger>;

const turnSchema = z.union([
  z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
    /** How the row was stored: a monitor or schedule turn is a user row with its trigger. */
    trigger: triggerSchema.optional(),
    visibility: z.enum(['visible', 'internal']).optional(),
    /** Extra age, on top of the conversation order (a message from yesterday). */
    ageHours: z.number().min(0).optional(),
  }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);

export const decisionCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  group: z.enum(['base', 'holdout']),
  action: z.enum(Object.keys(ACTIONS) as [keyof typeof ACTIONS, ...(keyof typeof ACTIONS)[]]),
  /** The turn the action runs in. Default `user` (an owner turn). */
  trigger: triggerSchema.default('user'),
  /** Oldest first. `- clear: true` clears the conversation at that point. */
  conversation: z.array(turnSchema).default([]),
  /** The owner words saved with the goal; absent ⇒ no goal (as for create_goal). */
  goalWords: z.array(z.string().min(1)).optional(),
  /** Exactly what the model would pass. Malformed bases are cases too. */
  basis: z.unknown(),
  expected: z.enum(['allow', 'refuse']),
  note: z.string().optional(),
  /**
   * The label is what the policy should do; the check is known not to (yet).
   * Still counted and shown, but an unsafe allow here does not fail the run on
   * its own — the gap is documented rather than hidden by relabelling the case.
   */
  knownGap: z.string().optional(),
}).strict();
export type DecisionCase = z.infer<typeof decisionCaseSchema>;

export const decisionSetSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().optional(),
  cases: z.array(decisionCaseSchema).min(1),
}).strict().superRefine((set, ctx) => {
  const seen = new Set<string>();
  for (const c of set.cases) {
    if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `Duplicate case id "${c.id}"` });
    seen.add(c.id);
  }
});
export type DecisionSet = z.infer<typeof decisionSetSchema>;

export function parseDecisionSet(text: string): DecisionSet {
  const parsed = decisionSetSchema.safeParse(parseYaml(text));
  if (!parsed.success) throw new Error(`Invalid decision set: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Hash of the set's text, so a baseline from a different set is recognisable. */
export const decisionSetFingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export type DecisionActual = 'allow' | 'refuse' | 'error';

export interface DecisionOutcome {
  id: string;
  group: DecisionCase['group'];
  expected: DecisionCase['expected'];
  actual: DecisionActual;
  correct: boolean;
  /** Should have been refused, was allowed. */
  unsafe: boolean;
  /** Should have been allowed, was refused. */
  extraRefusal: boolean;
  knownGap?: boolean;
  /** The refusal or error text. */
  reason?: string;
}

/**
 * Run one case: a fresh chat session for the eval user holding the case's
 * conversation, then the production check. The session is removed afterwards.
 */
export async function runDecisionCase(item: DecisionCase, userId: string): Promise<DecisionOutcome> {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('@/db/postgres');
  const { sessions } = await import('@/db/schema/sessions');
  const { messages } = await import('@/db/schema/messages');
  const { verifyCompanionBasis, CompanionBasisError } = await import('@/core/companion/basis');

  const db = getDb();
  const [session] = await db.insert(sessions).values({ userId, channelType: 'webchat', channelId: randomUUID(), title: `decision:${item.id}` }).returning({ id: sessions.id });
  try {
    // One minute apart, oldest first, ending a minute ago: inside basis.ts's
    // 24-hour window unless a turn says otherwise.
    const now = Date.now();
    const turns = item.conversation;
    for (const [index, turn] of turns.entries()) {
      const at = new Date(now - (turns.length - index) * 60_000);
      if ('clear' in turn) {
        await db.update(sessions).set({ context: { clearedAt: at.toISOString() } }).where(eq(sessions.id, session.id));
        continue;
      }
      const metadata: Record<string, unknown> = {};
      if (turn.trigger) metadata.trigger = turn.trigger;
      if (turn.visibility) metadata.visibility = turn.visibility;
      await db.insert(messages).values({ sessionId: session.id, role: turn.role, content: turn.content, metadata,
        createdAt: new Date(at.getTime() - (turn.ageHours ?? 0) * 3_600_000) });
    }
    const goal = item.goalWords
      ? { ownerInputs: item.goalWords.map(text => ({ text, origin: 'message' as const, at: new Date(now - 86_400_000).toISOString() })) }
      : null;
    try {
      await verifyCompanionBasis(item.basis, { sessionId: session.id, userId, trigger: item.trigger }, goal, { thisTurn: ACTIONS[item.action] });
      return outcome(item, 'allow');
    } catch (err) {
      return outcome(item, err instanceof CompanionBasisError ? 'refuse' : 'error', (err as Error).message);
    }
  } finally {
    await db.delete(sessions).where(eq(sessions.id, session.id));
  }
}

function outcome(item: DecisionCase, actual: DecisionActual, reason?: string): DecisionOutcome {
  const correct = actual === item.expected;
  return {
    id: item.id, group: item.group, expected: item.expected, actual, correct,
    unsafe: item.expected === 'refuse' && actual === 'allow',
    extraRefusal: item.expected === 'allow' && actual === 'refuse',
    ...(item.knownGap ? { knownGap: true } : {}),
    ...(reason ? { reason } : {}),
  };
}

export async function runDecisionSet(set: DecisionSet, userId: string): Promise<DecisionOutcome[]> {
  const results: DecisionOutcome[] = [];
  for (const item of set.cases) results.push(await runDecisionCase(item, userId));
  return results;
}

export interface DecisionTally {
  cases: number;
  correct: number;
  unsafeAllows: number;
  /** Of the unsafe allows, those on cases marked knownGap. */
  knownGapUnsafeAllows: number;
  extraRefusals: number;
  errors: number;
}

export interface DecisionSummary extends DecisionTally {
  base: DecisionTally;
  holdout: DecisionTally;
}

function tally(outcomes: DecisionOutcome[]): DecisionTally {
  return {
    cases: outcomes.length,
    correct: outcomes.filter(o => o.correct).length,
    unsafeAllows: outcomes.filter(o => o.unsafe).length,
    knownGapUnsafeAllows: outcomes.filter(o => o.unsafe && o.knownGap).length,
    extraRefusals: outcomes.filter(o => o.extraRefusal).length,
    errors: outcomes.filter(o => o.actual === 'error').length,
  };
}

export function summarizeDecisions(outcomes: DecisionOutcome[]): DecisionSummary {
  return { ...tally(outcomes), base: tally(outcomes.filter(o => o.group === 'base')), holdout: tally(outcomes.filter(o => o.group === 'holdout')) };
}

/** What a results file / committed baseline holds. No timestamps, so a re-run with the same outcome is byte-identical. */
export interface DecisionReport {
  set: string;
  fingerprint: string;
  summary: DecisionSummary;
  outcomes: Array<Pick<DecisionOutcome, 'id' | 'group' | 'expected' | 'actual' | 'correct' | 'knownGap'>>;
}

export function decisionReport(set: DecisionSet, fingerprint: string, outcomes: DecisionOutcome[]): DecisionReport {
  return {
    set: set.name,
    fingerprint,
    summary: summarizeDecisions(outcomes),
    outcomes: outcomes.map(({ id, group, expected, actual, correct, knownGap }) => ({ id, group, expected, actual, correct, ...(knownGap ? { knownGap } : {}) })),
  };
}

export interface DecisionComparison {
  /** Correct in the baseline, wrong now. */
  regressions: string[];
  /** Wrong in the baseline, correct now. */
  fixed: string[];
  /** The decision file changed since the baseline was written. */
  setChanged: boolean;
}

export function compareDecisions(baseline: DecisionReport, current: DecisionReport): DecisionComparison {
  const before = new Map(baseline.outcomes.map(o => [o.id, o.correct]));
  return {
    regressions: current.outcomes.filter(o => before.get(o.id) === true && !o.correct).map(o => o.id),
    fixed: current.outcomes.filter(o => before.get(o.id) === false && o.correct).map(o => o.id),
    setChanged: baseline.fingerprint !== current.fingerprint,
  };
}

/**
 * Does this run fail? Any unsafe allow outside a documented known gap fails on
 * its own, whatever the baseline says; so does an error (the check could not
 * answer) and a case that was correct in the baseline and is not now.
 */
export function decisionsFail(summary: DecisionSummary, comparison?: DecisionComparison): boolean {
  return summary.unsafeAllows - summary.knownGapUnsafeAllows > 0 || summary.errors > 0 || (comparison?.regressions.length ?? 0) > 0;
}

export function formatDecisionReport(report: DecisionReport, outcomes: DecisionOutcome[], comparison?: DecisionComparison): string {
  const s = report.summary;
  const row = (label: string, t: DecisionTally) =>
    `  ${label.padEnd(8)} ${t.correct}/${t.cases} correct  |  unsafe allows: ${t.unsafeAllows}${t.knownGapUnsafeAllows ? ` (${t.knownGapUnsafeAllows} known gap)` : ''}  |  extra refusals: ${t.extraRefusals}  |  errors: ${t.errors}`;
  const lines = [`Decision set ${report.set} (${report.fingerprint})`, row('all', s), row('base', s.base), row('holdout', s.holdout)];
  for (const o of outcomes.filter(x => !x.correct)) {
    const label = o.unsafe ? (o.knownGap ? 'unsafe allow (known gap)' : 'UNSAFE ALLOW') : o.extraRefusal ? 'extra refusal' : 'error';
    lines.push(`    ${label}: ${o.id} (expected ${o.expected}, got ${o.actual})${o.reason ? ` — ${o.reason.slice(0, 160)}` : ''}`);
  }
  if (comparison) {
    if (comparison.setChanged) lines.push('  baseline was written for a different version of this set');
    lines.push(`  vs baseline: ${comparison.regressions.length ? `REGRESSED ${comparison.regressions.join(', ')}` : 'no regressions'}${comparison.fixed.length ? `; fixed ${comparison.fixed.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}
