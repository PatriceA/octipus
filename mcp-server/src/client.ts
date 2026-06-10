/**
 * Lightweight HTTP client for Octipus backend REST API.
 * All methods correspond to existing API endpoints or the new tool execution endpoint.
 */

import { getAuthHeaders } from './auth.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageContent {
  url: string;
  title: string;
  textLength: number;
  text: string;
}

export interface Agent {
  id: string;
  sessionId: string;
  model: string;
  topic: string;
  status: string;
  createdAt: string;
}

export interface AgentEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface Session {
  id: string;
  userId?: string;
  channel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface Model {
  name: string;
  provider: string;
  isDefault: boolean;
  isEnabled: boolean;
  supportsTools: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
  agentId?: string;
  classification?: string;
  metadata?: {
    model?: string;
    tokens?: number;
    latencyMs?: number;
    cached?: boolean;
  };
}

export interface Expert {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  role: string;
  isSystem: boolean;
  modelPreference?: string;
}

export interface ToolInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export class OctiClient {
  constructor(
    private baseUrl: string,
  ) {}

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const authHeaders = await getAuthHeaders(this.baseUrl);
    const url = `${this.baseUrl}${path}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── Chat ───

  async chat(message: string, sessionId?: string, expertId?: string): Promise<ChatResponse> {
    return this.request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        sessionId,
        expertId,
        channel: 'mcp',
      }),
    });
  }

  async chatWithExpert(message: string, expertId: string, sessionId?: string): Promise<ChatResponse> {
    return this.chat(message, sessionId, expertId);
  }

  async createSession(opts: { channelType?: string; title?: string; context?: Record<string, unknown> }): Promise<{ id: string }> {
    return this.request<{ id: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        channelType: opts.channelType || 'mcp',
        channelId: `mcp-${Date.now().toString(36)}`,
        title: opts.title,
        context: opts.context,
      }),
    });
  }

  // ─── Experts ───

  async listExperts(): Promise<Expert[]> {
    const res = await this.request<{ experts: Expert[] }>('/api/experts');
    return res.experts || [];
  }

  async getExpert(id: string): Promise<Expert> {
    return this.request<Expert>(`/api/experts/${id}`);
  }

  // ─── Search ───

  async search(query: string, maxResults = 10): Promise<{ query: string; resultCount: number; results: SearchResult[] }> {
    return this.request('/api/tools/websearch/tools/search/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { query, max_results: maxResults } }),
    });
  }

  async fetchPage(url: string, maxLength = 10000): Promise<PageContent> {
    return this.request('/api/tools/websearch/tools/fetch_page/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { url, max_length: maxLength } }),
    });
  }

  // ─── Agents ───

  async listAgents(): Promise<Agent[]> {
    const res = await this.request<{ agents: Agent[] }>('/api/agents');
    return res.agents || [];
  }

  async spawnAgent(message: string, model?: string, topic?: string): Promise<Agent> {
    return this.request<Agent>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ message, model, topic }),
    });
  }

  async getAgent(id: string): Promise<Agent> {
    return this.request<Agent>(`/api/agents/${id}`);
  }

  async stopAgent(id: string): Promise<void> {
    await this.request(`/api/agents/${id}/stop`, { method: 'POST' });
  }

  async sendMessage(agentId: string, message: string): Promise<{ response: string }> {
    return this.request(`/api/agents/${agentId}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async getAgentEvents(agentId: string, after?: number): Promise<AgentEvent[]> {
    const qs = after !== undefined ? `?after=${after}` : '';
    const res = await this.request<{ events: AgentEvent[] }>(`/api/agents/${agentId}/events${qs}`);
    return res.events || [];
  }

  // ─── Sessions ───

  async listSessions(limit = 20): Promise<Session[]> {
    const res = await this.request<{ sessions: Session[] }>(`/api/sessions?limit=${limit}`);
    return res.sessions || [];
  }

  async getSessionMessages(sessionId: string, limit = 50, offset = 0): Promise<Message[]> {
    const res = await this.request<{ messages: Message[] }>(
      `/api/sessions/${sessionId}/messages?limit=${limit}&offset=${offset}`,
    );
    return res.messages || [];
  }

  // ─── Models ───

  async listModels(): Promise<Model[]> {
    const res = await this.request<{ models: Model[] }>('/api/models');
    return res.models || [];
  }

  async getModelHealth(): Promise<Record<string, unknown>> {
    return this.request('/api/models/health');
  }

  // ─── Vault ───

  async listCredentials(): Promise<Array<{ key: string; description?: string; createdAt: string }>> {
    const res = await this.request<{ credentials: Array<{ key: string; description?: string; createdAt: string }> }>('/api/vault');
    return res.credentials || [];
  }

  // ─── Tools ───

  async listTools(): Promise<ToolInfo[]> {
    const res = await this.request<{ tools: ToolInfo[] }>('/api/tools');
    return res.tools || [];
  }

