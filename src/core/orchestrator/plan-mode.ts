/**
 * Plan mode — explore and propose, change nothing, leave only by submitting.
 *
 * Octipus had a `plan` TOOLBOX (`add_items`/`list_items`/`update_item`), which
 * is a pipeline's work-item list and a genuinely different thing: it records
 * what a running pipeline will loop over. What it is not is a mode. Nothing
 * stopped an agent asked for a plan from writing files halfway through
 * producing one, and "please just plan it first" was a request the model could
 * decline by simply getting on with the work.
 *
 * Three parts, because a mode is only as real as its weakest one:
 *
 *  1. The tools. The file-mutating handlers are stripped, reusing the same
 *     `FILE_CHANGE_TOOLS` filter the read-only roles use — one list, so a tool
 *     added to one path cannot be forgotten on the other.
 *  2. The instruction, which covers what the filter cannot: `shell` still holds
 *     `>` and `tee`, exactly as the read-only role comment has always said.
 *     Defense in depth, not a boundary, and said out loud rather than implied.
 *  3. The exit. `exit_plan_mode` submits the plan and clears the flag. An agent
 *     that could clear it by deciding it had finished planning would be back to
 *     asking permission of itself.
 */

import type { ToolHandler } from '@/core/agent-base';
import { FILE_CHANGE_TOOLS } from '@/core/tool-executor';

/**
 * The mutating handlers a planning turn does not get.
 *
 * Shared with the read-only role filter on purpose: two lists of "what counts
 * as a write" drift, and the one that drifts is the one nobody is looking at.
 */
export function stripMutatingTools(handlers: ToolHandler[]): ToolHandler[] {
  return handlers.filter((h) => !FILE_CHANGE_TOOLS.has(h.name));
}

/**
 * The plan-mode directive.
 *
 * Names the specific ways out that the tool filter cannot close — a shell
 * redirect, a formatter, a commit — because those are what an agent reaches for
 * when the obvious route is missing, and because a rule the model has to infer
 * is a rule it will infer differently under pressure.
 *
 * The last paragraph is the one that matters: agreement is not approval. A user
 * saying "yes, sounds good" mid-conversation is not the same as the plan having
 * been submitted and accepted, and an agent that treats it as such has left plan
 * mode without anyone deciding it should.
 */
export const PLAN_MODE_DIRECTIVE = `

---
PLAN MODE IS ON. You are working out WHAT to do. You are not doing it.

Explore freely: read files, search, run tests and read-only checks, inspect git
history. Ground the plan in what is actually there rather than what is usually
there.

Change nothing. No writing or editing files, no creating or deleting them, no
commits, no formatters or code generation that rewrites tracked files, no
installs, no configuration changes. The file-writing tools have been withheld
for this turn; the shell has not, so a redirect (\`>\`, \`tee\`), an \`-i\` flag or a
commit would still work. Do not use them. That restraint is the mode.

When the plan is ready, call \`exit_plan_mode\` with the whole plan as markdown.
That is the ONLY way out, and it is a submission for approval, not an
announcement. Do not paste the plan as an ordinary reply and start work.

Conversational agreement approves nothing. If the user says "yes" or "go ahead"
mid-discussion, fold what they confirmed into the plan and submit it — the
approval happens on the submission, not in the chat.`;

/** Does this session plan rather than act? */
export function isPlanMode(sessionContext: { planMode?: boolean } | undefined): boolean {
  return sessionContext?.planMode === true;
}

/**
 * Turn plan mode on, off, or over — and report what happened.
 *
 * One implementation because there are two command surfaces (the chat path
 * through `core/commands`, the gateway path the TUI uses) and a mode that means
 * something different depending on where you typed it is not a mode.
 */
export async function togglePlanMode(
  sessionId: string,
  arg: string,
): Promise<{ on: boolean; text: string }> {
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  const existing = (session?.context ?? {}) as Record<string, unknown>;
  const current = existing.planMode === true;
  const a = arg.trim().toLowerCase();
  const on = a === 'on' ? true : a === 'off' ? false : !current;
  await sessionRepository.update(sessionId, { context: { ...existing, planMode: on } });
  return {
    on,
    text: on
      ? 'Plan mode ON — I will explore and propose, and change nothing. The file-writing tools are ' +
        'withheld until the plan is submitted with `exit_plan_mode`, and any specialist I delegate to ' +
        'inherits the same restriction.'
      : 'Plan mode OFF — I can make changes again.',
  };
}
