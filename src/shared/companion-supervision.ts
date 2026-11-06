import { z } from 'zod';

export const companionGoalStates = ['queued', 'active', 'waiting', 'needs_decision', 'paused', 'completed', 'cancelled'] as const;
export type CompanionGoalState = typeof companionGoalStates[number];
/** Browser-safe wire views; database schemas carry server-only dependencies. */
export interface CompanionGoalView {
  id: string; title: string; request: string; outcome: string; acceptanceCriteria: string[];
  dependencies?: string[]; tokenBudget?: number | null;
  executionPolicy?: { profile: unknown; approvedAt: string } | null; completionEvidence?: CompanionCompletionEvidence[];
  state: CompanionGoalState; priority: number; revision: number; protectionLevel: number;
}
export interface CompanionLinkView {
  id: string; sessionId: string; pipelineId: string | null; purpose: string; ownership: 'owner' | 'observer'; active: boolean;
}
export interface CompanionActionView {
  id: string; kind: string; status: string; result: string | null;
}
export const companionScopeSchema = z.object({ userId: z.uuid(), workspaceId: z.uuid() }).strict();
export type CompanionScope = z.infer<typeof companionScopeSchema>;

export const companionSettingsSchema = z.object({
  enabled: z.boolean().default(false), modelName: z.string().trim().max(200).default(''),
  autonomy: z.enum(['observe', 'coordinate', 'repair']).default('observe'),
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  dailyTokenBudget: z.number().int().min(1000).max(10_000_000).default(100_000),
  turnTokenBudget: z.number().int().min(1000).max(100_000).default(16_000),
  maxRepairAttempts: z.number().int().min(1).max(5).default(2),
  quietHoursStart: z.number().int().min(0).max(23).default(22),
  quietHoursEnd: z.number().int().min(0).max(23).default(7),
  timezone: z.string().min(1).max(100).default('UTC'),
}).strict();
export type CompanionSettingsInput = z.infer<typeof companionSettingsSchema>;

export const startCompanionSessionSchema = z.object({
  requestKey: z.uuid(), expectedRevision: z.number().int().min(0),
  modelName: z.string().trim().min(1).max(200),
  projectPath: z.string().min(1).max(2000).optional(),
  sourceSessionId: z.uuid().optional(),
}).strict();
export const companionSessionMessageSchema = z.object({
  requestKey: z.uuid(), sessionId: z.uuid(),
  incidentId: z.uuid().optional().describe("The prepared incident to repair. Read it, record one strategy, then pass its ID so dispatch cannot select a different incident."),
  message: z.string().trim().min(1).max(20_000),
  sourceSessionId: z.uuid().optional(),
}).strict();

export const companionAttachmentSchema=z.object({path:z.string().min(1).max(2000),version:z.string().max(256).optional(),protectionLevel:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4)]).optional()}).strict();
export const createCompanionGoalSchema = z.object({
  requestKey: z.uuid(),
  attachments:z.array(companionAttachmentSchema).max(20).default([]),
  title: z.string().trim().min(1).max(200),
  request: z.string().trim().min(1).max(20_000),
  outcome: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
  priority: z.number().int().min(0).max(3).default(0),
  tokenBudget: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  taskId: z.uuid().nullable().default(null),
  workPlanSessionId: z.uuid().nullable().default(null),
  sourceSessionId: z.uuid().nullable().default(null),
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
  dependencies: z.array(z.uuid()).max(30).optional(),
  tokenBudget: z.number().int().min(1000).max(1000000000).nullable().optional(),
  evidence: z.array(companionCompletionEvidenceSchema).min(1).max(50).optional(),
}).strict().refine(value => value.state !== undefined || value.priority !== undefined || value.dependencies !== undefined || value.tokenBudget !== undefined, 'A state or priority change is required')
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
