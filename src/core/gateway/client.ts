import { clearCliSession, readCliSession } from '@/core/gateway/cli-session';
import { ensureLocalToken, readLocalToken } from '@/core/gateway/local-auth';
import type { ClientMessage, GatewayMessage } from '@/core/gateway/protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'error';

export interface GatewayClientOptions {
  url?: string;
  onEvent?: (event: any) => void;
  onResponse?: (response: string) => void;
  onCommandResult?: (name: string, result: unknown, error?: string) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: string) => void;
  /**
   * Who this client is now acting as — null for the local machine account.
   * Fires on every connect and when a rejected login is cleared, so a status
   * bar can't keep showing a signed-in user whose session is already gone.
   */
  onIdentityChange?: (identity: { username: string; userId: string } | null) => void;
  /**
   * Phase 4 workspace propagation. When set, the connect URL gets
   * a `?workspace=<slug-or-uuid>` query parameter that the backend
   * gateway feeds into `resolveWorkspace`. The resolver maps the
   * value to a workspace owned by the principal; cross-tenant /
   * unknown values collapse to the user's default. Re-evaluated
   * on every connect (including reconnects), so a runtime
   * workspace switch picks up after the next disconnect cycle.
   */
  getWorkspace?: () => string | null | undefined;
}

/**
 * Gateway WebSocket client for the TUI.
 * Connects to ws://localhost:PORT/gateway with local-token auth.
 */
export class GatewayClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private options: GatewayClientOptions;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  /** Who the last connect authenticated as, or null for the local sentinel. */
  private authenticatedAs: { username: string; userId: string } | null = null;
  private usedStoredSession = false;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  /**
   * Connect to the gateway.
   */
  async connect(): Promise<void> {
    const baseUrl = this.options.url || 'ws://localhost:3007/gateway';
    const ws = this.options.getWorkspace?.();
    const url = ws
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(ws)}`
      : baseUrl;
    // A stored login wins over the machine token: it makes this terminal the
    // same principal as the browser (own memories, own vault secrets, own
    // settings) instead of the account-less 'local' sentinel.
    const session = readCliSession();
    const auth = session
      ? { method: 'session_token' as const, credentials: { token: session.token } }
      : { method: 'local' as const, credentials: { token: readLocalToken() || ensureLocalToken() } };
    this.authenticatedAs = session ? { username: session.username, userId: session.userId } : null;
    this.usedStoredSession = session !== null;
    this.options.onIdentityChange?.(this.authenticatedAs);

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.setStatus('authenticating');
        this.send({
          type: 'auth',
          method: auth.method,
          credentials: auth.credentials,
          clientType: 'tui',
          clientVersion: '1.0.0',
        });
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = (event) => {
        const wasConnected = this.status === 'connected';
        this.setStatus('disconnected');
        if (wasConnected && event.code !== 1000) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.setStatus('error');
        this.options.onError?.('WebSocket connection error');
      };
    } catch (err) {
      this.setStatus('error');
      this.options.onError?.((err as Error).message);
    }
  }

  /**
   * Disconnect from the gateway.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Detach BEFORE closing. The old socket's `onclose` fires when the server
      // acks, which on a reconnect lands after the new socket is already up —
      // and it would stamp the live connection 'disconnected' with no retry
      // scheduled (code 1000). A stale `onmessage` would likewise still be
      // feeding this client.
      const stale = this.ws;
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      this.ws = null;
      stale.close(1000, 'TUI exit');
    }
    this.setStatus('disconnected');
  }

  /** The signed-in user, or null when running as the local sentinel. */
  getIdentity(): { username: string; userId: string } | null {
    return this.authenticatedAs;
  }

  /** Drop the connection and re-establish it, picking up a new stored login. */
  async reauthenticate(): Promise<void> {
    try { this.disconnect(); } catch { /* already down */ }
    await this.connect();
  }

  /**
   * Send a chat message.
   */
  sendChat(sessionId: string, content: string, expertId?: string, projectPath?: string): void {
    this.send({
      type: 'chat.send',
      sessionId,
      content,
      expertId,
      ...(projectPath ? { projectPath } : {}),
    });
  }

  /**
   * Send a command.
   */
  sendCommand(name: string, args?: Record<string, string>): void {
    this.send({ type: 'command', name, args });
  }

  /**
   * Respond to a permission request — the kind raised by the tool
   * executor's permission gate (ASK/DENY). Distinct from
   * `respondApproval`, which is for root agent-side "ask the user
   * a question" prompts (`agent.approval_required`).
   *
   * Bug fix: this used to send `approval.respond`, which is the
   * ROOT AGENT's approval channel, not the permission manager's.
   * The server silently dropped it because no waiter matched, and the
   * agent stayed blocked until the user re-approved through a
   * different surface (e.g. web UI sending the correct
   * `permission.respond`).
   */
  respondPermission(requestId: string, approved: boolean): void {
    this.send({ type: 'permission.respond', requestId, approved });
  }

  /**
   * Respond to a root agent approval request (multi-option
   * "user, please decide" prompts emitted via
   * `agent.approval_required`).
   */
  respondApproval(requestId: string, approved: boolean, response?: string): void {
    this.send({
      type: 'approval.respond',
      requestId,
      response: response ?? (approved ? 'yes' : 'no'),
      approved,
    });
  }

  /**
   * Subscribe to event patterns.
   */
  subscribe(patterns: string[]): void {
    this.send({ type: 'subscribe', patterns });
  }

  /**
   * Send a ping.
   */
  ping(): void {
    this.send({ type: 'ping' });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ── Internal ────────────────────────────────────────────────────

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(raw: string): void {
    let msg: GatewayMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'auth_ok':
        this.setStatus('connected');
        this.reconnectAttempts = 0;
        // Subscribe to all events
        this.subscribe(['*']);
        break;

      case 'auth_error':
        this.setStatus('error');
        if (this.usedStoredSession) {
          // The stored login is dead (expired, revoked, or the server was
          // reset). Drop it rather than reconnect-looping against it — the
          // next connect falls back to the local token, so the TUI still
          // works while the user re-runs /login.
          clearCliSession();
          this.authenticatedAs = null;
          this.usedStoredSession = false;
          this.options.onError?.(`Login expired (${msg.reason}). Signed out — use /login to sign in again.`);
          this.options.onIdentityChange?.(null);
          // Actually fall back. `onclose` only retries a connection that was
          // live, and this one never authenticated, so without this the TUI
          // sits disconnected until the user types a command — the session
          // expires overnight and the morning's first message goes nowhere.
          void this.connect();
        } else {
          this.options.onError?.(`Auth failed: ${msg.reason}`);
        }
        break;

      case 'event':
        if (msg.event.type === 'chat.response') {
          const payload = msg.event.payload as any;
          this.options.onResponse?.(payload.response?.response || payload.response || '');
        }
        this.options.onEvent?.(msg.event);
        break;

      case 'command.result':
        this.options.onCommandResult?.(msg.name, msg.result, msg.error);
        break;

      case 'pong':
        // Connection alive
        break;

      case 'error':
        this.options.onError?.(`${msg.code}: ${msg.message}`);
        break;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.options.onError?.('Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
