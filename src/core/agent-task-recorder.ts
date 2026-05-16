/**
 * Memory-redesign Phase B — records the final output of a completed
 * agent into the `task_state` table so siblings and follow-up sessions
 * can discover it via typed lookup. Replaces `auto-indexer.ts`, which
 * pushed agent outputs into the RAG `embeddings` table where they
 * polluted similarity search.
 *
 * Same skip-rules as the previous indexer:
 *   - orchestrator outputs are skipped (they are summaries of worker
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
  topic?: string;
  output: string;
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
  if (input.role === 'orchestrator') return;

  try {
    await getTaskStateRepository().create({
      sessionId: input.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      swarmNodeId: input.swarmNodeId ?? null,
      ownerAgent: input.role,
      taskKind: 'agent_output',
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
