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

/** Verdict of the same-signature (name + args) check. */
export type RepeatVerdict = { tripped: boolean; repeats: number };
/** Verdict of the same-name-burst check. */
export type SameNameVerdict = { tripped: boolean; signature: string; repeats: number };

export class ToolLoopDetector {
  private lastToolCallSignature = '';
  private consecutiveRepeatCount = 0;

  private lastToolNames = '';
  private consecutiveSameNameCount = 0;

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
}
