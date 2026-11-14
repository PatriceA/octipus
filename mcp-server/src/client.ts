/**
 * Lightweight HTTP client for Octipus backend REST API.
 * All methods correspond to existing API endpoints or the new tool execution endpoint.
 */

import { AuthSession } from './auth.js';

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

export interface MemoryRow {
  id: string;
  factType: string;
  content: string;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** A non-2xx answer from the backend, with its status and (JSON) body. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) { super(message); }
}

/** The client gives up on a request after this long; the server may still be working on it. */
export const REQUEST_TIMEOUT_MS = 25_000;

/** True when the request was cut off by the client timeout (the server may still be running it). */
export function isClientTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * The `Idempotency-Key` header for a call that creates work (docs/API.md): a
 * retry with the same key gets the first call's result instead of a second
 * copy of the work. `suffix` keys a helper request the call makes first (the
 * session a spawned agent runs in), so it is not duplicated either.
 */
function idempotencyHeaders(key: string | undefined, suffix?: string): Record<string, string> {
  return key ? { 'Idempotency-Key': suffix ? `${key}:${suffix}` : key } : {};
}

export class OctiClient {
  private readonly auth = new AuthSession();

  constructor(
    private baseUrl: string,
  ) {}

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    return (await this.requestRaw(path, options)).json() as Promise<T>;
  }

  /** A successful response as it came (binary bodies: speech); a non-2xx answer throws `ApiError`. */
  private async requestRaw(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let authHeaders = await this.auth.getHeaders(this.baseUrl);
    const send = (headers: Record<string, string>) => fetch(url, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...headers, ...options.headers },
    });
    let res = await send(authHeaders);

    if (res.status === 401 && this.auth.canRefresh) {
      await res.body?.cancel().catch(() => undefined);
      const refreshed = await this.auth.refreshAfterUnauthorized(
        this.baseUrl,
        authHeaders.Authorization,
      );
      if (refreshed) {
        authHeaders = refreshed;
        res = await send(authHeaders);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let parsed: unknown = body;
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      throw new ApiError(`API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`, res.status, parsed);
    }

    return res;
  }

  // ─── Modules ───

  /** The modules that are on (docs/MODULES.md); tools of the others are hidden. */
  async getEnabledModules(): Promise<string[]> {
    return (await this.getModulesState()).enabled;
  }

  /**
   * The modules that are on and the capabilities that are configured
   * (docs/MODULES.md → Capability gates). A server from before capabilities
   * reports none: every capability then counts as configured, as it was.
   */
  async getModulesState(): Promise<{ enabled: string[]; capabilities: Record<string, boolean> | null }> {
    const res = await this.request<{ enabled?: string[]; capabilities?: Array<{ id: string; on: boolean }> }>('/api/modules');
    return {
      enabled: Array.isArray(res.enabled) ? res.enabled : [],
      capabilities: Array.isArray(res.capabilities) ? Object.fromEntries(res.capabilities.map((c) => [c.id, c.on === true])) : null,
    };
  }

  // ─── Media (docs/MEDIA.md → Over MCP and HTTP) ───

  async generateImage(params: { prompt: string; aspect_ratio?: 'square' | 'landscape' | 'portrait'; n?: number }): Promise<{
    images: Array<{ mimeType: string; base64: string }>;
    model: string;
    revisedPrompt?: string;
  }> {
    return this.request('/api/media/images', { method: 'POST', body: JSON.stringify(params) });
  }

  async describeImage(params: { image: string; mimeType?: string; question?: string }): Promise<{ description: string; model: string }> {
    return this.request('/api/media/describe', { method: 'POST', body: JSON.stringify(params) });
  }

  async transcribeAudio(params: { audio: string; format?: string }): Promise<{ text: string; model?: string; language?: string; duration?: number; error?: string }> {
    return this.request('/api/voice/transcribe', { method: 'POST', body: JSON.stringify(params) });
  }

  /** The Speech lane's audio for `text`, with its media type. */
  async speak(params: { text: string; voice_id?: string; format?: string }): Promise<{ base64: string; mimeType: string }> {
    const res = await this.requestRaw('/api/voice/speak', { method: 'POST', body: JSON.stringify(params) });
    const mimeType = (res.headers.get('content-type') ?? 'audio/mpeg').split(';')[0].trim();
    return { base64: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType };
  }

  // ─── Chat ───

  async chat(message: string, sessionId?: string, clientRequestId?: string): Promise<ChatResponse> {
    // No `expertId`: the expert layer is gone. A request is routed to a model
    // lane by what it asks for, and a specialist is a ROLE the agent spawns.
    return this.request<ChatResponse>('/api/chat', {
      method: 'POST',
      headers: idempotencyHeaders(clientRequestId),
      body: JSON.stringify({
        message,
        sessionId,
        channel: 'mcp',
      }),
    });
  }

  async createSession(opts: { channelType?: string; title?: string; context?: Record<string, unknown>; clientRequestId?: string }): Promise<{ id: string }> {
    return this.request<{ id: string }>('/api/sessions', {
      method: 'POST',
      headers: idempotencyHeaders(opts.clientRequestId, 'session'),
      body: JSON.stringify({
        channelType: opts.channelType || 'mcp',
        channelId: `mcp-${Date.now().toString(36)}`,
        title: opts.title,
        context: opts.context,
      }),
    });
  }

  // ─── Search ───

  async search(query: string, maxResults = 10): Promise<{ query: string; resultCount: number; results: SearchResult[] }> {
    return this.runTool('websearch', 'search', { query, max_results: maxResults });
  }

  async fetchPage(url: string, maxLength = 10000): Promise<PageContent> {
    return this.runTool('websearch', 'fetch_page', { url, max_length: maxLength });
  }

  // ─── Agents ───

  async listAgents(): Promise<Agent[]> {
    const res = await this.request<{ agents: Agent[] }>('/api/agents');
    return res.agents || [];
  }

  async spawnAgent(message: string, model?: string, topic?: string, clientRequestId?: string): Promise<Agent> {
    // POST /api/agents requires a sessionId (body schema: `sessionId: t.String()`).
    // Without one the spawn 422s ("Invalid request data"), which made
    // `octipus_spawn_agent` fail unconditionally. Create a session first so the
    // spawned agent has a home for its messages/events, then spawn into it.
    const session = await this.createSession({ channelType: 'mcp', title: 'MCP agent', clientRequestId });
    return this.request<Agent>('/api/agents', {
      method: 'POST',
      headers: idempotencyHeaders(clientRequestId),
      body: JSON.stringify({ sessionId: session.id, message, model, topic }),
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

  async getAgentActivity(args: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value !== undefined) query.set(key, String(value));
    const result = await this.request<{ error?: string }>(`/api/agents/activity?${query}`);
    if (result.error) throw new Error(result.error);
    return result;
  }

  async getAgentEvents(agentId: string, after?: number): Promise<AgentEvent[]> {
    const qs = after !== undefined ? `?after=${after}` : '';
    const res = await this.request<{ events?: AgentEvent[]; error?: string }>(`/api/agents/${encodeURIComponent(agentId)}/events${qs}`);
    if (res.error) throw new Error(res.error);
    if (!Array.isArray(res.events)) throw new Error('Agent events response is missing its event list');
    return res.events;
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

  async executeTool(toolId: string, toolName: string, args: Record<string, unknown>, clientRequestId?: string): Promise<unknown> {
    return this.runTool(toolId, toolName, args, clientRequestId);
  }

  /**
   * Run one backend tool and return WHAT IT RETURNED.
   *
   * `/api/tools/:id/tools/:name/execute` answers `{ result }`, and the typed
   * helpers below used to hand that envelope straight back — so every caller
   * read `.results` / `.content` off the wrapper and found nothing. That is why
   * `octipus_search_knowledge` reported "No relevant knowledge found" against a
   * knowledge base with 1600 indexed chunks, and `octipus_read_knowledge`
   * rendered "undefined". Unwrap in one place; the helpers just name the tool.
   */
  private async runTool<T>(toolId: string, toolName: string, args: Record<string, unknown>, clientRequestId?: string): Promise<T> {
    const res = await this.request<{ result?: T; error?: string }>(
      `/api/tools/${toolId}/tools/${toolName}/execute`,
      {
        method: 'POST',
        headers: idempotencyHeaders(clientRequestId),
        body: JSON.stringify({ args }),
      },
    );
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as T;
  }

  // ─── Memory (long-term facts) ───

  async listMemories(opts: { factType?: string; limit?: number; includeHistory?: boolean } = {}): Promise<{ memories: MemoryRow[]; total: number }> {
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
  }, clientRequestId?: string): Promise<Record<string, unknown>> {
    return this.request('/api/hooks', {
      method: 'POST',
      headers: idempotencyHeaders(clientRequestId),
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
    return this.runTool('knowledge', 'search_knowledge', {
      query,
      limit: limit || 5,
      mode: mode || 'hybrid',
    });
  }

  async readKnowledge(id: string): Promise<any> {
    return this.runTool('knowledge', 'read_knowledge', { id });
  }

  async indexFile(path: string, type?: string): Promise<{ indexed: boolean; chunks: number; path: string }> {
    return this.runTool('knowledge', 'index_file', { path, type: type || 'document' });
  }

  // ─── Messaging ───

  async sendChannelMessage(
    channel: string,
    target: string,
    message: string,
    replyTo?: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.runTool('messaging', 'send_message', {
      channel,
      target,
      message,
      reply_to: replyTo,
    });
  }

  async listChannels(): Promise<{ channels: Array<{ type: string; name: string; connected: boolean }> }> {
    return this.runTool('messaging', 'list_channels', {});
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

  async createPipeline(templateName: string, description: string, clientRequestId?: string): Promise<any> {
    return this.request('/api/pipelines', {
      method: 'POST',
      headers: idempotencyHeaders(clientRequestId),
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
    // `/admin/audit`, not `/api/audit` — the audit log lives under the admin
    // routes and the flat path has 404'd since this method was written.
    return this.request(`/api/admin/audit?limit=${limit}`);
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
