/**
 * Auto-indexer — indexes agent outputs into the knowledge base on completion.
 *
 * Listens to agent completion events and stores the final output as embeddings
 * so future agents can retrieve past work via search_knowledge.
 */

import { getEmbeddingService } from './embeddings';
import { coreLogger } from '@/utils/logger';
import { getConfig } from '@/config';

const MIN_OUTPUT_LENGTH = 100; // Skip trivially short outputs

export interface AutoIndexInput {
  agentId: string;
  sessionId: string;
  userId: string;
  role?: string;
  topic?: string;
  output: string;
}

/**
 * Check if auto-indexing is enabled via config/env.
 */
export function isAutoIndexEnabled(): boolean {
  const envVal = process.env.RAG_AUTO_INDEX;
  if (envVal !== undefined) {
    return envVal !== 'false' && envVal !== '0';
  }
  return true; // Default enabled
}

/**
 * Index an agent's output into the knowledge base.
 * Called after agent completion. Runs async — failures are logged but don't block.
 */
export async function autoIndexAgentOutput(input: AutoIndexInput): Promise<void> {
  if (!isAutoIndexEnabled()) return;
  if (!input.output || input.output.length < MIN_OUTPUT_LENGTH) return;

  // Skip orchestrator outputs (they're just summaries of worker outputs)
  if (input.role === 'orchestrator') return;

  try {
    const service = getEmbeddingService();
    const sourceId = `agent:${input.agentId}`;

    const chunks = await service.indexText('agent_output', sourceId, input.output, {
      filePath: `agent/${input.role || 'unknown'}/${input.agentId}`,
    });

    if (chunks > 0) {
      coreLogger.info(
        { agentId: input.agentId, role: input.role, chunks },
        'Auto-indexed agent output into knowledge base',
      );
    }
  } catch (err) {
    // Non-fatal — embedding model might be unavailable
    coreLogger.debug(
      { err, agentId: input.agentId },
      'Auto-indexing agent output failed (embedding model may be unavailable)',
    );
  }
}
