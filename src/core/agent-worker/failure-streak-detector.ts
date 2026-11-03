/**
 * Rounds of tool calls in which nothing worked.
 *
 * The executor blocks a tool after it fails the SAME way three times in a row
 * (`ToolExecutor.trackFailures`), and the loop detector catches identical
 * calls. Neither sees a run that keeps changing its call and keeps failing: a
 * wrong path, then another wrong path, then a missing binary, then a denied
 * command. Each error is new, so no streak grows, and the run spends its whole
 * budget on variations that never produce a result.
 *
 * This counts consecutive iterations in which EVERY tool call failed. One call
 * that returned a result resets it. The first verdict is a nudge (stop varying
 * the call, change approach or report the blocker); if failing rounds continue,
 * the worker disables tools and asks for a plain-text report, the same exit the
 * same-name spam guard takes. The run ends with an answer that says what failed
 * instead of a timeout.
 *
 * State only, like `ToolLoopDetector`: the worker applies the side effects.
 */

/** Consecutive all-failed rounds before the agent is told to change approach. */
export const FAILURE_STREAK_NUDGE_AT = 4;
/** Consecutive all-failed rounds before tools are disabled and a report is forced. */
export const FAILURE_STREAK_STOP_AT = 8;

/** Distinct errors kept for the message the agent sees. */
const MAX_ERRORS = 4;
const MAX_ERROR_CHARS = 160;

export interface ToolBatchOutcome {
  /** Calls in the batch. */
  calls: number;
  /** Calls that returned no result (refused, thrown, blocked). */
  failed: number;
  /** Their error texts. */
  errors: string[];
}

export type FailureStreakVerdict =
  | { action: 'none' }
  | { action: 'nudge' | 'stop'; consecutive: number; errors: string[] };

export class FailureStreakDetector {
  private streak = 0;
  private errors: string[] = [];

  /** Record one iteration's tool batch. */
  record(outcome: ToolBatchOutcome): FailureStreakVerdict {
    if (outcome.calls === 0) return { action: 'none' };
    if (outcome.failed < outcome.calls) {
      this.streak = 0;
      this.errors = [];
      return { action: 'none' };
    }
    this.streak++;
    for (const raw of outcome.errors) {
      const error = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS);
      if (!error || this.errors.includes(error)) continue;
      this.errors.push(error);
      if (this.errors.length > MAX_ERRORS) this.errors.shift();
    }
    if (this.streak >= FAILURE_STREAK_STOP_AT) {
      return { action: 'stop', consecutive: this.streak, errors: [...this.errors] };
    }
    if (this.streak === FAILURE_STREAK_NUDGE_AT) {
      return { action: 'nudge', consecutive: this.streak, errors: [...this.errors] };
    }
    return { action: 'none' };
  }
}

function errorList(errors: string[]): string {
  return errors.length ? ` Recent errors: ${errors.map((e) => `"${e}"`).join('; ')}.` : '';
}

/** What the agent is told on a nudge. */
export function failureStreakNudge(consecutive: number, errors: string[]): string {
  return `[SYSTEM] Every tool call in your last ${consecutive} rounds failed.${errorList(errors)} ` +
    `Do not keep trying variations of the same call. Work out why it fails (a wrong path, a missing ` +
    `dependency, a permission you do not have) and change approach, or stop and report plainly what is blocking you.`;
}

/** What the agent is told when tools are disabled. */
export function failureStreakStop(consecutive: number, errors: string[]): string {
  return `[SYSTEM] Every tool call in your last ${consecutive} rounds failed.${errorList(errors)} ` +
    `Tools are now disabled for this run. Reply with plain text: what you were trying to do, what failed ` +
    `and why, and what the user would need to change for it to work. Do not claim the task is done.`;
}
