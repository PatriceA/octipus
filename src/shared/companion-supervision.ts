import { z } from 'zod';

export const companionGoalStates = ['queued', 'active', 'waiting', 'needs_decision', 'paused', 'completed', 'cancelled'] as const;
export type CompanionGoalState = typeof companionGoalStates[number];
export const companionScopeSchema = z.object({ userId: z.uuid(), workspaceId: z.uuid() }).strict();
export type CompanionScope = z.infer<typeof companionScopeSchema>;

export const createCompanionGoalSchema = z.object({
  requestKey: z.uuid(),
  title: z.string().trim().min(1).max(200),
  request: z.string().trim().min(1).max(20_000),
  outcome: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
  priority: z.number().int().min(0).max(3).default(0),
  tokenBudget: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  taskId: z.uuid().nullable().default(null),
  workPlanSessionId: z.uuid().nullable().default(null),
}).strict();
export type CreateCompanionGoal = z.infer<typeof createCompanionGoalSchema>;

export const companionCompletionEvidenceSchema = z.object({
  criterionIndex: z.number().int().min(0).max(49),
  evidenceId: z.uuid(),
  summary: z.string().trim().min(1).max(2000),
}).strict();
export type CompanionCompletionEvidence = z.infer<typeof companionCompletionEvidenceSchema>;

export const updateCompanionGoalSchema = z.object({
  expectedRevision: z.number().int().min(0),
  state: z.enum(companionGoalStates).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  evidence: z.array(companionCompletionEvidenceSchema).min(1).max(50).optional(),
}).strict().refine(value => value.state !== undefined || value.priority !== undefined, 'A state or priority change is required')
  .refine(value => (value.state === 'completed') === (value.evidence !== undefined), 'Completion requires evidence; other transitions cannot attach completion evidence');

export const adoptCompanionExecutionSchema = z.object({
  expectedRevision: z.number().int().min(0),
  sessionId: z.uuid(),
  pipelineId: z.uuid().nullable().default(null),
  purpose: z.string().trim().min(1).max(2000),
  ownership: z.enum(['owner', 'observer']).default('owner'),
}).strict();

const transitions: Record<CompanionGoalState, readonly CompanionGoalState[]> = {
  queued: ['active', 'paused', 'cancelled'],
  active: ['waiting', 'needs_decision', 'paused', 'completed', 'cancelled'],
  waiting: ['active', 'needs_decision', 'paused', 'cancelled'],
  needs_decision: ['active', 'paused', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};
export function canTransitionCompanionGoal(from: CompanionGoalState, to: CompanionGoalState): boolean {
  return transitions[from].includes(to);
}

export class CompanionSupervisionError extends Error {
  constructor(readonly code: 'not_found' | 'scope_unavailable' | 'conflict' | 'invalid_evidence', message: string) {
    super(message);
    this.name = 'CompanionSupervisionError';
  }
}
