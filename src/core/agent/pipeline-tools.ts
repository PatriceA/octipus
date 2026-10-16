import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import type { Pipeline } from '@/db/schema/pipelines';
import { rememberApprovedCall } from '@/security/approved-calls';
import { getPermissionManager } from '@/security/permissions';
import { coreLogger } from '@/utils/logger';
import { stripPipelineControlBlocks } from './handoff';
import type { PendingStageApproval } from './pipeline-manager';

const pendingOf = (pipeline: Pipeline) =>
  (pipeline.metadata as { pendingApproval?: PendingStageApproval } | null)?.pendingApproval;

/** Recovery handles are scoped to the same owner, session and workspace as creation. */
export function createPipelineRecoveryTools(trackPipeline?: (id: string, completion: Promise<unknown>) => void): ToolHandler[] {
  const resumeFrom = async (pipeline: Pipeline, nodeKey: string | undefined) => {
    const checkpoints = await pipelineRepository.getCheckpoints(pipeline.id, 1000);
    const checkpoint = checkpoints.find(checkpoint => !nodeKey || checkpoint.nodeKey === nodeKey);
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
  };

  return ['get_pipeline_status', 'resume_pipeline', 'answer_pipeline_approval'].map(name => ({
    name,
    discoverOnly: true,
    description: name === 'get_pipeline_status'
      ? 'Read a pipeline handle: stage status, completed outputs, remaining items, failure reason, and the pending approval when awaiting_approval. Synthesize the result for the user.'
      : name === 'resume_pipeline'
        ? 'Resume a stopped or failed pipeline using its saved outputs. Optionally rewind to fromStage (node key or exact stage name), and mark plan items already delivered by earlier work as skipped with evidence. Returns immediately; use get_pipeline_status to monitor.'
        : 'Ask the user, in this conversation, to answer the approval a pipeline stage is waiting on (see pendingApproval in get_pipeline_status). The user decides; the stage then continues or the run pauses.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Pipeline handle returned by create_pipeline' },
      ...(name === 'resume_pipeline' ? {
        fromStage: { type: 'string', description: 'Optional stage name or node key; defaults to the last checkpoint' },
        skipItems: { type: 'array', items: { type: 'string' }, description: 'Plan item ids already delivered by earlier work; marked skipped so the loop does not redo them' },
        evidence: { type: 'string', description: 'Required with skipItems: the commit and check that show the items are done' },
      } : {}),
    }, required: ['id'] },
    execute: async (args: Record<string, unknown>, context: AgentContext) => {
      if (typeof args.id !== 'string') throw new Error('id must be a pipeline handle');
      const pipeline = await pipelineRepository.findById(args.id);
      if (!pipeline || pipeline.userId !== context.userId || pipeline.sessionId !== context.sessionId
        || (pipeline.workspaceId ?? null) !== (context.workspaceId ?? null)) throw new Error('Pipeline not found in this session');
      const nodes = await pipelineRepository.getNodes(pipeline.id);
      if (name === 'get_pipeline_status') {
        const items = await pipelineRepository.getPlanItems(pipeline.id);
        const pending = pendingOf(pipeline);
        return { id: pipeline.id, status: pipeline.status, summary: stripPipelineControlBlocks(pipeline.summary ?? ''),
          ...(pending ? { pendingApproval: { ...pending, answer: 'The user answers it in the approval prompt, or call answer_pipeline_approval to ask them here.' } } : {}),
          // `attempt` is the stage's visit count; output and error are that attempt's only.
          stages: nodes.map(node => ({ key: node.nodeKey, name: node.name, status: node.status, attempt: node.visits,
            output: stripPipelineControlBlocks(node.output ?? ''), error: node.error })),
          currentItemId: items.find(item => item.status === 'running')?.id ?? null,
          items: items.map(item => ({ id: item.id, title: item.title, status: item.status, result: stripPipelineControlBlocks(item.result ?? '') })),
          remainingItems: items.filter(item => !['done', 'skipped'].includes(item.status)).map(item => item.title) };
      }
      if (name === 'answer_pipeline_approval') {
        const pending = pendingOf(pipeline);
        if (!pending) throw new Error('This pipeline is not waiting on an approval');
        // The model forwards the question; only the user's answer counts.
        const { getAgentService } = await import('./service');
        const answer = await getAgentService().requestApproval(
          `Pipeline stage "${pending.stage}"${pending.item ? ` (item: ${pending.item})` : ''} is waiting for approval: ` +
            `${pending.toolName ?? 'continue'}${pending.subject ? ` — ${pending.subject}` : ''}.`,
          'Allow this call and continue the stage?', context, ['Approve', 'Deny'],
        ) as { approved: boolean; response?: string };
        const approved = answer.approved && answer.response !== 'Deny';
        const permissions = getPermissionManager();
        const live = approved
          ? await permissions.approve(pending.requestId, context.userId, 'Approved in the conversation')
          : await permissions.deny(pending.requestId, context.userId, 'Denied in the conversation');
        if (live || !approved) return { id: pipeline.id, approved, stage: pending.stage };
        // No walker holds the request any more (a restart): approve and resume the stage.
        if (pending.toolId && pending.action && pending.subject) {
          rememberApprovedCall(pipeline.sessionId, { toolId: pending.toolId, action: pending.action, args: { command: pending.subject } });
        }
        const { pendingApproval: _answered, ...metadata } = (pipeline.metadata ?? {}) as Record<string, unknown>;
        await pipelineRepository.updatePipeline(pipeline.id, { metadata });
        return resumeFrom(pipeline, pending.nodeKey);
      }
      if (['running', 'awaiting_approval'].includes(pipeline.status)) throw new Error(`Pipeline is already ${pipeline.status}`);
      const stage = args.fromStage;
      if (stage !== undefined && typeof stage !== 'string') throw new Error('fromStage must be a stage name or key');
      const node = stage === undefined ? undefined : nodes.find(node => node.nodeKey === stage || node.name === stage);
      if (stage !== undefined && !node) throw new Error(`Unknown stage: ${stage}`);
      if (args.skipItems !== undefined) {
        if (!Array.isArray(args.skipItems) || args.skipItems.some(id => typeof id !== 'string')) throw new Error('skipItems must be plan item ids');
        if (typeof args.evidence !== 'string' || !args.evidence.trim()) throw new Error('skipItems needs evidence: the commit and check that show the work is done');
        const items = await pipelineRepository.getPlanItems(pipeline.id);
        for (const id of args.skipItems as string[]) {
          const item = items.find(item => item.id === id);
          if (!item) throw new Error(`No plan item '${id}' on this pipeline`);
          if (item.status === 'done') continue;
          if (item.status === 'running') throw new Error(`Plan item '${id}' is in progress; resume continues it`);
          await pipelineRepository.updatePlanItem(id, { status: 'skipped', result: `Already delivered by earlier work: ${args.evidence.trim()}`.slice(0, 4000) });
        }
      }
      return resumeFrom(pipeline, node?.nodeKey);
    },
  }));
}
