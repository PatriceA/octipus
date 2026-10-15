import type { ToolHandler } from '@/core/agent-worker';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { coreLogger } from '@/utils/logger';
import { stripPipelineControlBlocks } from './handoff';

/** Recovery handles are scoped to the same owner, session and workspace as creation. */
export function createPipelineRecoveryTools(trackPipeline?: (id: string, completion: Promise<unknown>) => void): ToolHandler[] {
  return ['get_pipeline_status', 'resume_pipeline'].map(name => ({
    name,
    discoverOnly: true,
    description: name === 'get_pipeline_status'
      ? 'Read a pipeline handle: stage status, completed outputs, remaining items and failure reason. Synthesize the result for the user.'
      : 'Resume a stopped or failed pipeline using its saved outputs. Optionally rewind to fromStage (node key or exact stage name). Returns immediately; use get_pipeline_status to monitor.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Pipeline handle returned by create_pipeline' },
      ...(name === 'resume_pipeline' ? { fromStage: { type: 'string', description: 'Optional stage name or node key; defaults to the last checkpoint' } } : {}),
    }, required: ['id'] },
    execute: async (args, context) => {
      if (typeof args.id !== 'string') throw new Error('id must be a pipeline handle');
      const pipeline = await pipelineRepository.findById(args.id);
      if (!pipeline || pipeline.userId !== context.userId || pipeline.sessionId !== context.sessionId
        || (pipeline.workspaceId ?? null) !== (context.workspaceId ?? null)) throw new Error('Pipeline not found in this session');
      const nodes = await pipelineRepository.getNodes(pipeline.id);
      if (name === 'get_pipeline_status') {
        const items = await pipelineRepository.getPlanItems(pipeline.id);
        return { id: pipeline.id, status: pipeline.status, summary: stripPipelineControlBlocks(pipeline.summary ?? ''),
          stages: nodes.map(node => ({ key: node.nodeKey, name: node.name, status: node.status,
            output: stripPipelineControlBlocks(node.output ?? ''), error: node.error })),
          items: items.map(item => ({ id: item.id, title: item.title, status: item.status, result: stripPipelineControlBlocks(item.result ?? '') })),
          remainingItems: items.filter(item => !['done', 'skipped'].includes(item.status)).map(item => item.title) };
      }
      if (['running', 'awaiting_approval'].includes(pipeline.status)) throw new Error(`Pipeline is already ${pipeline.status}`);
      const checkpoints = await pipelineRepository.getCheckpoints(pipeline.id, 1000);
      const stage = args.fromStage;
      if (stage !== undefined && typeof stage !== 'string') throw new Error('fromStage must be a stage name or key');
      const node = stage === undefined ? undefined : nodes.find(node => node.nodeKey === stage || node.name === stage);
      if (stage !== undefined && !node) throw new Error(`Unknown stage: ${stage}`);
      const checkpoint = checkpoints.find(checkpoint => !node || checkpoint.nodeKey === node.nodeKey);
      if (!checkpoint) throw new Error('No saved checkpoint for this stage');
      const { getPipelineManager } = await import('./pipeline-manager');
      return new Promise((resolve, reject) => {
        const completion = getPipelineManager().resume(pipeline.id, { fromSeq: checkpoint.seq,
          onResumed: () => {
            trackPipeline?.(pipeline.id, completion);
            resolve({ id: pipeline.id, status: 'running', fromStage: checkpoint.nodeKey });
          },
        });
        void completion.catch(error => {
          coreLogger.error({ error, pipelineId: pipeline.id }, 'Pipeline resume failed');
          reject(error);
        });
      });
    },
  }));
}
