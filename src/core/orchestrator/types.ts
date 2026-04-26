export type AgentRole =
  | 'orchestrator' | 'research' | 'coding' | 'review' | 'qa'
  | 'communication' | 'general'
  | 'design' | 'devops' | 'security' | 'data' | 'ai'
  | 'finance' | 'automation' | 'pm' | 'writing' | 'architecture';

export type PipelineStatus = 'planning' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed';

export type StageStatus = 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'skipped';

export type PipelineStageType = 'standard' | 'qa_validation';

export interface QAValidationResult {
  passed: boolean;
  issues: string[];
  feedback: string;
  retryCount: number;
}

export interface RoleConfig {
  role: AgentRole;
  toolIds: string[];
  defaultTopic: string;
  systemPromptTemplate: string;
}

export interface MessageClassification {
  type: 'casual' | 'task' | 'followup' | 'approval' | 'ambiguous';
  confidence: number;
  complexity?: 'simple' | 'moderate' | 'complex';
  topic?: string;
  reasoning?: string;
}

export interface PIIFilterResult {
  filtered: string;
  redactions: PIIRedaction[];
  hasRedactions: boolean;
}

export interface PIIRedaction {
  type: 'email' | 'phone' | 'ssn' | 'credit_card' | 'api_key' | 'ip_address';
  original: string;
  replacement: string;
  position: [number, number];
}

export interface Pipeline {
  id: string;
  orchestratorId: string;
  sessionId: string;
  userId: string;
  title: string;
  stages: PipelineStage[];
  currentStageIndex: number;
  status: PipelineStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  summary?: string;
  metadata: Record<string, unknown>;
}

export interface PipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  role: AgentRole;
  model?: string;
  toolIds: string[];
  systemPrompt: string;
  input: string;
  output?: string;
  workerId?: string;
  status: StageStatus;
  requiresApproval: boolean;
  approvedAt?: Date;
  approvedBy?: string;
  stageIndex: number;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface WorkerResult {
  workerId: string;
  role: AgentRole;
  result: string;
  model: string;
  iterations: number;
  durationMs: number;
  totalTokens?: number;
}

export interface ResponseMetadata {
  model?: string;
  tokens?: number;
  latencyMs?: number;
  cached?: boolean;
  sessionTotalTokens?: number;
  /**
   * Source attribution — what context was pulled into the reply
   * (recent messages, profile facts, knowledge hits, classifier topic,
   * skills loaded, completed pipeline stages, etc). Rendered into the
   * response body via `appendSources()`; also kept on metadata for
   * instrumentation, logs, and offline eval.
   */
  sources?: string[];
}

/**
 * Append a "_Sources: …_" footer to an assistant reply. Centralised so
 * `directResponse`, the orchestrator, expert sessions, and pipeline
 * stages all render the same shape. Returns the original content
 * untouched when there are no sources.
 */
export function appendSources(content: string, sources: string[]): string {
  if (!sources.length) return content;
  return `${content}\n\n_Sources: ${sources.join(', ')}_`;
}
