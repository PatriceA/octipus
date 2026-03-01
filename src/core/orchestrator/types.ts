export type AgentRole = 'orchestrator' | 'research' | 'coding' | 'review' | 'qa' | 'general';

export type PipelineStatus = 'planning' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed';

export type StageStatus = 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'skipped';

export interface RoleConfig {
  role: AgentRole;
  skillIds: string[];
  defaultTopic: string;
  systemPromptTemplate: string;
}

export interface MessageClassification {
  type: 'casual' | 'task' | 'followup' | 'approval' | 'ambiguous';
  confidence: number;
  suggestedPipeline?: 'development' | 'research' | 'general';
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
  skillIds: string[];
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
}
