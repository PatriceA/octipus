/**
 * GatewayWSClient — thin promise-based wrapper around the native WebSocket
 * used by the gateway E2E tests.
 *
 * Features:
 * - Connects to the gateway, does the auth handshake (`session_token` if using
 *   a regular user token, `api_key` if using MASTER_KEY), waits for `auth_ok`.
 * - `send(message)` — send any ClientMessage-shaped payload.
 * - `waitFor(predicate, timeoutMs)` — resolve on the next inbound frame that
 *   matches the predicate. Inbound frames are buffered while nobody is
 *   listening so waitFor() doesn't race with fast events.
 * - `close()` — graceful close.
 *
 * Uses Bun's native WebSocket (global).
 */

import { fixtures } from './fixtures';

export type WsFrame = Record<string, unknown> & { type: string };

export interface GatewayWSClientOptions {
  url?: string;
  token?: string | null;
  /** Auth method — defaults to 'session_token' (the register/login token). */
  authMethod?: 'session_token' | 'api_key' | 'local';
  clientType?: 'webchat' | 'tui' | 'channel' | 'mobile' | 'acp' | 'agent';
  clientVersion?: string;
  /** Auth handshake timeout (ms) */
  authTimeoutMs?: number;
  /** Suppress auto-subscribe after auth_ok. Default: subscribes to '*'. */
  skipAutoSubscribe?: boolean;
}

export class GatewayWSClient {
  private ws: WebSocket | null = null;
  private buffer: WsFrame[] = [];
  private waiters: Array<{
    predicate: (frame: WsFrame) => boolean;
    resolve: (frame: WsFrame) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closed = false;
  private options: Required<Pick<GatewayWSClientOptions, 'url' | 'clientType' | 'clientVersion' | 'authTimeoutMs' | 'skipAutoSubscribe'>> & {
    token: string | null;
    authMethod: 'session_token' | 'api_key' | 'local';
  };

  connectionId: string | null = null;
  userId: string | null = null;

  constructor(options: GatewayWSClientOptions = {}) {
    const token = options.token !== undefined ? options.token : fixtures.authToken;
    const authMethod = options.authMethod ?? 'session_token';

    this.options = {
      url: options.url || fixtures.gatewayUrl,
      token,
      authMethod,
      clientType: options.clientType || 'webchat',
      clientVersion: options.clientVersion || '1.0.0',
      authTimeoutMs: options.authTimeoutMs ?? 5000,
      skipAutoSubscribe: options.skipAutoSubscribe ?? false,
    };
  }

  /**
   * Open the WS, authenticate, and resolve on auth_ok.
   * Rejects on auth_error or timeout.
   */
  async connect(): Promise<void> {
    if (!this.options.token) {
      throw new Error('GatewayWSClient: no auth token available');
    }

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const openTimer = setTimeout(() => {
        if (!opened) reject(new Error(`WS open timeout (${this.options.authTimeoutMs}ms) for ${this.options.url}`));
      }, this.options.authTimeoutMs);

      this.ws = new WebSocket(this.options.url);

      this.ws.onopen = () => {
        opened = true;
        clearTimeout(openTimer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(openTimer);
        if (!opened) reject(new Error(`WS connection error to ${this.options.url}`));
      };
      this.ws.onmessage = (event) => {
        this.handleIncoming(event.data as string);
      };
      this.ws.onclose = () => {
        this.closed = true;
        // Flush waiters with an error so pending waits don't hang
        for (const w of this.waiters) {
          clearTimeout(w.timer);
          w.reject(new Error('WS closed while waiting'));
        }
        this.waiters = [];
      };
    });

    // Send auth based on method
    const credentials: Record<string, unknown> =
      this.options.authMethod === 'api_key'
        ? { key: this.options.token }
        : this.options.authMethod === 'local'
          ? { token: this.options.token }
          : { token: this.options.token };

    this.sendRaw({
      type: 'auth',
      method: this.options.authMethod,
      credentials,
      clientType: this.options.clientType,
      clientVersion: this.options.clientVersion,
    });

    // Wait for auth_ok or auth_error
    const ack = await this.waitFor(
      (f) => f.type === 'auth_ok' || f.type === 'auth_error',
      this.options.authTimeoutMs,
    );
    if (ack.type === 'auth_error') {
      throw new Error(`Gateway auth failed: ${(ack as any).reason}`);
    }
    this.connectionId = (ack as any).connectionId as string;
    this.userId = (ack as any).userId as string;

    // By default, subscribe to all events (matches TUI behavior).
    if (!this.options.skipAutoSubscribe) {
      this.sendRaw({ type: 'subscribe', patterns: ['*'] });
    }
  }

  /**
   * Send a raw message object to the gateway.
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WS is not open');
    }
    this.sendRaw(message);
  }

  private sendRaw(message: Record<string, unknown>): void {
    this.ws!.send(JSON.stringify(message));
  }

  /**
   * Wait for the next frame matching the predicate.
   * Checks the buffer first (for frames that arrived before this call).
   */
  waitFor(predicate: (frame: WsFrame) => boolean, timeoutMs = 15_000): Promise<WsFrame> {
    // Check buffered frames first
    for (let i = 0; i < this.buffer.length; i++) {
      if (predicate(this.buffer[i])) {
        return Promise.resolve(this.buffer.splice(i, 1)[0]);
      }
    }
    return new Promise<WsFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Helper — wait for a gateway `event` frame whose nested event.type matches.
   * The gateway wraps events in { type: 'event', event: {...} }.
   */
  waitForEvent(eventType: string, timeoutMs = 30_000, extra?: (payload: any) => boolean): Promise<WsFrame> {
    return this.waitFor(
      (f) => f.type === 'event'
        && (f as any).event?.type === eventType
        && (!extra || extra((f as any).event?.payload)),
      timeoutMs,
    );
  }

  /**
   * Helper — wait for a `command.result` frame (optionally matching a command name).
   */
  waitForCommandResult(name?: string, timeoutMs = 15_000): Promise<WsFrame> {
    return this.waitFor(
      (f) => f.type === 'command.result' && (name ? (f as any).name === name : true),
      timeoutMs,
    );
  }

  /**
   * Close the WS cleanly.
   */
  close(code = 1000, reason = 'test done'): void {
    if (this.ws && !this.closed) {
      try { this.ws.close(code, reason); } catch { /* ignore */ }
    }
    this.closed = true;
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed;
  }

  // ── Internal ────────────────────────────────────────────────────

  private handleIncoming(raw: string): void {
    let frame: WsFrame;
    try {
      frame = JSON.parse(raw) as WsFrame;
    } catch {
      return;
    }

    // Try to match the oldest waiter whose predicate fires.
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].predicate(frame)) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(frame);
        return;
      }
    }
    // No waiter — buffer it.
    this.buffer.push(frame);
  }
}

/**
 * Convenience: wait a few milliseconds (used for sequencing WS sends).
 */
export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
