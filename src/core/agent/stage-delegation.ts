import type { AgentWorker } from '@/core/agent-worker';
import type { AgentNode } from '@/core/swarm/types';
import { getLevelDefault } from '@/core/swarm/types';
import { createLateBoundSpawnChildHooks, createSpawnChildTool } from '@/core/swarm/swarm-tool';
import { createCollectChildrenTool } from '@/core/swarm/collect-tool';
import { createSteerChildTool } from '@/core/swarm/steer-tool';
import type { SwarmSpawner } from '@/core/swarm/spawner';

/** Wire before run(), for both native and CLI stage workers. */
export function createStageDelegation(parent: AgentNode, weakModel: boolean, spawner?: SwarmSpawner) {
  const workerRef: { current: AgentWorker | null } = { current: null };
  const detachRef: { current: Pick<AgentWorker, 'registerPendingChild' | 'pendingDetachedCount'> | null } = { current: null };
  const tools = [
    createSpawnChildTool(parent, spawner, createLateBoundSpawnChildHooks(detachRef, () => getLevelDefault(1).maxPendingDetached), { weakModel }),
    createCollectChildrenTool(parent, workerRef), createSteerChildTool(workerRef),
  ];
  for (const tool of tools) parent.allowedToolIds.add(tool.name);
  return { tools, bind(worker: Pick<AgentWorker, 'registerPendingChild' | 'pendingDetachedCount'>) {
    workerRef.current = worker as AgentWorker;
    detachRef.current = {
      registerPendingChild: worker.registerPendingChild.bind(worker),
      pendingDetachedCount: worker.pendingDetachedCount.bind(worker),
    };
  } };
}
