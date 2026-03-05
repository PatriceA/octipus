/**
 * Lightweight HTTP client for the assistant backend REST API.
 * All methods correspond to existing API endpoints or the new skill execution endpoint.
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

export interface Preset {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  role: string;
  isSystem: boolean;
  modelPreference?: string;
}

export interface SkillInfo {
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

export class AssistantClient {
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

  async chat(message: string, sessionId?: string): Promise<ChatResponse> {
    return this.request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        sessionId,
        channel: 'mcp',
      }),
    });
  }

  async chatWithPreset(message: string, presetId: string, sessionId?: string): Promise<ChatResponse> {
    return this.request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        sessionId,
        presetId,
        channel: 'mcp',
      }),
    });
  }

  // ─── Presets ───

  async listPresets(): Promise<Preset[]> {
    const res = await this.request<{ presets: Preset[] }>('/api/presets');
    return res.presets || [];
  }

  async getPreset(id: string): Promise<Preset> {
    return this.request<Preset>(`/api/presets/${id}`);
  }

  // ─── Search ───

  async search(query: string, maxResults = 10): Promise<{ query: string; resultCount: number; results: SearchResult[] }> {
    return this.request('/api/skills/websearch/tools/search/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { query, max_results: maxResults } }),
    });
  }

  async fetchPage(url: string, maxLength = 10000): Promise<PageContent> {
    return this.request('/api/skills/websearch/tools/fetch_page/execute', {
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

  // ─── Skills ───

  async listSkills(): Promise<SkillInfo[]> {
    const res = await this.request<{ skills: SkillInfo[] }>('/api/skills');
    return res.skills || [];
  }

  async executeTool(skillId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<{ result: unknown }>(
      `/api/skills/${skillId}/tools/${toolName}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({ args }),
      },
    );
    return res.result;
  }

  // ─── Recurring Tasks ───

  async listRecurringTasks(): Promise<Array<{
    id: string; name: string; cronExpression: string; isEnabled: boolean;
    runCount: number; nextRunAt: string | null; status: string;
  }>> {
    const res = await this.request<{ tasks: any[] }>('/api/recurring-tasks');
    return res.tasks || [];
  }

  async createRecurringTask(params: {
    name: string; cronExpression: string; actionType: string;
    actionConfig: Record<string, unknown>; description?: string; timezone?: string;
  }): Promise<{ id: string; name: string; cronExpression: string; nextRunAt: string }> {
    const res = await this.request<{ task: any }>('/api/recurring-tasks', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    return res.task;
  }

  async updateRecurringTask(id: string, params: {
    name?: string; cronExpression?: string; isEnabled?: boolean;
  }): Promise<{ id: string; name: string; cronExpression: string; isEnabled: boolean }> {
    const res = await this.request<{ task: any }>(`/api/recurring-tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    });
    return res.task;
  }

  async deleteRecurringTask(id: string): Promise<void> {
    await this.request(`/api/recurring-tasks/${id}`, { method: 'DELETE' });
  }

  // ─── Knowledge / RAG ───

  async searchKnowledge(query: string, limit?: number): Promise<{ results: any[] }> {
    return this.request('/api/skills/knowledge/tools/search_knowledge/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { query, limit: limit || 5 } }),
    });
  }

  async indexFile(path: string, type?: string): Promise<{ indexed: boolean; chunks: number; path: string }> {
    return this.request('/api/skills/knowledge/tools/index_file/execute', {
      method: 'POST',
      body: JSON.stringify({ args: { path, type: type || 'document' } }),
    });
  }

  // ─── Health ───

  async getHealth(): Promise<Record<string, unknown>> {
    return this.request('/api/health');
  }
}
