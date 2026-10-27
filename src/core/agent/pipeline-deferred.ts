import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { getPipelineManager } from './pipeline-manager';
import { coreLogger } from '@/utils/logger';

const waking = new Set<string>();

/** Durable dates live on pipeline rows; a restart does not lose their wake-up. */
export async function wakeDeferredPipelines(now = new Date()): Promise<void> {
  for (const pipeline of await pipelineRepository.dueDeferred(now)) {
    if (waking.has(pipeline.id)) continue;
    waking.add(pipeline.id);
    // Do not hold the sweep while stages execute or a replay review waits.
    void getPipelineManager().resume(pipeline.id).catch(async error => {
      const current = await pipelineRepository.findById(pipeline.id);
      if (current?.status === 'paused' && current.metadata?.resumeAfter === pipeline.metadata?.resumeAfter) {
        await pipelineRepository.updatePipeline(pipeline.id, { metadata: { ...current.metadata, deferredWakeError: String(error) } });
      }
      coreLogger.error({ error, pipelineId: pipeline.id }, 'Deferred pipeline wake failed; inspect before resuming');
    }).finally(() => waking.delete(pipeline.id)).catch(error => coreLogger.error({ error, pipelineId: pipeline.id }, 'Could not persist deferred wake failure'));
  }
}

export function startDeferredPipelineWakeups(): () => void {
  const tick = () => { void wakeDeferredPipelines().catch(error => coreLogger.error({ error }, 'Deferred pipeline sweep failed')); };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
