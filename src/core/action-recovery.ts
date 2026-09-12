import { createHash, randomUUID } from 'node:crypto';
import { toolActionRepository, type ToolActionRepository } from '@/db/repositories/tool-action-repository';
import type { ToolAction } from '@/db/schema/tool-actions';
import { getPermissionManager } from '@/security/permissions';
import { routeApproval } from '@/security/approval-policy';
import { coreLogger } from '@/utils/logger';
import { assertExecutionActive, getExecutionSignal } from './execution-scope';
import type { AgentContext } from './types';

export class RecoveryReviewRequiredError extends Error {
  readonly code = 'recovery_review_required';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Explicit manifest read actions are safe; arbitrary shell/unknown tools are not. */
export function isReadOnlyAction(action: string): boolean {
  return ['read', 'list', 'search', 'inspect'].includes(action);
}

export function describeActions(rows: ToolAction[]): string {
  return rows.slice(0, 20).map(row => `- ${row.toolName}: ${row.status === 'completed' ? 'returned previously' : 'outcome unknown'}; ${row.createdAt.toISOString()}; record ${row.id}`)
    .join('\n') + (rows.length > 20 ? `\n… ${rows.length - 20} additional actions` : '');
}

export class ActionRecovery {
  private active = new Set<string>();
  private locks = new Map<string, Promise<void>>();
  constructor(private repository: ToolActionRepository = toolActionRepository) {}

