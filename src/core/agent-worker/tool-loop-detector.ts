import type { ToolCall } from '../types';

/**
 * Owns the tool-call loop/spam detection state for an AgentWorker: consecutive
 * identical calls (same name + args) and consecutive same-tool-name bursts.
 * Extracted verbatim from AgentWorker — thresholds, allow-lists and the
 * bump/reset semantics are unchanged.
 *
 * The detector is state-only: it returns a verdict per iteration and the loop
 * applies the side effects (synthetic tool results, nudge messages, disabling
 * tools). Keeping side effects out avoids a leaky class that would need the
 * whole worker passed in.
 */

/** Track consecutive identical tool calls (same name + args) to detect loops. */
const MAX_CONSECUTIVE_REPEATS = 3;

/**
 * After this many consecutive iterations on the same tool-name signature,
 * tools get disabled and the model is forced to a plain-text reply. The
 * threshold has to be high enough to survive normal doer workflows
 * (read 8 files → write 5 files often hits the same name pattern across
 * 3-4 iterations) and low enough to still catch genuine spam loops on
 * status/notification tools. 5 is the empirical sweet spot.
 */
const MAX_SAME_NAME_REPEATS = 5;

/**
 * Tools that are LEGITIMATELY called many times in a row. The same-tool-
 * name guard is meant to catch chatty status-report / notification loops
 * (`send_status_update` spinning with slightly different progress
 * messages), NOT productive work like reading or writing files. Anything
 * that produces real side effects / new state belongs here.
 *
 * Matching is exact-name AND by namespace prefix (`filesystem__`,
 * `shell__`, `git__`, `web_`, `code__`) — see REPEAT_ALLOWED_PREFIXES.
 * Status / notification tools stay off this list so the guard still
 * catches them.
 */
const REPEAT_ALLOWED_TOOLS = new Set<string>([
  'spawn_child',
  'collect_children',
  'create_pipeline',
  'list_pipeline_templates',
  'request_user_approval',
]);

/**
 * Namespace prefixes (matched via tc.name.startsWith) for tools that
 * always count as productive work — file I/O, shell, git, web fetches,
 * code edits. The doer roles (coding, design, devops) routinely chain
 * many of these in sequence and tripping the same-name guard wastes
 * their progress.
 */
const REPEAT_ALLOWED_PREFIXES = ['filesystem__', 'shell__', 'git__', 'web_', 'code__', 'search_'];

/**
 * A call with identical arguments made this many times ANYWHERE in a run — not
 * necessarily back to back — is re-deriving something the transcript already
 * holds. The consecutive check above never sees an A,B,A,B,A ping-pong, which
 * is the shape behind the measured tool-call variance: the same task cost 2
 * calls one run and 14 the next.
 *
 * Four, not three: a legitimate re-read after a write is the second call, and
 * a verify-after-fix is a defensible third. The fourth is waste, so it is the
 * first one nudged.
 */
export const MAX_TOTAL_REPEATS = 4;

/** Verdict of the same-signature (name + args) check. */
export type RepeatVerdict = { tripped: boolean; repeats: number };
/** Verdict of the same-name-burst check. */
export type SameNameVerdict = { tripped: boolean; signature: string; repeats: number };
/** Verdict of the run-wide redundant-call check. */
export type RedundantVerdict = { tripped: boolean; signature: string; count: number };

export class ToolLoopDetector {
  private lastToolCallSignature = '';
  private consecutiveRepeatCount = 0;

  private lastToolNames = '';
  private consecutiveSameNameCount = 0;

  /** How many times each individual call signature has been made this run. */
  private readonly signatureCounts = new Map<string, number>();
  /** Signatures already nudged — one nudge per signature, not one per repeat. */
  private readonly nudgedSignatures = new Set<string>();

  /**
   * Same tool + same args N times in a row. Mutates internal counters; returns
   * whether the loop should be broken this iteration.
   */
  checkRepeat(toolCalls: ToolCall[]): RepeatVerdict {
    const callSignature = toolCalls
      .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
      .join('|');
    if (callSignature === this.lastToolCallSignature) {
      this.consecutiveRepeatCount++;
      if (this.consecutiveRepeatCount >= MAX_CONSECUTIVE_REPEATS) {
        return { tripped: true, repeats: this.consecutiveRepeatCount };
      }
    } else {
      this.lastToolCallSignature = callSignature;
      this.consecutiveRepeatCount = 1;
    }
    return { tripped: false, repeats: this.consecutiveRepeatCount };
  }

  /**
   * Same tool NAME (any args) N times in a row — catches chatty status/
   * notification spam the per-signature check misses. Productive-work bursts
   * (allow-listed names/prefixes) skip the guard entirely. Returns whether to
   * disable tools + the offending signature for the nudge message.
   */
  checkSameName(toolCalls: ToolCall[]): SameNameVerdict {
    const toolNameSignature = [...toolCalls].map((tc) => tc.name).sort().join(',');
    const callsAllowList = toolCalls.every((tc) =>
      REPEAT_ALLOWED_TOOLS.has(tc.name) || REPEAT_ALLOWED_PREFIXES.some((p) => tc.name.startsWith(p)),
    );
    if (!callsAllowList && toolNameSignature === this.lastToolNames) {
      this.consecutiveSameNameCount++;
      if (this.consecutiveSameNameCount >= MAX_SAME_NAME_REPEATS) {
        return { tripped: true, signature: toolNameSignature, repeats: this.consecutiveSameNameCount };
      }
    } else {
      this.lastToolNames = toolNameSignature;
      this.consecutiveSameNameCount = 1;
    }
    return { tripped: false, signature: toolNameSignature, repeats: this.consecutiveSameNameCount };
  }

  /**
   * Same tool + same args repeated across the whole run. Unlike the two checks
   * above this is advisory: the caller lets the call execute (a re-read after a
   * write returns different content, so skipping it would be wrong) and appends
   * a nudge once the tool results have closed the turn. Nudges once per
   * signature so a stubborn model is not told the same thing every iteration.
   */
  checkRedundant(toolCalls: ToolCall[]): RedundantVerdict {
    let worst: RedundantVerdict = { tripped: false, signature: '', count: 0 };
    let worstSig = '';
    for (const tc of toolCalls) {
      const sig = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      const count = (this.signatureCounts.get(sig) ?? 0) + 1;
      this.signatureCounts.set(sig, count);
      if (count < MAX_TOTAL_REPEATS || this.nudgedSignatures.has(sig)) continue;
      if (count > worst.count) {
        worst = { tripped: true, signature: tc.name, count };
        worstSig = sig;
      }
    }
    // Only the signature actually REPORTED is marked as nudged. Marking every
    // tripped signature here burned the losers of a same-iteration tie — a
    // parallel tool-call batch can trip two at once, and the one that lost the
    // comparison was recorded as nudged without a nudge ever being emitted, so
    // it could never be reported again for the rest of the run.
    if (worstSig) this.nudgedSignatures.add(worstSig);
    return worst;
  }
}
