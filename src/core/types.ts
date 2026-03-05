import type { z } from 'zod';

// Agent Types
export type AgentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export interface AgentContext {
  id: string;
  sessionId: string;
  userId: string;
  topic: string;
  model: string;
  role: string;
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp: Date;
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
export type ChannelType = 'telegram' | 'teams' | 'slack' | 'webchat' | 'api';

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
  notifyChannels?: string[];
  notifyMessage?: string;
  // For spawn_agent
  agentTopic?: string;
  agentPrompt?: string;
  agentModel?: string;
  orchestrated?: boolean;
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
  transport?: 'stdio' | 'sse';
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
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  message?: string;
  lastChecked: Date;
}