  async executeTool(toolId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<{ result?: unknown; error?: string }>(
      `/api/tools/${toolId}/tools/${toolName}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({ args }),
      },
    );
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result;
  }

  // ─── Memory (long-term facts) ───

  async listMemories(opts: { factType?: string; limit?: number; includeHistory?: boolean } = {}): Promise<{ memories: any[]; total: number }> {
    const q = new URLSearchParams();
    if (opts.factType) q.set('factType', opts.factType);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.includeHistory) q.set('includeHistory', 'true');
    const qs = q.toString();
    return this.request(`/api/memory${qs ? `?${qs}` : ''}`);
  }

  async deleteMemory(id: string): Promise<{ deleted?: boolean; error?: string }> {
    return this.request(`/api/memory/${id}`, { method: 'DELETE' });
  }

  // ─── Deep Research (async jobs) ───

  async startResearch(question: string, depth?: string): Promise<{ jobId: string; status: string }> {
    return this.request('/api/research', { method: 'POST', body: JSON.stringify({ question, depth }) });
  }

  async getResearch(jobId: string): Promise<any> {
    return this.request(`/api/research/${jobId}`);
  }

  // ─── Reader (URL → clean article + AI actions) ───

  async readUrl(url: string): Promise<any> {
    return this.request('/api/reader', { method: 'POST', body: JSON.stringify({ url }) });
  }

  async readerAction(action: string, opts: { url?: string; text?: string; argument?: string }): Promise<any> {
    return this.request('/api/reader/action', { method: 'POST', body: JSON.stringify({ action, ...opts }) });
  }

  // ─── Skills (domain knowledge) ───

  async listSkills(): Promise<Array<{
    id: string; name: string; category: string; description: string; isSystem: boolean;
  }>> {
    const res = await this.request<{ skills: any[] }>('/api/skills');
    return res.skills || [];
  }

  async getSkill(id: string): Promise<Record<string, unknown>> {
    return this.request(`/api/skills/${id}`);
  }

  async createSkill(params: {
    name: string; description: string; category?: string; content?: string;
    principles?: string[]; bestPractices?: string[]; antiPatterns?: string[]; frameworks?: string[];
  }): Promise<Record<string, unknown>> {
    return this.request('/api/skills', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async updateSkill(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/api/skills/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    });
  }

  async deleteSkill(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/skills/${id}`, { method: 'DELETE' }) as Promise<{ deleted: boolean }>;
  }

  // ─── Hooks (scheduled tasks & event automations) ───

  async listHooks(): Promise<Array<{
    id: string; name: string; description: string | null;
    trigger: string; triggerConfig: Record<string, unknown>;
    action: string; actionConfig: Record<string, unknown>;
    isEnabled: boolean; executionCount: number;
    lastExecutedAt: string | null; nextRunAt: string | null;
    lastError: string | null;
  }>> {
    const res = await this.request<{ hooks: any[] }>('/api/hooks');
    return res.hooks || [];
  }

