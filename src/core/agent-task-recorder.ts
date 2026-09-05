/**
 * Memory-redesign Phase B — records the final output of a completed
 * agent into the `task_state` table so siblings and follow-up sessions
 * can discover it via typed lookup. Replaces `auto-indexer.ts`, which
 * pushed agent outputs into the RAG `embeddings` table where they
 * polluted similarity search.
 *
 * Same skip-rules as the previous indexer:
 *   - root agent outputs are skipped (they are summaries of worker
 *     outputs and would just duplicate signal),
 *   - trivially-short outputs (< MIN_OUTPUT_LENGTH chars) are skipped
 *     to avoid recording every "ok" / "done".
 *
 * The whole call is wrapped in try/catch and logged at debug — recording
 * task state is observational, never load-bearing on the agent's own
 * completion path. The previous indexer had the same guarantee.
 */

import { getTaskStateRepository } from '@/db/repositories/task-state-repository';
import { coreLogger } from '@/utils/logger';

const MIN_OUTPUT_LENGTH = 100;

export interface AgentCompletionInput {
  agentId: string;
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
  swarmNodeId?: string | null;
  role: string;
  /** The turn's root agent — its output is the answer, not a recorded task. */
  root?: boolean;
  topic?: string;
  output: string;
  /**
   * Override the auto-derived task_kind. Most callers should omit
   * this — `taskKindForRole(role)` already picks the right value
   * based on the agent's role. Set explicitly when a single agent
   * produces multiple kinds in one session (e.g. a review agent
   * filing a `finding` row separate from its own `review` row).
   */
  taskKind?: string;
}

/**
 * Map a role id to the canonical `task_state.task_kind` value.
 *
 * - `review`              → `review`   (peer-output critique)
 * - `qa`, `security`      → `finding`  (audit-style observations)
 * - everything else       → `agent_output` (default)
 *
 * The mapping is intentionally small. Adding kinds is cheap (free-text
 * column), but every new kind needs a matching reader: the
 * task_state tool's owner_agent filter already covers role-based
 * querying, so most workflows can stay on the default.
 */
export function taskKindForRole(role: string): string {
  switch (role) {
    case 'review':
      return 'review';
    case 'qa':
    case 'security':
      return 'finding';
    default:
      return 'agent_output';
  }
}

export function isAgentTaskRecordingEnabled(): boolean {
  const envVal = process.env.AGENT_TASK_RECORDING;
  if (envVal !== undefined) {
    return envVal !== 'false' && envVal !== '0';
  }
  return true;
}

export async function recordAgentCompletion(input: AgentCompletionInput): Promise<void> {
  if (!isAgentTaskRecordingEnabled()) return;
  if (!input.output || input.output.length < MIN_OUTPUT_LENGTH) return;
  if (input.root) return;

  const taskKind = input.taskKind ?? taskKindForRole(input.role);

  try {
    await getTaskStateRepository().create({
      sessionId: input.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      swarmNodeId: input.swarmNodeId ?? null,
      ownerAgent: input.role,
      taskKind,
      status: 'done',
      inputs: input.topic ? { topic: input.topic } : {},
      outputs: { agentId: input.agentId, text: input.output },
    });
  } catch (err) {
    // Non-fatal. The agent's own status was already persisted by the
    // worker; failing to record task_state means siblings won't find
    // this output but everything else proceeds.
    coreLogger.debug(
      { err, agentId: input.agentId, role: input.role },
      'recordAgentCompletion failed (non-fatal)',
    );
  }
}
