import { pipelineItemEditSchema } from '@/shared/pipeline-items';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import type { Pipeline } from '@/db/schema/pipelines';
import { withApprovedCalls } from '@/security/approved-calls';
import { getPermissionManager } from '@/security/permissions';
import { coreLogger } from '@/utils/logger';
import { stripPipelineControlBlocks } from './handoff';
import type { PendingStageApproval, WalkState } from './pipeline-manager';
import { pipelineSummary, pipelineStageHistory, pipelineStageRuns } from './pipeline-status';
import { replyAnswer } from './approval-manager';

const pendingOf = (pipeline: Pipeline) =>
  (pipeline.metadata as { pendingApproval?: PendingStageApproval } | null)?.pendingApproval;
const attemptOf = (state: unknown) => (state as WalkState | null)?.attemptId;

/** Recovery handles are scoped to the same owner, session and workspace as creation. */
export function createPipelineRecoveryTools(trackPipeline?: (id: string, completion: Promise<unknown>) => void): ToolHandler[] {
  /** `attemptId`: resume exactly that stage attempt. `freshAttempt`: a deliberate rewind, run afresh. */
  const resumeFrom = async (pipeline: Pipeline, nodeKey: string | undefined, opts: { attemptId?: string; freshAttempt?: boolean } = {}) => {
    const checkpoints = await pipelineRepository.getCheckpoints(pipeline.id, 1000);
    const checkpoint = checkpoints.find(checkpoint => (!nodeKey || checkpoint.nodeKey === nodeKey)
      && (!opts.attemptId || attemptOf(checkpoint.state) === opts.attemptId));
    if (!checkpoint) throw new Error(opts.attemptId ? 'No saved checkpoint for the blocked stage attempt' : 'No saved checkpoint for this stage');
    const { getPipelineManager } = await import('./pipeline-manager');
    return new Promise((resolve, reject) => {
      const completion = getPipelineManager().resume(pipeline.id, { fromSeq: checkpoint.seq, freshAttempt: opts.freshAttempt,
        onAccepted: () => {
          trackPipeline?.(pipeline.id, completion);
          resolve({ id: pipeline.id, status: 'resuming', fromStage: checkpoint.nodeKey,
            message: 'Resume scheduled. Check get_pipeline_status for replay approval or stage progress.' });
        },
        onResumed: () => {
          resolve({ id: pipeline.id, status: 'running', fromStage: checkpoint.nodeKey });
        },
      });
      void completion.catch(error => {
        coreLogger.error({ error, pipelineId: pipeline.id }, 'Pipeline resume failed');
        reject(error);
      });
    });
  };

  return ['get_pipeline_status', 'resume_pipeline', 'answer_pipeline_approval', 'update_pipeline_items', 'stop_pipeline'].map(name => ({
    name,
    discoverOnly: true,
    ...(name === 'get_pipeline_status' ? { permissionAction: 'read', replaySafety: 'read_only' as const } : {}),
    description: name === 'stop_pipeline' ? 'Stop a pipeline in this session, preserving its checkpoint for resume. Returns the resumable stopped state, never a failure.'
      : name === 'update_pipeline_items' ? 'Change a running pipeline plan in this session. Queue skips, additions and ordering for its next item boundary. Requires evidence or the user decision explaining the change. Active items must be stopped before skipping.'
      : name === 'get_pipeline_status'
      ? 'Read a pipeline handle: stage status, completed outputs, remaining items, failure reason, and the pending approval when awaiting_approval. Synthesize the result for the user.'
      : name === 'resume_pipeline'
        ? 'Resume a stopped or failed pipeline using its saved outputs. Optionally rewind to fromStage (node key or exact stage name), and mark plan items already delivered by earlier work as skipped with evidence. Returns immediately; use get_pipeline_status to monitor.'
        : 'Ask the user, in this conversation, to answer the approval a pipeline stage is waiting on (see pendingApproval in get_pipeline_status). The user decides; the stage then continues or the run pauses.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Pipeline handle returned by create_pipeline' },
      ...(name === 'get_pipeline_status' ? { includeHistory: { type: 'boolean', description: 'Include per-item attempt history (default true). Use false for frequent polling.' } } : {}),
      ...(name === 'update_pipeline_items' ? {
        skip: { type: 'array', items: { type: 'string' } },
        add: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } } }, required: ['title'] } },
        order: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'string', description: 'Why the plan is changing: user decision or verification evidence' },
      } : {}),
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
      if (name === 'stop_pipeline') {
        const { getPipelineManager } = await import('./pipeline-manager');
        const stopped = await getPipelineManager().stop(pipeline.id);
        return { id: pipeline.id, stopped, status: stopped ? 'stopped' : pipeline.status, resumable: stopped };
      }
      if (name === 'update_pipeline_items') {
        const edit = pipelineItemEditSchema.parse(args);
        await pipelineRepository.queueItemEdit(pipeline.id, edit);
        if (['paused', 'stopped'].includes(pipeline.status)) {
          await pipelineRepository.applyItemEdits(pipeline.id);
          return { id: pipeline.id, applied: true, appliesAt: 'before_resume', ...edit };
        }
        return { id: pipeline.id, queued: true, appliesAt: 'next_item_boundary', ...edit };
      }
      const nodes = await pipelineRepository.getNodes(pipeline.id);
      if (name === 'get_pipeline_status') {
        const items = await pipelineRepository.getPlanItems(pipeline.id);
        const pending = ['awaiting_approval', 'paused', 'stopped'].includes(pipeline.status) ? pendingOf(pipeline) : undefined;
        // An interrupted attempt's progress, from the newest checkpoint: never a stage result.
        const [newest] = await pipelineRepository.getCheckpoints(pipeline.id, 1);
        const partial = (newest?.state as unknown as WalkState | undefined)?.partial;
        const history = args.includeHistory === false ? [] : pipelineStageHistory(await pipelineRepository.getStageHistory(pipeline.id, pipeline.sessionId));
        return { id: pipeline.id, status: pipeline.status, summary: pipelineSummary(pipeline, nodes, items), history, historyIncluded: args.includeHistory !== false,
          pendingItemEdits: pipeline.metadata?.pendingItemEdits ?? [],
          ...(pending ? { pendingApproval: { ...pending, answer: 'The user answers it in the approval prompt, or call answer_pipeline_approval to ask them here.' } } : {}),
          ...(partial ? { incompleteAttempt: { incomplete: true, stage: newest.nodeKey,
            attemptId: partial.attemptId, itemId: partial.itemId, savedAt: partial.at,
            output: stripPipelineControlBlocks(partial.text).slice(-2000),
            note: 'Progress of an interrupted stage attempt, not a finished result. Resuming continues this attempt.' } } : {}),
          // `attempt` is the stage's visit count; output and error are that attempt's only.
          stages: nodes.map(node => ({ key: node.nodeKey, name: node.name, status: node.status, attempt: node.visits,
            output: stripPipelineControlBlocks(node.output ?? ''), error: node.error })),
          currentItemId: items.find(item => item.status === 'running')?.id ?? null,
          items: items.map(item => ({ id: item.id, title: item.title, status: item.status, stages: pipelineStageRuns(history, item.id), result: stripPipelineControlBlocks(item.result ?? '') })),
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
          'Allow this call and continue the stage? This prompt waits up to 5 minutes; no answer leaves the pipeline waiting.',
          { ...context, metadata: { ...context.metadata, approvalTimeoutMs: 300_000 } }, ['Approve', 'Deny'],
        ) as { approved: boolean; response?: string; reason?: string; requestId?: string; decidedBy?: string; decidedAt?: string };
        const decision = answer.response ? replyAnswer(answer.response) : null;
        if (!decision) {
          return { id: pipeline.id, status: 'awaiting_approval', decided: false, stage: pending.stage, command: pending.subject,
            reason: answer.reason ?? 'No explicit user decision was received; the pipeline approval is still pending.' };
        }
        const approved = answer.approved && decision === 'approve';
        const permissions = getPermissionManager();
        const settled = approved ? await permissions.approve(pending.requestId, context.userId, 'Approved in the conversation')
          : await permissions.deny(pending.requestId, context.userId, 'Denied in the conversation');
        if (!settled) return { id: pipeline.id, decided: false, reason: 'The request was already resolved or expired. Read the current pipeline status.', requestId: pending.requestId };
        // A walker still parked on the request takes the answer from here. After a
        // restart the boot sweep paused the run and nobody waits on the request:
        // settling its row alone would leave the stage parked forever.
        if (!approved || pipeline.status === 'awaiting_approval') return { id: pipeline.id, approved, stage: pending.stage,
          command: pending.subject, requestId: pending.requestId, decidedBy: answer.decidedBy ?? context.userId, decidedAt: answer.decidedAt ?? new Date().toISOString() };
        // No walker holds the request any more (a restart): grant the blocked
        // call to the blocked attempt, and resume that attempt.
        const { pendingApproval: _answered, ...metadata } = (pipeline.metadata ?? {}) as Record<string, unknown>;
        await pipelineRepository.updatePipeline(pipeline.id, { metadata: pending.toolId && pending.toolName && pending.action && pending.fingerprint
          ? withApprovedCalls(metadata, [{ toolId: pending.toolId, toolName: pending.toolName, action: pending.action, fingerprint: pending.fingerprint,
            nodeKey: pending.nodeKey, attemptId: pending.attemptId, hostServices: pending.hostServices === true }])
          : metadata });
        return resumeFrom(pipeline, pending.nodeKey, { attemptId: pending.attemptId });
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
        // Every id is checked before any is written: a bad batch changes nothing.
        const unknown = (args.skipItems as string[]).filter(id => !items.some(item => item.id === id));
        if (unknown.length) throw new Error(`No plan item ${unknown.map(id => `'${id}'`).join(', ')} on this pipeline; nothing was skipped`);
        const result = `Already delivered by earlier work: ${args.evidence.trim()}`.slice(0, 4000);
        // `done` keeps its own result. The item the run stopped in (running or
        // failed) can be skipped too: the run is not walking, and the resume
        // goes on from the loop head with the next pending item.
        for (const item of items.filter(item => (args.skipItems as string[]).includes(item.id) && !['done', 'skipped'].includes(item.status))) {
          await pipelineRepository.updatePlanItem(item.id, { status: 'skipped', result });
        }
      }
      return resumeFrom(pipeline, node?.nodeKey, { freshAttempt: node !== undefined });
    },
  })).map(tool => tool.name !== 'get_pipeline_status' ? tool : {
    ...tool,
    execute: async (args: Record<string, unknown>, context: AgentContext) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([tool.execute(args, context), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Pipeline status read timed out after 15 seconds; storage may be unavailable. No run lock was acquired.')), 15_000);
        })]);
      } finally { clearTimeout(timer); }
    },
  });
}