  async createHook(params: {
    name: string; description?: string;
    trigger: string; triggerConfig: Record<string, unknown>;
    action: string; actionConfig: Record<string, unknown>;
    isEnabled?: boolean; cooldownMs?: number; maxExecutions?: number;
  }): Promise<Record<string, unknown>> {
    return this.request('/api/hooks', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async updateHook(id: string, params: {
    name?: string; description?: string;
    triggerConfig?: Record<string, unknown>;
    actionConfig?: Record<string, unknown>;
    isEnabled?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.request(`/api/hooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    });
  }

  async deleteHook(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/hooks/${id}`, { method: 'DELETE' });
  }

  async toggleHook(id: string, enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
    return this.request(`/api/hooks/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  // ─── Knowledge / RAG ───

  async searchKnowledge(query: string, limit?: number, mode?: string): Promise<{ results: any[] }> {
    return this.request('/api/tools/knowledge/tools/search_knowledge/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { query, limit: limit || 5, mode: mode || 'hybrid' } }),
    });
  }

  async readKnowledge(id: string): Promise<any> {
    return this.request('/api/tools/knowledge/tools/read_knowledge/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { id } }),
    });
  }

  async indexFile(path: string, type?: string): Promise<{ indexed: boolean; chunks: number; path: string }> {
    return this.request('/api/tools/knowledge/tools/index_file/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { path, type: type || 'document' } }),
    });
  }

  // ─── Messaging ───

  async sendChannelMessage(
    channel: string,
    target: string,
    message: string,
    replyTo?: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.request('/api/tools/messaging/tools/send_message/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { channel, target, message, reply_to: replyTo } }),
    });
  }

  async listChannels(): Promise<{ channels: Array<{ type: string; name: string; connected: boolean }> }> {
    return this.request('/api/tools/messaging/tools/list_channels/execute', {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    });
  }

  // ─── Plugins ───

  async listPlugins(): Promise<Array<{
    name: string; version: string; description: string; author?: string;
    directory: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  }>> {
    const res = await this.request<{ plugins: any[] }>('/api/plugins');
    return res.plugins || [];
  }

  async reloadPlugin(name: string): Promise<{
    message: string; name: string; version: string; tools: number;
    error?: string;
  }> {
    return this.request(`/api/plugins/${encodeURIComponent(name)}/reload`, {
      method: 'POST',
    });
  }

  // ─── Health ───

  async getHealth(): Promise<Record<string, unknown>> {
    return this.request('/api/health');
  }

  // ─── Pipelines ───

  async listPipelineTemplates(): Promise<any> {
    return this.request('/api/pipelines/templates');
  }

  async createPipeline(templateName: string, description: string): Promise<any> {
    return this.request('/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({ templateName, description }),
    });
  }

  async listPipelines(): Promise<any> {
    return this.request('/api/pipelines');
  }

  async getPipeline(id: string): Promise<any> {
    return this.request(`/api/pipelines/${id}`);
  }

  async stopPipeline(id: string): Promise<any> {
    return this.request(`/api/pipelines/${id}/stop`, { method: 'POST' });
  }

  // ─── Documents ───

  async listDocuments(): Promise<any> {
    return this.request('/api/documents');
  }

  async getDocument(id: string): Promise<any> {
    return this.request(`/api/documents/${id}`);
  }

  async deleteDocument(id: string): Promise<any> {
    return this.request(`/api/documents/${id}`, { method: 'DELETE' });
  }

  async uploadDocument(path: string): Promise<any> {
    return this.request('/api/knowledge/index', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  // ─── Settings ───

  async listSettings(): Promise<any> {
    return this.request('/api/settings');
  }

  async getSetting(key: string): Promise<any> {
    return this.request(`/api/settings/${encodeURIComponent(key)}`);
  }

  async updateSetting(key: string, value: unknown): Promise<any> {
    return this.request(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }

  async resetSetting(key: string): Promise<any> {
    return this.request(`/api/settings/${encodeURIComponent(key)}/reset`, { method: 'POST' });
  }

  // ─── Gateway ───

  async getGatewayStatus(): Promise<any> {
    return this.request('/api/gateway/status');
  }

  async getGatewayConnections(): Promise<any> {
    return this.request('/api/gateway/connections');
  }

  async getGatewayAdapters(): Promise<any> {
    return this.request('/api/gateway/adapters');
  }

  // ─── Detailed Health ───

  async getDetailedHealth(): Promise<any> {
    return this.request('/api/health/detailed');
  }

  async getModelHealth2(): Promise<any> {
    return this.request('/api/health/models');
  }

  async getChannelHealth(): Promise<any> {
    return this.request('/api/health/channels');
  }

  async getServerTime(): Promise<any> {
    return this.request('/api/health/time');
  }

  // ─── Audit ───

  async listAuditLog(limit = 50): Promise<any> {
    return this.request(`/api/audit?limit=${limit}`);
  }

  // ─── Artifacts ───

  async listArtifacts(): Promise<any> {
    return this.request('/api/artifacts');
  }

  async getArtifact(id: string): Promise<any> {
    return this.request(`/api/artifacts/${id}`);
  }

  async getArtifactSpec(slugOrId: string): Promise<any> {
    return this.request(`/api/artifacts/spec/${encodeURIComponent(slugOrId)}`);
  }

  async createArtifact(params: {
    slug: string;
    title: string;
    type: 'dashboard' | 'table' | 'rss' | 'news' | 'html';
    visibility?: 'workspace' | 'public' | 'private';
    htmlTemplate?: string;
    css?: string;
    createdByAgentId?: string;
  }): Promise<any> {
    return this.request('/api/artifacts', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async updateArtifact(id: string, params: {
    title?: string;
    visibility?: 'workspace' | 'public' | 'private';
    htmlTemplate?: string;
    css?: string;
    changeSummary?: string;
  }): Promise<any> {
    return this.request(`/api/artifacts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(params),
    });
  }

  async deleteArtifact(id: string): Promise<any> {
    return this.request(`/api/artifacts/${id}`, { method: 'DELETE' });
  }

  async listArtifactVersions(id: string): Promise<any> {
    return this.request(`/api/artifacts/${id}/versions`);
  }

  async refreshArtifact(id: string): Promise<any> {
    return this.request(`/api/artifacts/${id}/refresh`, { method: 'POST' });
  }

  async listArtifactShareLinks(id: string): Promise<any> {
    return this.request(`/api/artifacts/${id}/share-links`);
  }

  async mintArtifactShareLink(
    id: string,
    params: { ttlSeconds?: number; scope?: Record<string, unknown> } = {},
  ): Promise<any> {
    return this.request(`/api/artifacts/${id}/share-links`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }
}
