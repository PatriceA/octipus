/**
 * Attempt ledger — remember every QA-judged attempt at a plan item, so a run
 * that runs out of retries can point at its BEST attempt instead of only its
 * last one.
 *
 * A retry edits the same working tree in place, and a later attempt is not
 * always a better one: a fix for issue B can reintroduce issue A. Without a
 * record, the escalation shows the human the last verdict and nothing else,
 * and the attempt that met four criteria out of five is gone from view. The
 * builder stage commits its work, so each entry carries the HEAD it was judged
 * at — the human can go back to it.
 *
 * Pure: the caller supplies the verdict and the HEAD. No rollback is attempted
 * here on purpose; rewriting a workspace behind a person's back is a decision
 * for that person, not for a retry loop.
 */
import { matchCriteria } from './audit-coverage';
import type { QAValidationResult } from './types';

/** Prefix of the issue the gate adds for each criterion a pass reported unmet. */
export const UNMET_CRITERION_PREFIX = 'Acceptance criterion not met: ';

export interface QaAttempt {
  /** 1-based visit of the auditor for this item. */
  attempt: number;
  passed: boolean;
  criteriaMet: number;
  criteriaTotal: number;
  issues: number;
  /** Short HEAD of the workspace when this attempt was judged; undefined outside git. */
  head?: string;
}

/** One ledger entry from a verdict the gate has already settled. */
export function attemptFromVerdict(
  verdict: QAValidationResult,
  acceptance: string[],
  attempt: number,
  head?: string,
): QaAttempt {
  const criteriaMet = matchCriteria(verdict, acceptance).filter(({ entry }) => entry?.met).length;
  return {
    attempt,
    passed: verdict.passed,
    criteriaMet,
    criteriaTotal: acceptance.length,
    // The gate adds one issue per unmet criterion; those are already counted
    // in `criteriaMet`, and counting them again would rank the attempt twice
    // for the same shortfall.
    issues: verdict.issues.filter((i) => !i.startsWith(UNMET_CRITERION_PREFIX)).length,
    ...(head ? { head } : {}),
  };
}

/**
 * Order: a passing attempt first, then the most criteria met, then the fewest
 * issues. A tie goes to the LATER attempt — it saw the most feedback, and
 * preferring it keeps "best" equal to "latest" whenever nothing got worse.
 */
export function bestAttempt(attempts: QaAttempt[]): QaAttempt | undefined {
  let best: QaAttempt | undefined;
  for (const a of attempts) {
    if (!best || compare(a, best) >= 0) best = a;
  }
  return best;
}

function compare(a: QaAttempt, b: QaAttempt): number {
  if (a.passed !== b.passed) return a.passed ? 1 : -1;
  if (a.criteriaMet !== b.criteriaMet) return a.criteriaMet - b.criteriaMet;
  if (a.issues !== b.issues) return b.issues - a.issues;
  return 0;
}

/**
 * A line for the escalation message when an EARLIER attempt beat the last one;
 * empty when the last attempt is the best (the message already shows it).
 */
export function describeBestAttempt(attempts: QaAttempt[]): string {
  const best = bestAttempt(attempts);
  const last = attempts[attempts.length - 1];
  if (!best || !last || best === last) return '';
  return (
    `Best attempt so far was #${best.attempt}${best.head ? ` (commit ${best.head})` : ''}: ` +
    `${summary(best)}. The latest, #${last.attempt}${last.head ? ` (commit ${last.head})` : ''}, ` +
    `is worse: ${summary(last)}.`
  );
}

function summary(a: QaAttempt): string {
  const criteria = a.criteriaTotal > 0 ? `${a.criteriaMet}/${a.criteriaTotal} criteria met, ` : '';
  return `${criteria}${a.issues} issue${a.issues === 1 ? '' : 's'}`;
}
