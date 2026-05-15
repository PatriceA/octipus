/**
 * Adapter between octipus's WebSocket GatewayClient and the pi-tui
 * shell. UI components subscribe to `on(fn)` and never touch the raw
 * client. All event-decoding that previously lived inline in
 * src/tui/app.tsx:125-208 moves here so the renderer stays dumb.
 *
 * Every gateway event is normalized into a discriminated
 * `AgentSessionEvent` so the rest of the app can pattern-match on
 * `kind` without re-parsing payload shapes.
 */
import { type ConnectionStatus, GatewayClient, type GatewayClientOptions } from '@/core/gateway/client';

export type Role = 'user' | 'assistant' | 'system';
export type ToolState = 'pending' | 'executing' | 'completed' | 'error';

export interface ToolEventState {
  state: ToolState;
  name: string;
  preview?: string;
  mcpServer?: string;
}

export interface AgentEndStats {
  tokens: number;
  cost: number;
  durationMs?: number;
  iterations?: number;
}

export type AgentSessionEvent =
  | { kind: 'status';         status: ConnectionStatus }
  | { kind: 'message';        role: Role; content: string }
  | { kind: 'permission';     requestId: string; toolName: string; detail: string }
  | { kind: 'agent.start';    role: string; model: string; nodeId?: string }
  | { kind: 'agent.end';      stats: AgentEndStats; nodeId?: string; role?: string }
  | { kind: 'agent.iteration'; agentId: string; iteration: number }
  | { kind: 'tool';           tool: ToolEventState }
  | { kind: 'command.result'; name: string; result: unknown; error?: string }
  | { kind: 'agent.write';    path: string; newText: string }
  | { kind: 'expert';         expertId: string | null }
  | { kind: 'error';          message: string };

export interface GatewayAdapterOptions {
  url?: string;
  getWorkspace?: () => string | null | undefined;
  /**
   * Optional session-scope filter. When set, events whose envelope
   * `sessionId` (or payload `rootSessionId` for swarm events) does
   * NOT match this id are dropped before decoding. Without it the
   * TUI surfaces agent + swarm events from every concurrent session
   * on the same WS connection — e.g. someone running a webchat
   * session in another tab leaks "Subagent spawned" lines into the
   * TUI. Permission requests still flow through unconditionally
   * because their event envelope doesn't always carry a sessionId.
   */
  getSessionId?: () => string | null | undefined;
}

const PERMISSION_DETAIL_MAX = 80;

export class GatewayAdapter {
  private readonly client: GatewayClient;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  /**
   * Workspace slug attached to the next connect. The GatewayClient
   * reads this on every connect via `getWorkspace`, so a runtime
   * switch is just `setWorkspace(slug)` + a disconnect/reconnect
   * cycle (see `reconnectWithWorkspace`).
   */
  private workspaceSlug: string | null;
  private readonly externalGetWorkspace?: () => string | null | undefined;
  private readonly getSessionId?: () => string | null | undefined;

  constructor(options: GatewayAdapterOptions = {}) {
    this.externalGetWorkspace = options.getWorkspace;
    this.workspaceSlug = options.getWorkspace?.() ?? null;
    this.getSessionId = options.getSessionId;
    const clientOptions: GatewayClientOptions = {
      url: options.url,
      getWorkspace: () => this.workspaceSlug ?? this.externalGetWorkspace?.() ?? null,
      onStatusChange: (status) => this.emit({ kind: 'status', status }),
      onResponse: (response) => this.emit({ kind: 'message', role: 'assistant', content: response }),
      onCommandResult: (name, result, error) => this.emit({ kind: 'command.result', name, result, error }),
      onError: (message) => this.emit({ kind: 'error', message }),
      onEvent: (event) => this.decode(event),
    };
    this.client = new GatewayClient(clientOptions);
  }

  /** Update the workspace slug used on the next connect. */
  setWorkspace(slug: string | null): void {
    this.workspaceSlug = slug;
  }

  getWorkspace(): string | null {
    return this.workspaceSlug;
  }

  /**
   * Switch the active workspace and re-establish the gateway
   * connection so the new slug takes effect immediately. Reuses the
   * client's existing reconnect path so backoff + auth retry behave
   * identically to a normal reconnect.
   */
  async reconnectWithWorkspace(slug: string | null): Promise<void> {
    this.setWorkspace(slug);
    try { this.client.disconnect(); } catch { /* already disconnected */ }
    await this.client.connect();
  }

  // ── Subscription ────────────────────────────────────────────────

