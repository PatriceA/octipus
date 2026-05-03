/**
 * Agent / chat state for the TUI editor.
 *
 * Mirrors `src/tui/app.tsx`'s state surface (messages, current
 * tool, pending permission, cumulative cost) but cleanly separated
 * from React so tests + the gateway client can drive it
 * synchronously.
 */
export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
}

export type ToolState = 'pending' | 'executing' | 'completed' | 'error';

export interface ToolExecution {
  name: string;
  state: ToolState;
  startedAt: number;
  preview?: string;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  detail: string;
}

export interface CumulativeStats {
  tokens: number;
  cost: number;
  turns: number;
}

export interface AgentLastStats {
  model?: string;
  role?: string;
  tokens?: number;
  durationMs?: number;
  costUsd?: number;
}

export interface AgentState {
  connectionStatus: 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'error';
  agentRunning: boolean;
  messages: readonly ChatMessage[];
  currentTool: ToolExecution | null;
  pendingPermission: PendingPermission | null;
  cumulative: CumulativeStats;
  lastStats: AgentLastStats;
}

export type AgentListener = (s: AgentState) => void;

const MAX_MESSAGES = 500;

export class AgentStore {
  private state: AgentState = {
    connectionStatus: 'disconnected',
    agentRunning: false,
    messages: [],
    currentTool: null,
    pendingPermission: null,
    cumulative: { tokens: 0, cost: 0, turns: 0 },
    lastStats: {},
  };
  private listeners = new Set<AgentListener>();
  private idCounter = 0;

  get(): AgentState { return this.state; }

  subscribe(fn: AgentListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  setStatus(s: AgentState['connectionStatus']): void { this.set({ connectionStatus: s }); }

  pushMessage(role: Role, content: string): ChatMessage {
    const msg: ChatMessage = {
      id: `m${++this.idCounter}`,
      role,
      content,
      timestamp: Date.now(),
    };
    const next = [...this.state.messages, msg];
    if (next.length > MAX_MESSAGES) next.splice(0, next.length - MAX_MESSAGES);
    this.set({ messages: next });
    return msg;
  }

  clearMessages(): void {
    this.set({
      messages: [],
      cumulative: { tokens: 0, cost: 0, turns: 0 },
      lastStats: {},
    });
  }

  setAgentRunning(v: boolean): void { this.set({ agentRunning: v }); }

  setCurrentTool(t: ToolExecution | null): void { this.set({ currentTool: t }); }

  /** Update a tool's state without losing the startedAt / preview. */
  patchCurrentTool(patch: Partial<ToolExecution>): void {
    const cur = this.state.currentTool;
    if (!cur) return;
    this.set({ currentTool: { ...cur, ...patch } });
  }

  setPendingPermission(p: PendingPermission | null): void { this.set({ pendingPermission: p }); }

  /** Add to the cumulative counters after an agent.completed event. */
  addRun(stats: { tokens?: number; cost?: number }): void {
    const c = this.state.cumulative;
    this.set({
      cumulative: {
        tokens: c.tokens + (stats.tokens ?? 0),
        cost: c.cost + (stats.cost ?? 0),
        turns: c.turns + 1,
      },
    });
  }

  setLastStats(s: AgentLastStats): void { this.set({ lastStats: { ...this.state.lastStats, ...s } }); }
}