  private async locked<T>(context: AgentContext, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([context.userId, context.sessionId]);
    const before = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = before.then(() => held);
    this.locks.set(key, tail);
    const signal = getExecutionSignal(context);
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(new Error('Agent stopped while awaiting recovery review'));
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener('abort', onAbort, { once: true });
          before.then(resolve, reject);
        }
      });
      return await run();
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      release();
      // A cancelled waiter must not remove the lock still owned by its
      // predecessor and let a third caller bypass the pending review.
      void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    }
  }

  private async reviewPending(context: AgentContext, toolName: string): Promise<void> {
    for (;;) {
      assertExecutionActive(context);
      const pending = (await this.repository.pending(context.userId, context.sessionId)).filter(row => !this.active.has(row.id)).slice(0, 20);
      if (!pending.length) return;
      const decision = routeApproval({ level: 'ASK', role: context.role, root: context.root,
        attended: context.attended, toolId: 'action_recovery', action: 'retry' });
      if (decision.route !== 'ask_human') throw new RecoveryReviewRequiredError(
        `Previous tool actions have uncertain outcomes. Check external state and obtain recovery approval before another mutation. ${describeActions(pending)}`);
      const manager = getPermissionManager();
      const id = await manager.requestApproval(context.userId, context.id, 'action_recovery', 'retry', {
        warning: 'These actions may already have happened. Check their external state before approving. Approval permits continuing with mutations, which can repeat earlier actions.',
        previousActions: describeActions(pending), nextTool: toolName,
      }, context.sessionId, 'Review uncertain actions before continuing', getExecutionSignal(context));
      const approved = await manager.waitForApproval(id, { agentId: context.id });
      assertExecutionActive(context);
      if (!approved) throw new RecoveryReviewRequiredError('Recovery approval was not granted. Do not repeat the uncertain actions. Read-only checks remain available.');
      // Acknowledge precisely what the human saw. Another action may have
      // become uncertain during the wait; loop and ask about that separately.
      await this.repository.acknowledge(context.userId, context.sessionId, pending.map(row => row.id), id);
    }
  }

  async run<T>(context: AgentContext, toolId: string, toolName: string, args: Record<string, unknown>, execute: () => Promise<T>, beforeExecute?: () => Promise<void>): Promise<T> {
    const id = randomUUID();
    const scope = { id, userId: context.userId, sessionId: context.sessionId };
    await this.locked(context, async () => {
      await this.reviewPending(context, toolName);
      assertExecutionActive(context);
      // Register before insertion can become visible to another dispatch.
      this.active.add(id);
      try {
        await this.repository.start({ ...scope, agentId: context.id, toolId, toolName,
          argumentHash: createHash('sha256').update(canonical(args)).digest('hex'), status: 'started',
          pipelineId: typeof context.metadata?.pipelineId === 'string' ? context.metadata.pipelineId : null,
          nodeKey: typeof context.metadata?.nodeKey === 'string' ? context.metadata.nodeKey : null });
      } catch (error) { this.active.delete(id); throw error; }
    });
    let entered = false;
    try {
      assertExecutionActive(context);
      await beforeExecute?.();
      assertExecutionActive(context);
      entered = true;
      const result = await execute();
      const value = result as Record<string, unknown> | null;
      // Uncertain means the effect may or may not have happened: the call was
      // cut off (timeout, kill, abort). A structured failure the tool itself
      // reported (`success: false`, `outcome: 'error'`, `isError`) is a KNOWN
      // outcome — the tool ran to the end and said so — and must not gate the
      // rest of the session behind a human review; agents mis-path files and
      // fail builds all day.
      const uncertain = value !== null && typeof value === 'object' &&
        (value.timedOut === true || value.killed === true || value.aborted === true);
      try { await this.repository.finish(scope, uncertain ? 'uncertain' : 'completed'); }
      catch (err) {
        // Preserve the known output. The durable started record remains and
        // gates the next mutation; a logging outage must not invite a retry.
        coreLogger.error({ err, actionId: id, toolName }, 'Tool returned but recovery outcome could not be recorded; further mutations require review');
      }
      return result;
    } catch (error) {
      try { await this.repository.finish(scope, entered ? 'uncertain' : 'not_executed'); }
      catch (err) { coreLogger.error({ err, actionId: id }, 'Could not record tool termination; action remains uncertain'); }
      throw error;
    } finally { this.active.delete(id); }
  }

  /** Before a resumed/rewound pipeline changes any checkpoints. */
  async reviewPipeline(context: AgentContext, pipelineId: string, hasPriorVisits: boolean,
    ask?: (summary: string) => Promise<{ approved: boolean; reviewId?: string }>): Promise<void> {
    await this.locked(context, async () => {
      for (;;) {
        assertExecutionActive(context);
        const allRows = await this.repository.pipeline(context.userId, context.sessionId, pipelineId);
        if (allRows.some(row => this.active.has(row.id))) throw new RecoveryReviewRequiredError('Previous pipeline tool actions are still running. Wait for them to settle before resuming.');
        const rows = allRows.slice(0, 20);
        if (!rows.length && !hasPriorVisits) return;
        if (context.attended === false) throw new RecoveryReviewRequiredError('Resuming previous work requires an attended recovery review; no workers have been restarted.');
        const requestReview = ask ?? (async (summary: string) => {
          const manager = getPermissionManager();
          const reviewId = await manager.requestApproval(context.userId, context.id, 'action_recovery', 'replay_pipeline',
            { warning: summary, pipelineId }, context.sessionId, 'Review pipeline replay', getExecutionSignal(context));
          return { approved: await manager.waitForApproval(reviewId, { agentId: context.id }), reviewId };
        });
        const result = await requestReview(
          'Resuming or rewinding reruns work from a checkpoint. Completed actions can happen again; unknown outcomes must be checked before retrying. ' +
          'This is permission to replay work, not confirmation that previous actions failed.\n\n' +
          (rows.length ? describeActions(rows) : 'No action records establish the effects of the previous run. Older runs and vendor-native CLI tools may have performed actions outside this journal.'));
        assertExecutionActive(context);
        if (!result.approved) throw new RecoveryReviewRequiredError('Recovery review was not approved. Pipeline checkpoints were preserved.');
        await this.repository.acknowledge(context.userId, context.sessionId, rows.map(row => row.id), result.reviewId ?? `pipeline-resume:${randomUUID()}`);
        // Only newly uncertain/completed records need another review.
        hasPriorVisits = false;
      }
    });
  }
}
export const actionRecovery = new ActionRecovery();
