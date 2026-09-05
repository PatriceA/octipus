import type { AgentRole } from '@/core/agent/types';
import { coreLogger } from '@/utils/logger';
import { swarmNodeRepository } from './node-repository';
import type { AgentNode, ChildResult } from './types';

/**
 * Result cache (Q4) lookup for identical task briefs, scoped to
 * `rootSessionId`. Self-contained: no `SwarmSpawner` state, only the node
 * repository. A cache hit creates no new node and appends no ledger event — the
 * cached node already carries its own spawn+terminal ledger history.
 *
 * Returns the reusable `ChildResult` plus the payload the caller must feed to
 * `emitNodeCompleted` (emission stays in the spawner so hub coupling does), or
 * `null` on a miss.
 */
export async function lookupCacheHit(
  parent: AgentNode,
  briefHash: string,
  topicPath: string,
  childKind: 'agent' | 'subagent',
  childDepth: 1 | 2,
  childRole: AgentRole,
): Promise<{ result: ChildResult; completedPayload: Record<string, unknown> } | null> {
  const cached = await swarmNodeRepository.findCacheHit(parent.rootSessionId, briefHash);
  if (!cached || !cached.result) return null;

  await swarmNodeRepository.incrementCacheHits(cached.id);
  coreLogger.info(
    { parentNodeId: parent.id, cachedNodeId: cached.id, briefHash, topicPath },
    'Swarm cache hit — skipping spawn',
  );
  // `result` jsonb stores a serialized ChildResult; the schema types it
  // loosely as SwarmChildResult (receipt/scorerOutcome: unknown). Cast
  // back to the structured type — the cached receipt and scorerOutcome,
  // if any, came from buildReceipt / runScorers on the original run. We
  // keep them as-is: they audit the ORIGINAL run that was reused, while
  // the outer `status: 'cache_hit'` signals the reuse.
  const result: ChildResult = {
    ...(cached.result as ChildResult),
    status: 'cache_hit',
  };
  return {
    result,
    completedPayload: {
      nodeId: cached.id,
      parentNodeId: parent.id,
      kind: childKind,
      depth: childDepth,
      topicPath,
      role: childRole,
      status: 'cache_hit',
      cacheHit: true,
    },
  };
}
