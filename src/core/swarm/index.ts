/**
 * Swarm — agent delegation tree (Phase 2: Orchestrator → Agent → Subagent).
 * See `.assistant/swarm-design.md` for the authoritative design.
 */


export type { CallGraphNode, CallGraphSnapshot } from './call-graph';
export {
  __resetCallGraphsForTests,
  getCallGraph,
  peekCallGraph,
  releaseCallGraph,
  SwarmCallGraph,
} from './call-graph';
export {
  BudgetExceededError,
  CascadedCancellationError,
  ChildTimeoutError,
  classifyChildError,
  DuplicateSpawnError,
} from './errors';
export { createEscalateTool } from './escalate-tool';

export { SwarmNodeRepository, swarmNodeRepository } from './node-repository';
export {
  deriveChildBudget,
  getSwarmSpawner,
  resolveChildTools,
  SwarmSpawner,
  taskFingerprint,
} from './spawner';
export {
  createSpawnChildTool,
  formatChildResult,
  validateSpawnChildArgs,
} from './swarm-tool';
export type {
  AgentNode,
  ChildResult,
  ChildResultStatus,
  NodeBudget,
  SpawnChildParams,
  SwarmNodeKind,
  SwarmNodeStatus,
  TaskBrief,
} from './types';

export { BUDGET_RESERVE_FRACTION, LEVEL_DEFAULT } from './types';
