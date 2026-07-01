import type { AgentRole } from '@/core/orchestrator/types';
import { coreLogger } from '@/utils/logger';
import type { AgentNode, ChildResult } from './types';

/**
 * Pre-spawn guards for `SwarmSpawner.spawnChild`. These enforce the swarm's
 * load-bearing safety limits — depth cap, same-role starvation guard, per-node
 * fan-out cap, global concurrency cap. Each returns a denial `ChildResult` to
 * surface to the parent LLM, or `null` when the check passes.
 *
 * Kept as pure functions taking explicit args (rather than a class holding a
 * back-reference to the spawner) so the guards stay side-effect-light and
 * unit-testable. Logging matches the original inline call sites verbatim.
 */

/** Build the standard denial result (also logs), shared by depth + same-role. */
export function denialResult(parent: AgentNode, reason: string): ChildResult {
  coreLogger.warn({ parentNodeId: parent.id, depth: parent.depth, reason }, 'Swarm spawn denied');
  return {
    nodeId: '',
    kind: 'agent',
    status: 'denied',
    output: null,
    usedTokens: 0,
    durationMs: 0,
    spawnedChildren: [],
    notes: reason,
  };
}

/**
 * Depth enforcement (Phase 2): Agent (depth 1) spawns Subagent (depth 2).
 * Subagent (depth ≥ 2) can NOT spawn — hard leaf.
 */
export function checkDepth(parent: AgentNode): ChildResult | null {
  if (parent.depth >= 2) {
    return denialResult(
      parent,
      `spawn_child is not available at depth ${parent.depth} (hard leaf — Subagent cannot spawn children).`,
    );
  }
  return null;
}

/**
 * Same-role guard. At depth 0→1 (Orchestrator → Agent) a same-role spawn means
 * delegating a role to itself — refused. At depth 1→2 (Agent → Subagent) it is
 * ALLOWED (parallel fan-out), so this only fires when `childDepth === 1`.
 */
export function checkSameRole(
  parent: AgentNode,
  childRole: AgentRole,
  childDepth: 1 | 2,
): ChildResult | null {
  if (parent.role === childRole && childDepth === 1) {
    return denialResult(
      parent,
      `spawn_child refused: child role '${childRole}' equals parent role '${parent.role}'. ` +
        `You ARE the expert for '${childRole}' — synthesize directly instead of delegating to yourself.`,
    );
  }
  return null;
}

/** Per-node-lifetime fan-out cap enforced against `parent.budget.fanOut`. */
export function checkFanOut(
  parent: AgentNode,
  childKind: 'agent' | 'subagent',
): ChildResult | null {
  if (parent.budget.fanOut.used >= parent.budget.fanOut.cap) {
    coreLogger.warn(
      { parentNodeId: parent.id, used: parent.budget.fanOut.used, cap: parent.budget.fanOut.cap },
      'Swarm fan-out cap reached — refusing spawn',
    );
    return {
      nodeId: '',
      kind: childKind,
      status: 'concurrency_limit',
      output: null,
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      notes: `fan-out cap (${parent.budget.fanOut.cap}) reached; synthesize with existing children or respawn next turn`,
    };
  }
  return null;
}

/** Global concurrency pre-check (Q3) against `config.agent.maxConcurrentAgents`. */
export function checkConcurrency(
  parent: AgentNode,
  childKind: 'agent' | 'subagent',
  running: number,
  maxConcurrent: number,
): ChildResult | null {
  if (running >= maxConcurrent) {
    coreLogger.warn(
      { parentNodeId: parent.id, running, cap: maxConcurrent },
      'Swarm concurrency limit reached — refusing spawn',
    );
    return {
      nodeId: '',
      kind: childKind,
      status: 'concurrency_limit',
      output: null,
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      notes: `Max concurrent agents (${maxConcurrent}) reached`,
    };
  }
  return null;
}
