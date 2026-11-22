/**
 * Gateway traffic in the shapes the server really sends, for tests that drive
 * the chat through the real `GatewayClient` → `GatewayAdapter` decode path.
 *
 * Each builder names the emitter it copies. Hand-written events with explicit
 * `nodeId`s let the turn logic pass tests against traffic the decoder never
 * produces (a worker finishing ended the turn, because `worker_completed`
 * carries `workerId`, never `agentId`) — so tests build frames here instead.
 */

/** A gateway event as `hub.publishEvent` puts it on the wire (`{ type: 'event', event }`). */
export interface WireEvent { type: string; payload: Record<string, unknown>; sessionId?: string }

let eventSeq = 0;

/** The `{ type: 'event' }` frame `GatewayHub.deliver` sends for one event. */
export function eventFrame(event: WireEvent, userId = 'user-1'): Record<string, unknown> {
  return { type: 'event', event: { ...event, id: `evt-${++eventSeq}`, source: 'test', userId, timestamp: Date.now() } };
}

/** `sendToConnection(…, { type: 'error', code, message })` (message-handler.ts), plus what a chat.send's errors echo. */
export function errorFrame(code: string, message: string, extra: { sessionId?: string; turnId?: string } = {}): Record<string, unknown> {
  return { type: 'error', code, message, ...extra };
}

export const authOk = (userId = 'user-1') => ({
  type: 'auth_ok', connectionId: 'conn-1', userId, capabilities: [], serverTime: new Date().toISOString(), serverTimezone: 'UTC',
});

export const commandResult = (name: string, result: unknown, data?: unknown, error?: string) => ({
  type: 'command.result', name, result, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}),
});

