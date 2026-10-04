import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';

/**
 * A stand-in for the server's `/gateway` socket (src/core/gateway), driven
 * from a spec. Each browser tab opens one connection; the stub answers its
 * `auth` with `auth_ok` and its `subscribe` with a `permission.pending`
 * snapshot, records every client message, and lets the spec push events to
 * every open tab as the hub would (every tab of the user gets the user's
 * events).
 */
export interface GatewayStub {
  /** Open connections, in the order the tabs opened them. */
  readonly sockets: WebSocketRoute[];
  /** Every client message after `auth`, across tabs, in arrival order. */
  readonly sent: Array<Record<string, any>>;
  /** Pattern subscriptions so far, one per (re)connect of a tab (each is sent its snapshot). */
  subscribed(): number;
  /** Publish a user event to every tab. Returns the event id. */
  event(type: string, payload: unknown, sessionId?: string, extra?: { source?: string }): string;
  /** Send a raw server message to every tab. */
  send(message: Record<string, unknown>): void;
  /** The snapshot the next subscribing tab receives. */
  setPending(pending: { requests?: unknown[]; approvals?: unknown[] }): void;
}

export interface GatewayStubOptions {
  userId?: string;
  /** Refuse sign-in as the server does for a user at `gateway.maxConnectionsPerUser`. */
  tooManyConnections?: () => boolean;
}

let eventSeq = 0;

export async function stubGateway(target: Page | BrowserContext, options: GatewayStubOptions = {}): Promise<GatewayStub> {
  const sockets: WebSocketRoute[] = [];
  const sent: Array<Record<string, any>> = [];
  let pending: { requests: unknown[]; approvals: unknown[] } = { requests: [], approvals: [] };
  let subscribed = 0;
  const userId = options.userId ?? 'e2e-user-id';

  await target.routeWebSocket(/\/gateway/, (ws) => {
    const connectionId = `conn-${sockets.length + 1}`;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.type === 'auth') {
        if (options.tooManyConnections?.()) {
          ws.send(JSON.stringify({ type: 'auth_error', reason: 'Too many connections' }));
          void ws.close({ code: 4001, reason: 'Too many connections' });
          return;
        }
        sockets.push(ws);
        ws.send(JSON.stringify({
          type: 'auth_ok', connectionId, userId, capabilities: ['chat', 'subscribe'],
          serverTime: new Date().toISOString(), serverTimezone: 'UTC', maxFrameBytes: 262_144,
        }));
        return;
      }
      sent.push(message);
      // Pattern subscriptions get the pending snapshot; resource ones
      // (`chat:inbox`) are granted, as the hub does.
      if (message.type === 'subscribe' && message.patterns?.length) {
        subscribed++;
        ws.send(JSON.stringify({ type: 'permission.pending', ...pending }));
      }
      if (message.type === 'subscribe' && message.resources?.length) {
        ws.send(JSON.stringify({ type: 'subscribed', resources: message.resources }));
      }
      if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }));
    });
  });

  const send = (message: Record<string, unknown>) => {
    for (const ws of sockets) ws.send(JSON.stringify(message));
  };

  return {
    sockets,
    sent,
    subscribed: () => subscribed,
    event(type, payload, sessionId, extra) {
      const id = `evt-${++eventSeq}`;
      send({
        type: 'event',
        event: { id, type, source: extra?.source ?? 'test', userId, ...(sessionId ? { sessionId } : {}), timestamp: Date.now(), payload },
      });
      return id;
    },
    send,
    setPending(next) {
      pending = { requests: next.requests ?? [], approvals: next.approvals ?? [] };
    },
  };
}
