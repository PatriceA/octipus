import type { WorkPlan } from '@/shared/work-plan';
import type { PlanItemRow, Pipeline } from '@/db/schema/pipelines';

/** Host access is declared by a stage or explicitly approved for the run. */
export function stageHostServices(declared: { hostServices?: boolean }, pipeline: Pick<Pipeline, 'metadata' | 'userId'>): boolean {
  const grant = pipeline.metadata?.permissionProfile as { approvedBy?: string; profile?: { hostServices?: boolean } } | undefined;
  return declared.hostServices === true || grant?.approvedBy === pipeline.userId && grant?.profile?.hostServices === true;
}

/** Recognize unavailable execution prerequisites, never ordinary test failures. */
export function stageEnvironmentReason(text: string): string | undefined {
  return /Could not create parent directory for lock file[^\r\n]*\.gradle\b|(?:\.gradle|\.android)[^\r\n]*(?:Read-only file system|Permission denied)|(?:go|pnpm|docker|staticcheck|govulncheck):\s*(?:command not found|not found|no such file or directory|Kommando nicht gefunden)|(?:\.local\/go\/bin\/go|\/var\/run\/docker\.sock).{0,100}(?:not found|no such file|nicht gefunden)|(?:ECONNREFUSED|connection refused).{0,80}(?:localhost|127\.0\.0\.1|::1):(?:5432|5433|5443|25433)\b|Cannot connect to (?:the )?Docker daemon|Executable doesn't exist at .{0,180}ms-playwright|Scorer environment:|ENVIRONMENT BLOCKED:/i.test(text)
    ? text.slice(-4000) : undefined;
}

export class StageEnvironmentError extends Error {}

/** A policy repair report is not a question a user can fix by answering again. */
export function stagePolicyRepairReason(handoff: {
  blockedOnPolicy?: string;
  blockedOnDecision?: { question: string };
} | null, counters: { policyRefusals?: string[]; permissionDenials?: number } | null): string | undefined {
  if (handoff?.blockedOnPolicy) return handoff.blockedOnPolicy;
  const question = handoff?.blockedOnDecision?.question;
  if (!question) return undefined;
  if (counters?.policyRefusals?.length) return counters.policyRefusals.join('; ');
  if (counters?.permissionDenials) return question;
  // Older CLI workers may not expose denial counters or the dedicated field.
  if (/policy|permission|credential.flow|binding/i.test(question)
    && /repair|reconcil|enforcement|no (?:new|additional|further) user (?:scope )?(?:approval|decision)/i.test(question)) return question;
  return undefined;
}

/** Coordinator-owned UI state cannot be an acceptance test for a stage's code. */
export function coordinatorCriterion(criterion: string): boolean {
  return /(?:visible|work)[ -]?plan|update_work_plan/i.test(criterion) && /\b(?:working|pending|done|blocked|skipped)\b/i.test(criterion);
}


export function coordinatorCriterionSatisfied(criterion: string, steps: Pick<WorkPlan['steps'][number], 'id' | 'status'>[]): boolean {
  const id = criterion.match(/\bg\d+\b|[a-f0-9]{8}(?:-[a-f0-9-]{27,})?/i)?.[0];
  const status = criterion.match(/\b(working|pending|done|blocked|skipped)\b/i)?.[0].toLowerCase();
  if (!id || !status) return false;
  const exact = steps.filter(step => step.id === id);
  const matches = exact.length ? exact : /^[a-f0-9]{8}$/i.test(id) ? steps.filter(step => step.id.startsWith(id)) : [];
  return matches.length === 1 && matches[0].status === status;
}


/** A historical diagnostic is active only for its own unsettled item and attempt. */
export function activeEnvironmentBlock(pipeline: Pick<Pipeline, 'metadata'>, items: PlanItemRow[], checkpoint?: { nodeKey: string; state: unknown }) {
  const raw = pipeline.metadata?.environmentBlock;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  if (typeof block.itemId === 'string' && !items.some(item => item.id === block.itemId && ['running', 'pending'].includes(item.status))) return null;
  if (checkpoint?.state && typeof checkpoint.state === 'object') {
    const state = checkpoint.state as Record<string, unknown>;
    if ((block.itemId ?? null) !== (state.currentItemId ?? null) || block.nodeKey !== checkpoint.nodeKey
      || typeof block.attemptId === 'string' && block.attemptId !== state.attemptId) return null;
  }
  return block;
}