export const wire = {
  /** root-runner.ts `worker_spawned` → event-bridge `agent.spawned`: the root names itself `agentId`, with `root: true`. */
  rootSpawned: (sessionId: string, agentId: string, model = 'fixture-model'): WireEvent =>
    ({ type: 'agent.spawned', sessionId, payload: { agentId, role: 'general', root: true, model } }),
  /** root-runner.ts `worker_completed` → `agent.completed`: the root's id is `workerId` here, with `root: true`. */
  rootCompleted: (sessionId: string, agentId: string, status?: 'stopped' | 'failed'): WireEvent =>
    ({ type: 'agent.completed', sessionId, payload: {
      workerId: agentId, role: 'general', root: true, result: '', model: 'fixture-model', durationMs: 1200, totalTokens: 900, iterations: 2,
      ...(status ? { status } : {}),
    } }),
  /** worker-spawner.ts `worker_spawned`: a worker names itself `workerId` and its parent `parentAgentId`; no `root`. */
  workerSpawned: (sessionId: string, workerId: string, parentAgentId: string, role = 'research'): WireEvent =>
    ({ type: 'agent.spawned', sessionId, payload: { workerId, role, model: 'fixture-model', parentAgentId } }),
  /** worker-spawner.ts `worker_completed` (`WorkerResult`): `workerId`, never `agentId`; no `root`. */
  workerCompleted: (sessionId: string, workerId: string, role = 'research'): WireEvent =>
    ({ type: 'agent.completed', sessionId, payload: { workerId, role, result: 'worker report', model: 'fixture-model', iterations: 3, durationMs: 4000, totalTokens: 1500 } }),
  /** swarm/spawner.ts `emitNodeSpawned`. */
  nodeSpawned: (sessionId: string, nodeId: string, parentNodeId: string, role = 'research'): WireEvent =>
    ({ type: 'swarm.node_spawned', sessionId, payload: { rootSessionId: sessionId, nodeId, parentNodeId, kind: 'agent', depth: 1, topicPath: `root/${role}`, role, model: 'fixture-model' } }),
  /** swarm/spawner.ts `emitNodeCompleted`. */
  nodeCompleted: (sessionId: string, nodeId: string, parentNodeId: string, role = 'research'): WireEvent =>
    ({ type: 'swarm.node_completed', sessionId, payload: { rootSessionId: sessionId, nodeId, parentNodeId, kind: 'agent', depth: 1, topicPath: `root/${role}`, role, status: 'completed', usedTokens: 1200, durationMs: 3400 } }),
  /** event-bridge.ts `text_delta` → `chat.delta`. */
  delta: (sessionId: string, agentId: string, delta: string, iteration = 1): WireEvent =>
    ({ type: 'chat.delta', sessionId, payload: { agentId, delta, iteration } }),
  /** agent-worker.ts `tool_call` action → event-bridge `agent.action` (data spread into the payload). */
  toolCall: (sessionId: string, agentId: string, toolName: string): WireEvent =>
    ({ type: 'agent.action', sessionId, payload: { agentId, agentEvent: 'action', type: 'tool_call', toolName, toolId: toolName, sessionId } }),
  /** cli-adapters.ts `cli_tool_use` → `agent.action`. */
  cliToolUse: (sessionId: string, agentId: string, id: string, toolName: string, args: Record<string, unknown>): WireEvent =>
    ({ type: 'agent.action', sessionId, payload: { agentId, agentEvent: 'action', type: 'cli_tool_use', id, toolName, args } }),
  /** message-handler.ts `handleChatSend`: `{ response: TurnResult }`, the `turnId` the send carried echoed. */
  chatResponse: (sessionId: string, text: string, turnId?: string): WireEvent =>
    ({ type: 'chat.response', sessionId, payload: { response: { response: text, agentId: 'root', outcome: 'success' }, ...(turnId ? { turnId } : {}) } }),
  /** service.ts `publishResponse` (a background reply) → `chat.response` with no turn id. */
  backgroundResponse: (sessionId: string, text: string): WireEvent =>
    ({ type: 'chat.response', sessionId, payload: { response: { response: text, outcome: 'success' } } }),
  /** message-handler.ts `handleChatSend` catch: `chat.error` to every tab of the user. */
  chatError: (sessionId: string, error: string, opts: { cancelled?: boolean; turnId?: string } = {}): WireEvent =>
    ({ type: 'chat.error', sessionId, payload: { error, ...(opts.cancelled ? { cancelled: true } : {}), ...(opts.turnId ? { turnId: opts.turnId } : {}) } }),
  /** message-handler.ts `handleAgentStop` / `handleSessionStop`. */
  agentStopped: (sessionId: string | undefined, agentId: string, root: boolean): WireEvent =>
    ({ type: 'agent.stopped', ...(sessionId ? { sessionId } : {}), payload: { agentId, stoppedBy: 'user-1', root } }),
  /** message-handler.ts `handleSessionStop`: what a session stop did. */
  sessionStopped: (sessionId: string, stopped: number, droppedQueued: number): WireEvent =>
    ({ type: 'session.stopped', sessionId, payload: { sessionId, stopped, droppedQueued, stoppedBy: 'user-1' } }),
  /** message-handler.ts `publishSessionStats`. */
  sessionStats: (sessionId: string): WireEvent =>
    ({ type: 'session.stats', sessionId, payload: { totalTokens: 1000, inputTokens: 600, outputTokens: 400, totalCostUsd: 0.01, requestCount: 2 } }),
};

/**
 * A stand-in for the global `WebSocket` the client opens: records what the
 * client sends and lets the test play the server.
 */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = FakeSocket.CLOSED; }
  /** Accept the connection and authenticate it, as the gateway does. */
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); this.receive(authOk()); }
  receive(frame: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  event(event: WireEvent): void { this.receive(eventFrame(event)); }
  /** The server went away (not a clean close): the client schedules a reconnect. */
  drop(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.({ code: 1006 }); }
  static latest(): FakeSocket {
    const socket = FakeSocket.all.at(-1);
    if (!socket) throw new Error('The client opened no socket');
    return socket;
  }
}
