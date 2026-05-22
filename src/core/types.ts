

// Agent Types
export type AgentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export interface AgentContext {
  id: string;
  sessionId: string;
  userId: string;
  /**
   * Workspace UUID for multi-tenant scoping. Resolved at the message
   * entry point (orchestrator.handleMessage) and propagated down the
   * swarm tree so every spawned worker inherits the same scope. NULL
   * for anonymous / system principals that have no workspaces.
   */
  workspaceId?: string | null;
  topic: string;
  model: string;
  role: string;
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Set when status transitions to a terminal state (completed/failed/stopped).
   *  Lets `AgentManager.list()` surface an accurate duration for agents that
   *  have finished but are still in-memory (waiting for cleanup), so the chat
   *  UI doesn't render "0ms" before the agent is moved to the historical bucket. */
  completedAt?: Date;
  metadata: Record<string, unknown>;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp: Date;
  /**
   * DeepSeek thinking-mode chain-of-thought (assistant messages only).
   * Set when the response came from `deepseek-reasoner` and must be echoed
   * back on the next turn. Ignored by every other provider's formatter.
   */
  reasoningContent?: string;
  /**
   * Provider-specific raw payload that must be echoed verbatim on the next
   * turn. Currently used by Gemini to preserve `thought_signature` on
   * tool-calling turns (Gemini 3 degrades or rejects without it). Travels
   * with the message rather than living in a provider singleton — no
   * cross-session leakage, no eviction needed. Opaque to everything except
   * the provider that produced it.
   */
  providerRaw?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  error?: string;
}

// Task Types
export interface Task {
  id: string;
  agentId: string;
  type: string;
  priority: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// Permission Types
export type PermissionLevel = 'ALLOW' | 'ASK' | 'DENY';

export interface Permission {
  toolId: string;
  action: string;
  level: PermissionLevel;
  conditions?: PermissionCondition[];
}

export interface PermissionCondition {
  type: 'path_pattern' | 'command_pattern' | 'time_window' | 'rate_limit';
  value: string | number;
}

export interface PermissionRequest {
  id: string;
  agentId: string;
  toolId: string;
  action: string;
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

// Model Types
export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  endpoint?: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
  topics: string[];
  costPerInputToken: number;
  costPerOutputToken: number;
  isEnabled: boolean;
}

export interface ModelUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: Date;
}

// Channel Types
// 'qa-demo' is reserved for the optional channel-discovery QA
// exercise documented in `docs/QA.md` — operators temporarily create
// a channel of this type to verify discovery, then delete it. The
// literal stays in the union so the QA-doc snippet compiles.
export type ChannelType = 'telegram' | 'teams' | 'slack' | 'whatsapp' | 'webchat' | 'api' | 'qa-demo';

export interface UnifiedMessage {
  id: string;
  channelType: ChannelType;
  channelId: string;
  userId: string;
  userName?: string;
  content: string;
  attachments?: Attachment[];
  replyTo?: string;
  threadId?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType: string;
  filename?: string;
  size?: number;
}

export interface ChannelResponse {
  content: string;
  attachments?: Attachment[];
  replyTo?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

// Hook Types
export type TriggerType =
  | 'message_received'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'tool_executed'
  | 'tool_pre'
  | 'tool_post'
  | 'permission_requested'
  | 'schedule'
  | 'webhook';

export type ActionType =
  | 'notify'
  | 'spawn_agent'
  | 'webhook'
  | 'n8n_workflow'
  | 'execute_tool';

export interface TriggerConfig {
  // For message_received
  channelTypes?: string[];
  messagePatterns?: string[];
  // For schedule
  cronExpression?: string;
  timezone?: string;
  // For webhook
  webhookPath?: string;
  webhookSecret?: string;
  // For tool_executed
  toolIds?: string[];
  toolNames?: string[];
  // Common
  sessionFilter?: {
    topics?: string[];
    userIds?: string[];
  };
}

export interface ActionConfig {
  // For notify
  notifyOwner?: boolean;
  notifyChannels?: string[];
  notifyMessage?: string;
  // For spawn_agent
  agentTopic?: string;
  agentPrompt?: string;
  agentModel?: string;
  orchestrated?: boolean;
  orchestratorNotify?: boolean;
  // For webhook
  webhookUrl?: string;
  webhookMethod?: 'GET' | 'POST' | 'PUT';
  webhookHeaders?: Record<string, string>;
  webhookBody?: string;
  // For n8n_workflow
  workflowId?: string;
  workflowData?: Record<string, unknown>;
  // For execute_tool
  toolId?: string;
  toolAction?: string;
  toolParams?: Record<string, unknown>;
  // For incoming webhook response delivery
  channelType?: string;
  channelId?: string;
}

export interface HookCondition {
  field: string;
  operator: 'equals' | 'contains' | 'matches' | 'gt' | 'lt' | 'in';
  value: unknown;
}

export interface Hook {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  trigger: TriggerType;
  triggerConfig: TriggerConfig;
  action: ActionType;
  actionConfig: ActionConfig;
  conditions: HookCondition[] | null;
  isEnabled: boolean;
  priority: number;
  maxExecutions: number | null;
  executionCount: number;
  cooldownMs: number | null;
  lastExecutedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// Tool Types
export interface ToolManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: ToolPermission[];
  tools: ToolFunction[];
  dependencies?: string[];
}

export interface ToolPermission {
  action: string;
  description: string;
  defaultLevel: PermissionLevel;
  dangerous?: boolean;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  returns: string;
}

export interface ToolParameter {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}

// MCP Types
export interface MCPServer {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  isEnabled: boolean;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  sseUrl?: string;
  postUrl?: string;
  headers?: Record<string, string>;
}

export interface MCPTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Voice Types
export interface VoiceConfig {
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  wakeWord?: string;
  language: string;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  language: string;
  segments?: TranscriptionSegment[];
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

// Event Types
export interface SystemEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: Date;
  source: string;
}

// Health Check Types
export interface HealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'not_configured';
  latency?: number;
  message?: string;
  lastChecked: Date;
}
