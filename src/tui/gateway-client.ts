import { readLocalToken, ensureLocalToken } from '@/core/gateway/local-auth';
import type { GatewayMessage, ClientMessage } from '@/core/gateway/protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'error';

export interface GatewayClientOptions {
  url?: string;
  onEvent?: (event: any) => void;
  onResponse?: (response: string) => void;
  onCommandResult?: (name: string, result: unknown, error?: string) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: string) => void;
}

/**
 * Gateway WebSocket client for the TUI.
 * Connects to ws://localhost:PORT/gateway with local-token auth.
 */
export class GatewayClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private options: GatewayClientOptions;
  private reconnectTimer: Timer | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  /**
   * Connect to the gateway.
   */
  async connect(): Promise<void> {
    const url = this.options.url || 'ws://localhost:3007/gateway';
    const token = readLocalToken() || ensureLocalToken();

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.setStatus('authenticating');
        this.send({
          type: 'auth',
          method: 'local',
          credentials: { token },
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
      this.ws.close(1000, 'TUI exit');
      this.ws = null;
    }
    this.setStatus('disconnected');
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
   * Respond to a permission request.
   */
  respondPermission(requestId: string, approved: boolean): void {
    this.send({ type: 'approval.respond', requestId, response: approved ? 'yes' : 'no', approved });
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
        this.options.onError?.(`Auth failed: ${msg.reason}`);
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
