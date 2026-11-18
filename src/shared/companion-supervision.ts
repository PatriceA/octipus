import { z } from 'zod';

export const companionGoalStates = ['queued', 'active', 'waiting', 'needs_decision', 'paused', 'completed', 'cancelled'] as const;
export type CompanionGoalState = typeof companionGoalStates[number];
/** Browser-safe wire views; database schemas carry server-only dependencies. */
export interface CompanionGoalView {
  id: string; title: string; request: string; outcome: string; acceptanceCriteria: string[];
  dependencies?: string[]; tokenBudget?: number | null; ownerInputs?: CompanionOwnerInput[];
  executionPolicy?: { profile: unknown; approvedAt: string } | null; completionEvidence?: CompanionCompletionEvidence[];
  state: CompanionGoalState; priority: number; revision: number; protectionLevel: number;
}
export interface CompanionLinkView {
  id: string; sessionId: string; pipelineId: string | null; purpose: string; ownership: 'owner' | 'observer'; active: boolean;
}
export interface CompanionActionView {
  id: string; kind: string; status: string; result: string | null; basis?: CompanionBasisRecord | null;
}
/** A standing instruction the owner gave Companion, with the words it came from. */
export interface CompanionInstructionView { id: string; text: string; quote: string; goalId: string | null; createdAt: string; validUntil: string | null }
/** A background report: delivered to the owner's chat, or kept on the Companion page with the gate's reason. */
export interface CompanionReportView {
  id: string; message: string; decision: 'delivered' | 'sending' | 'recorded'; reason: string; impact: 'low' | 'normal' | 'high'; createdAt: string;
}
/**
 * The owner's own words behind a Companion write: a quote the server found in
 * an owner message or in the words the owner gave when the goal was created.
 * It records where authority came from; it never widens permissions.
 */
export const companionBasisSchema = z.object({
  source: z.enum(['owner_message', 'goal']).describe('owner_message: the owner\'s message in this conversation. goal: the owner\'s words saved with the goal.'),
  quote: z.string().trim().min(4).max(400).describe('Copy the owner\'s exact words that ask for this action. Paraphrases are refused.'),
}).strict();
export type CompanionBasis = z.infer<typeof companionBasisSchema>;
export interface CompanionBasisRecord { source: CompanionBasis['source']; quote: string; messageId?: string; at: string }
/** Owner words captured when a goal is created: typed into the goal form, or the owner's messages in the creating turn. */
export interface CompanionOwnerInput { text: string; messageId?: string; origin: 'form' | 'message'; at: string }
export const companionScopeSchema = z.object({ userId: z.uuid(), workspaceId: z.uuid() }).strict();
export type CompanionScope = z.infer<typeof companionScopeSchema>;

export const COMPANION_TOKEN_LIMITS = {
  dailyDefault: 10_000_000, dailyMax: 100_000_000,
  turnDefault: 1_000_000, turnMax: 10_000_000,
} as const;

export const companionSettingsSchema = z.object({
  enabled: z.boolean().default(false), modelName: z.string().trim().max(200).default(''),
  autonomy: z.enum(['observe', 'coordinate', 'repair']).default('observe'),
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  dailyTokenBudget: z.number().int().min(1000).max(COMPANION_TOKEN_LIMITS.dailyMax).default(COMPANION_TOKEN_LIMITS.dailyDefault),
  turnTokenBudget: z.number().int().min(1000).max(COMPANION_TOKEN_LIMITS.turnMax).default(COMPANION_TOKEN_LIMITS.turnDefault),
  maxRepairAttempts: z.number().int().min(1).max(5).default(2),
  quietHoursStart: z.number().int().min(0).max(23).default(22),
  quietHoursEnd: z.number().int().min(0).max(23).default(7),
  timezone: z.string().min(1).max(100).default('UTC'),
  /** Also send Companion notices and decisions to the owner's linked chats (Telegram, Slack, Teams, WhatsApp). */
  notifyChats: z.boolean().default(false),
}).strict();
export type CompanionSettingsInput = z.infer<typeof companionSettingsSchema>;

/**
 * A project session Companion starts routes its model by the owner's topic
 * lanes on every turn, exactly like a session the owner starts: there is no
 * model to choose here.
 */
const startCompanionSessionFields = z.object({
  requestKey: z.uuid(), expectedRevision: z.number().int().min(0),
  projectPath: z.string().min(1).max(2000).optional(),
  sourceSessionId: z.uuid().optional(),
}).strict();
/** A `modelName` from an older client or an earlier turn is dropped, so retries and stale tabs keep working. */
export const startCompanionSessionSchema = z.preprocess(
  value => value && typeof value === 'object' && 'modelName' in value ? (({ modelName: _ignored, ...rest }) => rest)(value as Record<string, unknown>) : value,
  startCompanionSessionFields);
export const companionSessionMessageSchema = z.object({
  requestKey: z.uuid(), sessionId: z.uuid(),
  briefingId: z.uuid().optional().describe("Completed session briefing receipt. Read its full report before sending project instructions."),
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
