/**
 * Task-drift detection.
 *
 * An agent that quietly stops working on its brief and starts doing something
 * else will run to its budget and then declare success. In run 743d4b66 a
 * research child stopped mentioning football at iteration 8 and spent 29 more
 * iterations authoring documentation about its own tool list, ending with
 * "I've successfully created a comprehensive documentation structure!". Every
 * other guard passed: the output was non-empty, the tool calls succeeded, no
 * budget warning fired. Nothing compared what it was DOING to what it was ASKED.
 *
 * The signal is deliberately dumb and deterministic: does this iteration's tool
 * activity mention anything the brief mentioned? No model call, no embedding,
 * no judgment. It cannot detect subtle drift, and it is not meant to — it is
 * meant to catch an agent that has wandered into a different subject entirely
 * and stayed there.
 *
 * State-only, matching `ToolLoopDetector`: it returns a verdict and the loop
 * applies the consequences. Keeping side effects out avoids a leaky class that
 * would need the whole worker passed in.
 *
 * Biased hard toward false negatives. A missed drift costs tokens; a false
 * positive kills work that was succeeding. Hence: a generous overlap definition
 * (any single shared token clears the iteration), a nudge before any abort, and
 * thresholds with several iterations of slack beyond normal exploration.
 */

/** Minimum word length considered meaningful. Drops "the", "and", "to". */
const MIN_TOKEN_LEN = 4;

/**
 * Tools whose use says nothing about relevance — coordination and discovery
 * machinery whose vocabulary is fixed and will never echo a task brief.
 *
 * An iteration made up entirely of these is NEUTRAL: it neither counts as drift
 * nor clears it. Without this, a root agent polling `collect_children` while
 * a long child works would accumulate a drift signal on every poll and
 * eventually abort — which cascade-cancels the very children it was waiting
 * for. `ToolLoopDetector` learned the same lesson: these names are in its
 * REPEAT_ALLOWED_TOOLS for exactly this reason.
 */
const NEUTRAL_TOOLS = new Set([
  'collect_children',
  'spawn_child',
  'escalate_to_parent',
  'get_skill',
  'list_skills',
  'list_tools',
  'describe_tool',
]);

/**
 * Cap on stringified arguments per tool call before tokenizing. A call carrying
 * a large payload (a file body, a base64 blob) would otherwise be re-tokenized
 * in full just to test for word overlap. The head of the arguments carries the
 * paths and queries that indicate subject matter; the tail is content.
 */
const MAX_ARG_CHARS = 4096;

/**
 * Consecutive off-brief iterations before the agent is NUDGED — told what its
 * task was and asked to re-align. Legitimate work can look off-brief for a
 * stretch (running a test suite, walking a directory tree), so this sits well
 * above normal exploration.
 */
const DRIFT_NUDGE_AFTER = 4;

/**
 * Consecutive off-brief iterations before the run is ABORTED. The agent has by
 * then been told once, explicitly, and carried on regardless. Reaching this
 * means roughly twice the slack of a normal exploratory detour.
 */
const DRIFT_ABORT_AFTER = 8;

/**
 * A brief with fewer distinctive tokens than this is not a usable reference —
 * "fix it" or "continue" would make nearly every iteration look like drift.
 * Such tasks are exempt entirely.
 */
const MIN_BRIEF_TOKENS = 5;

export type DriftVerdict =
  | { action: 'none' }
  | { action: 'nudge'; consecutive: number }
  | { action: 'abort'; consecutive: number };

/** `filesystem__write_file` → `write_file`; a bare name passes through. */
function bareToolName(name: string): string {
  const i = name.indexOf('__');
  return i === -1 ? name : name.slice(i + 2);
}

/** Lowercased words of at least MIN_TOKEN_LEN, deduped. */
export function driftTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= MIN_TOKEN_LEN) out.add(w);
  }
  return out;
}

export class DriftDetector {
  private readonly brief: Set<string>;
  private consecutive = 0;
  private nudged = false;

  /**
   * @param briefText the task as given, PLUS the original user request when the
   *   two differ. Snapshot once at run start — never re-read from the message
   *   list, because compaction evicts the brief (it is a `user` message, and
   *   only `system` messages are pinned). That eviction is the mechanism that
   *   produced the drift in the first place, so a detector reading from there
   *   would go blind at exactly the moment it is needed.
   */
  constructor(briefText: string) {
    this.brief = driftTokens(briefText);
  }

  /** Exempt when the brief carries too little signal to judge against. */
  get enabled(): boolean {
    return this.brief.size >= MIN_BRIEF_TOKENS;
  }

  /**
   * Record one iteration's tool activity and return what the loop should do.
   *
   * Call ONLY for iterations that actually produced tool calls. An iteration
   * with no tool calls is neutral — it neither counts as drift nor clears it,
   * since "the model said something without acting" is a different failure and
   * already has its own guard.
   */
  record(toolCalls: Array<{ name: string; arguments?: unknown }>): DriftVerdict {
    if (!this.enabled || toolCalls.length === 0) return { action: 'none' };

    // Strip the coordination/discovery tools. If nothing else remains, this
    // iteration carries no evidence either way — leave the counter untouched.
    const meaningful = toolCalls.filter((tc) => !NEUTRAL_TOOLS.has(bareToolName(tc.name)));
    if (meaningful.length === 0) return { action: 'none' };

    // Tool names AND arguments: the name alone is too coarse (`write_file`
    // appears in every task), while the arguments carry the paths, queries and
    // content that actually say what the agent is working on.
    let activity = '';
    for (const tc of meaningful) {
      activity += ` ${tc.name}`;
      if (tc.arguments !== undefined) {
        try {
          const s = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
          activity += ` ${s.slice(0, MAX_ARG_CHARS)}`;
        } catch {
          // Circular/unserializable args: skip them rather than fail the check.
          // Fewer tokens means less overlap, so degrade toward the safe
          // direction by treating this iteration as on-task.
          return this.clear();
        }
      }
    }

    for (const token of driftTokens(activity)) {
      if (this.matchesBrief(token)) return this.clear();
    }

    this.consecutive++;
    if (this.consecutive >= DRIFT_ABORT_AFTER) {
      return { action: 'abort', consecutive: this.consecutive };
    }
    // Nudge once only. A second nudge would just burn context re-stating what
    // the agent has already ignored; if it keeps drifting, the abort is next.
    if (this.consecutive >= DRIFT_NUDGE_AFTER && !this.nudged) {
      this.nudged = true;
      return { action: 'nudge', consecutive: this.consecutive };
    }
    return { action: 'none' };
  }

  /**
   * Prefix match rather than equality, so trivial morphology does not read as
   * drift: a brief saying "tests" against a `npm test` command, or "logging"
   * against `logger`. Exact matching made a successful run abortable purely
   * because the agent's vocabulary inflected differently from the brief's.
   *
   * Errs toward matching, which errs toward NOT reporting drift — the safe
   * direction. The 4-char floor keeps prefixes long enough to stay meaningful.
   */
  private matchesBrief(token: string): boolean {
    if (this.brief.has(token)) return true;
    for (const b of this.brief) {
      if (token.startsWith(b) || b.startsWith(token)) return true;
    }
    return false;
  }

  private clear(): DriftVerdict {
    this.consecutive = 0;
    return { action: 'none' };
  }

  /** For the nudge message and the abort error — the brief's distinctive terms. */
  briefSummary(limit = 12): string {
    return [...this.brief].slice(0, limit).join(', ');
  }
}