  on(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Connection ──────────────────────────────────────────────────

  connect(): Promise<void> { return this.client.connect(); }
  disconnect(): void { this.client.disconnect(); }
  getStatus(): ConnectionStatus { return this.client.getStatus(); }

  // ── Outgoing messages ───────────────────────────────────────────

  sendChat(sessionId: string, content: string, expertId?: string, projectPath?: string): void {
    this.client.sendChat(sessionId, content, expertId, projectPath);
  }

  sendCommand(name: string, args?: Record<string, string>): void {
    this.client.sendCommand(name, args);
  }

  respondPermission(requestId: string, approved: boolean): void {
    this.client.respondPermission(requestId, approved);
  }

  // ── Internals ───────────────────────────────────────────────────

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private decode(event: { type: string; payload?: unknown; sessionId?: string }): void {
    const myId = this.getSessionId?.();
    if (myId && !eventBelongsToSession(event, myId)) return;
    for (const decoded of decodeGatewayEvent(event)) this.emit(decoded);
  }
}

/**
 * Drop events that belong to a different session. Returns true when:
 *   - the event carries no sessionId (e.g. permission requests, status
 *     pings) — let them through; the rest of the app filters by id
 *     where it matters,
 *   - the envelope sessionId matches, or
 *   - the payload rootSessionId matches (swarm events).
 */
function eventBelongsToSession(
  event: { type: string; payload?: unknown; sessionId?: string },
  mySessionId: string,
): boolean {
  if (event.sessionId && event.sessionId !== mySessionId) {
    const payload = asRecord(event.payload);
    const root = payload ? pickString(payload, 'rootSessionId') : undefined;
    if (!root) return false;
    return root === mySessionId;
  }
  // No envelope sessionId — keep (permission/status flow).
  if (!event.sessionId) {
    const payload = asRecord(event.payload);
    const root = payload ? pickString(payload, 'rootSessionId') : undefined;
    if (root && root !== mySessionId) return false;
  }
  return true;
}

/**
 * Pure decoder: gateway raw event → AgentSessionEvent[]. Extracted so
 * tests can exercise the shape matching without spinning up a real
 * GatewayClient/WebSocket. Mirrors src/tui/app.tsx:125-208 — keep both
 * sides in sync until the old TUI is removed in Phase 8.
 */
export function decodeGatewayEvent(event: { type: string; payload?: unknown }): AgentSessionEvent[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const out: AgentSessionEvent[] = [];

  switch (event.type) {
    case 'permission.request': {
      const toolName = pickString(payload, 'toolName') ?? pickString(payload, 'action') ?? 'unknown';
      const requestId = pickString(payload, 'requestId') ?? '';
      const args = asRecord(payload.args);
      let detail = toolName;
      if (args) {
        const path = pickString(args, 'path') ?? pickString(args, 'file_path') ?? pickString(args, 'filename');
        const command = pickString(args, 'command');
        if (path) {
          detail = `${toolName} → ${path}`;
        } else if (command) {
          detail = `${toolName} → ${command.length > PERMISSION_DETAIL_MAX
            ? `${command.slice(0, PERMISSION_DETAIL_MAX - 3)}...`
            : command}`;
        }
      }
      out.push({ kind: 'permission', requestId, toolName, detail });
      return out;
    }

    case 'agent.spawned': {
      const role = pickString(payload, 'role')
        ?? pickString(asRecord(payload.data), 'role')
        ?? 'worker';
      const model = pickString(payload, 'model')
        ?? pickString(asRecord(payload.data), 'model')
        ?? '';
      const nodeId = pickString(payload, 'agentId')
        ?? pickString(asRecord(payload.data), 'agentId');
      out.push({ kind: 'agent.start', role, model, nodeId });
      out.push({
        kind: 'message', role: 'system',
        content: `Agent spawned: ${role}${model ? ` (${model})` : ''}`,
      });
      return out;
    }

    case 'agent.completed': {
      const stats = asRecord(payload.stats) ?? asRecord(payload.data) ?? {};
      const tokens = pickNumber(stats, 'totalTokens') ?? pickNumber(stats, 'total_tokens') ?? 0;
      const cost = pickNumber(stats, 'totalCostUsd') ?? pickNumber(stats, 'total_cost_usd') ?? 0;
      const durationMs = pickNumber(stats, 'durationMs') ?? pickNumber(stats, 'duration_ms');
      const iterations = pickNumber(stats, 'iterations') ?? pickNumber(asRecord(payload.data), 'iterations');
      const role = pickString(payload, 'role') ?? pickString(asRecord(payload.data), 'role');
      const nodeId = pickString(payload, 'agentId') ?? pickString(asRecord(payload.data), 'agentId');
      out.push({ kind: 'agent.end', stats: { tokens, cost, durationMs, iterations }, nodeId, role });
      // Show runtime + iteration count for parity with the web chat sidepanel.
      const parts: string[] = ['Agent completed'];
      if (role) parts.push(role);
      if (durationMs != null) parts.push(formatDurationMs(durationMs));
      if (iterations != null) parts.push(`${iterations} iter`);
      if (tokens > 0) parts.push(`${tokens} tok`);
      out.push({ kind: 'message', role: 'system', content: `${parts[0]}: ${parts.slice(1).join(' · ') || '—'}` });
      return out;
    }

    // Swarm-level spawn/complete events — these fire for orchestrator AND
    // every nested agent/subagent. The TUI previously only listened to the
    // worker-spawner-flavoured `agent.spawned` event, so swarm-routed
    // subagents were invisible. Mirror them into the same agent.start /
    // agent.end shapes so the rest of the UI doesn't have to care which
    // path spawned the worker.
    case 'swarm.node_spawned': {
      const kind = pickString(payload, 'kind') ?? 'agent';
      // Orchestrator already gets a separate agent.spawned event from the
      // worker spawner; skip the duplicate so we don't show it twice.
      if (kind === 'orchestrator') return out;
      const role = pickString(payload, 'role') ?? 'worker';
      const model = pickString(payload, 'model') ?? '';
      const nodeId = pickString(payload, 'nodeId');
      const topicPath = pickString(payload, 'topicPath');
      out.push({ kind: 'agent.start', role, model, nodeId });
      const label = topicPath && topicPath !== 'root' ? `${role} → ${topicPath}` : role;
      out.push({
        kind: 'message', role: 'system',
        content: `Subagent spawned: ${label}${model ? ` (${model})` : ''}`,
      });
      return out;
    }

    case 'swarm.node_completed': {
      const kind = pickString(payload, 'kind') ?? 'agent';
      if (kind === 'orchestrator') return out; // dedupe with agent.completed
      const role = pickString(payload, 'role') ?? 'worker';
      const tokens = pickNumber(payload, 'usedTokens') ?? 0;
      const durationMs = pickNumber(payload, 'durationMs');
      const status = pickString(payload, 'status') ?? 'completed';
      const nodeId = pickString(payload, 'nodeId');
      out.push({ kind: 'agent.end', stats: { tokens, cost: 0, durationMs }, nodeId, role });
      const parts: string[] = [`Subagent ${status}`, role];
      if (durationMs != null) parts.push(formatDurationMs(durationMs));
      if (tokens > 0) parts.push(`${tokens} tok`);
      out.push({ kind: 'message', role: 'system', content: parts.join(' · ') });
      return out;
    }

    case 'agent.iteration': {
      const agentId = pickString(payload, 'agentId') ?? '';
      const iteration = pickNumber(payload, 'iteration');
      if (iteration != null) {
        out.push({ kind: 'agent.iteration', agentId, iteration });
      }
      return out;
    }

    case 'agent.action': {
      const data = asRecord(payload.data) ?? payload;
      const type = pickString(data, 'type');
      const mcpServer = pickString(data, 'mcpServer');
      if (type === 'tool_call' || type === 'cli_tool_use') {
        const name = pickString(data, 'toolName') ?? pickString(data, 'tool_name') ?? 'tool';
        out.push({ kind: 'tool', tool: { state: 'pending', name, mcpServer } });
        const write = extractAgentWrite(name, asRecord(data.args));
        if (write) out.push({ kind: 'agent.write', path: write.path, newText: write.newText });
      } else if (type === 'cli_tool_result' || type === 'tool_result') {
        const name = pickString(data, 'toolName') ?? pickString(data, 'tool_name') ?? 'tool';
        const isError = Boolean(data.error || data.isError);
        const output = pickString(data, 'output');
        const preview = output?.split('\n')[0]?.slice(0, 80);
        out.push({
          kind: 'tool',
          tool: { state: isError ? 'error' : 'completed', name, preview, mcpServer },
        });
      }
      return out;
    }

    // GatewayClient handles chat.response via onResponse.
    case 'chat.response':
      return out;
  }

  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

const WRITE_TOOL_NAMES = new Set(['write_file', 'write', 'edit', 'apply_patch', 'str_replace_editor']);

/**
 * Recognise write-style tool calls and pull out the proposed text.
 * Returns null when the tool isn't a known editor write or required
 * fields are missing.
 *
 * Conservative on purpose: keeps the diff overlay from triggering on
 * unrelated tool calls (read_file, bash). Extensions can broaden the
 * set in Phase 7 once the registration API exists.
 */
function extractAgentWrite(toolName: string, args: Record<string, unknown> | undefined): { path: string; newText: string } | null {
  if (!args) return null;
  if (!WRITE_TOOL_NAMES.has(toolName)) return null;
  const path = pickString(args, 'path') ?? pickString(args, 'file_path') ?? pickString(args, 'filename');
  if (!path) return null;
  const newText = pickString(args, 'content')
    ?? pickString(args, 'text')
    ?? pickString(args, 'new_str')
    ?? pickString(args, 'replacement');
  if (newText === undefined) return null;
  return { path, newText };
}

function pickString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Compact human duration for the activity/message line. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}
