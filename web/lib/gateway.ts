/**
 * The tab's one gateway connection (`/gateway`).
 *
 * Every part of the web that needs server push — the chat page, the
 * permission prompts, the recommended-models panel, the documents page —
 * shares this connection: one socket per tab, signed in with a ticket
 * (`/auth/ws-ticket` → `auth` with `method: 'session_token'`), subscribed to
 * all of the user's own events. The wire types are the server's
 * (`src/core/gateway/protocol.ts`).
 *
 * On a reconnect it asks the server to `replay` what the watched sessions
 * missed; a replay that cannot bridge the gap is passed on so the page reloads
 * from REST. Over the per-user connection cap the status is `too_many_tabs`
 * and it retries slowly instead of hammering the server.
 */
import type {
  ClientMessage,
  GatewayEvent,
  GatewayMessage,
} from '../../src/core/gateway/protocol';
import { buildWsBase, getWsToken } from './api';

export type { ClientMessage, GatewayEvent, GatewayMessage };

export type GatewayStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'too_many_tabs';

/** The server's `auth_error` reason when the user is at `gateway.maxConnectionsPerUser`. */
const TOO_MANY_CONNECTIONS = 'Too many connections';
const KEEPALIVE_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
/** How often a tab over the cap tries again (another tab may have closed). */
const TOO_MANY_RETRY_MS = 30_000;
/** Event ids remembered to drop a replayed event this tab already saw. */
const SEEN_IDS_MAX = 2_000;

type MessageListener = (message: GatewayMessage) => void;
type StatusListener = (status: GatewayStatus) => void;

export class WebGateway {
  private ws: WebSocket | null = null;
  private status: GatewayStatus = 'idle';
  private wanted = false;
  private backoffMs = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private everConnected = false;
  /** This connection's id (`auth_ok`); a steer this tab sent carries it as `steer:<id>`. */
  private connectionId: string | null = null;
  /** Bumped by every connect, stop and retry: a connect that lost the race drops its socket. */
  private generation = 0;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  /** Sessions a page shows, with the last event id this tab saw for each. */
  private readonly watched = new Map<string, string | undefined>();
  private readonly seenIds = new Set<string>();

  /** Open the connection (idempotent). Called once the user is signed in. */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    void this.connect();
  }

  /** Close it and stop reconnecting (sign-out). */
  stop(): void {
    this.wanted = false;
    this.generation++;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close(1000, 'Signed out');
    }
    this.everConnected = false;
    this.seenIds.clear();
    this.setStatus('idle');
  }

  /** Try again now (the "Too many open tabs" banner's Retry). */
  retry(): void {
    if (!this.wanted) return;
    this.clearTimers();
    this.backoffMs = 1_000;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    void this.connect();
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  /** Send a client message. False when the connection is not signed in. */
  send(message: ClientMessage): boolean {
    if (this.status !== 'connected' || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  /** Resolves true once signed in, false after `timeoutMs` without. */
  whenConnected(timeoutMs: number): Promise<boolean> {
    if (this.status === 'connected') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
      const unsubscribe = this.onStatus((status) => {
        if (status !== 'connected') return;
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
    });
  }

  /** Every server message (events, snapshots, replies, errors). Returns the unsubscribe. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Replay this session's missed events after a reconnect. Returns the
   * unwatch function.
   */
  watchSession(sessionId: string): () => void {
    if (!this.watched.has(sessionId)) this.watched.set(sessionId, undefined);
    return () => this.watched.delete(sessionId);
  }

  // ── Internal ──────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.wanted) return;
    const generation = ++this.generation;
    this.setStatus('connecting');
    const token = await getWsToken();
    if (!this.wanted || generation !== this.generation) return;
    if (!token) {
      // No ticket (session expired, or /auth/ws-ticket rate-limited): back
      // off rather than open a socket the server refuses at once.
      this.scheduleReconnect();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${buildWsBase()}/gateway`);
    } catch (err) {
      console.error('Gateway socket could not be opened', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token }, clientType: 'webchat' } satisfies ClientMessage));
    };
    ws.onmessage = (frame) => {
      let message: GatewayMessage;
      try {
        message = JSON.parse(String(frame.data)) as GatewayMessage;
      } catch (err) {
        console.error('Gateway sent a frame that is not JSON', err);
        return;
      }
      this.handle(ws, message);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopKeepalive();
      if (!this.wanted) return;
      if (this.status === 'too_many_tabs') return; // its own slow retry is scheduled
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows and reconnects */ };
  }

  private handle(ws: WebSocket, message: GatewayMessage): void {
    switch (message.type) {
      case 'auth_ok': {
        const reconnected = this.everConnected;
        this.everConnected = true;
        this.connectionId = message.connectionId;
        this.backoffMs = 1_000;
        this.setStatus('connected');
        this.startKeepalive(ws);
        ws.send(JSON.stringify({ type: 'subscribe', patterns: ['*'] } satisfies ClientMessage));
        if (reconnected) {
          for (const [sessionId, afterEventId] of this.watched) {
            ws.send(JSON.stringify({ type: 'replay', sessionId, ...(afterEventId ? { afterEventId } : {}) } satisfies ClientMessage));
          }
        }
        break;
      }
      case 'auth_error':
        if (message.reason === TOO_MANY_CONNECTIONS) {
          this.setStatus('too_many_tabs');
          this.clearTimers();
          this.reconnectTimer = setTimeout(() => this.retry(), TOO_MANY_RETRY_MS);
        }
        // Any other refusal: the server closes the socket and onclose backs off.
        break;
      case 'event':
        if (!this.note(message.event)) return;
        break;
      case 'replay': {
        // Replayed events go out as ordinary events, minus the ones this tab saw.
        for (const event of message.events) {
          if (this.note(event)) this.emit({ type: 'event', event });
        }
        break;
      }
      default:
        break;
    }
    this.emit(message);
  }

  /** Remember an event; false when this tab already had it. */
  private note(event: GatewayEvent): boolean {
    if (this.seenIds.has(event.id)) return false;
    this.seenIds.add(event.id);
    if (this.seenIds.size > SEEN_IDS_MAX) this.seenIds.delete(this.seenIds.values().next().value!);
    if (event.sessionId && this.watched.has(event.sessionId)) this.watched.set(event.sessionId, event.id);
    return true;
  }

  private emit(message: GatewayMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (err) {
        console.error('Gateway message listener failed', err);
      }
    }
  }

  private setStatus(status: GatewayStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private scheduleReconnect(): void {
    this.setStatus('disconnected');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.5, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepalive();
  }
}

/** The tab's connection. */
export const gateway = new WebGateway();
