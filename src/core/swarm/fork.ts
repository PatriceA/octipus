/**
 * Cache-parity forks: a child that continues its parent's conversation.
 *
 * An ordinary child starts from a role prompt, its own tool set and a brief.
 * It pays a fresh prefix, and it knows nothing its parent read: the spawn
 * challenge has said as much ("a child inherits none of that... re-reads what
 * you have read"). For a side task that needs the parent's context, that is
 * the wrong trade. DeepSeek Harness's fork children and Hermes's background
 * review take the other one: the child's first request is the parent's last
 * request, byte for byte, plus one message — so it reads the parent's cached
 * prefix (a tenth of the price on Claude and OpenAI) and already knows what
 * the parent knows.
 *
 * What makes the bytes match:
 *  - the conversation up to the assistant turn in flight (`forkSnapshot`), which
 *    is exactly the parent's last request;
 *  - the parent's registered handlers in their order, advertised the same way;
 *  - the parent's model, cache scope and pacing.
 *
 * What keeps it safe: the fork holds no tool its parent does not, and it runs
 * under the child's own budget, receipt and node. The parent's handlers that are
 * bound to the PARENT — delegation, collection, the plan exit, the turn's own
 * meta-tools: every handler without a tool group — stay declared (that is the
 * parity) and are refused at call time (`FORK_REFUSED_TOOLS_KEY`), the same way
 * plan mode refuses writes. A turn that may not change files passes that on.
 */

import type { AgentMessage } from '@/core/types';
import type { ToolAdvertisement, ToolHandler } from '@/core/agent-base';
import type { CachePacing } from '@/models/providers/prompt-cache';

/** `AgentContext.metadata` key: this run is a fork; how its requests route. */
export const FORK_KEY = 'fork';
/** `AgentContext.metadata` key: inherited handler names a fork refuses to run. */
export const FORK_REFUSED_TOOLS_KEY = 'forkRefusedTools';

export const FORK_REFUSAL =
  'This is a fork: it does the one task it was given with its tools and cannot delegate, collect or steer children, ' +
  'submit plans or use the conversation\'s own meta-tools. Do the task directly and put the result in your reply.';

export interface ForkSeed {
  messages: AgentMessage[];
  tools: ToolHandler[];
  toolAdvertisement?: ToolAdvertisement;
  model: string;
  modelName?: string;
  cacheScope: string;
  cachePacing: CachePacing;
}

/**
 * The inherited handlers a fork refuses: those bound to the parent run — no
 * tool group, and not one of the process-wide tools every worker registers
 * (`globalNames`: the skill loaders, the work-plan reader), which act on the
 * calling worker's own context.
 */
export function forkRefusedTools(tools: readonly ToolHandler[], globalNames: ReadonlySet<string> = new Set()): string[] {
  return tools.filter((t) => t.toolId === undefined && !globalNames.has(t.name)).map((t) => t.name);
}

/**
 * Whether a child may be a fork. Never one that is meant to be INDEPENDENT of
 * its parent: a reviewer, the verify lane, a maintenance review. A fork is the
 * parent's own conversation on the parent's model holding the parent's tools:
 * a second opinion from it is not one, and in a maintenance session it would
 * hold the review and activation tools the review child is cut down from —
 * the implementer approving its own change.
 */
export function forkAllowed(child: { role: string; topic?: string; maintenanceReview: boolean }): boolean {
  return !child.maintenanceReview && child.role !== 'review' && child.topic !== 'verify';
}

/** The fork's one new message: the task, and what it is. */
export function forkTaskMessage(taskBrief: string, expectedOutput?: { shape?: string; maxTokens?: number }): string {
  const shape = expectedOutput?.shape ? ` Return it as ${expectedOutput.shape}${expectedOutput.maxTokens ? `, at most about ${expectedOutput.maxTokens} tokens` : ''}.` : '';
  return 'SYSTEM: You are now a FORK of this conversation, started to do one task while the conversation continues ' +
    'without you. Everything above is context you already have; do not redo work it shows as done. Do ONLY this task ' +
    `with your tools, then reply with the result — your reply goes back to the conversation, not to the user:${shape}\n\n${taskBrief}`;
}
