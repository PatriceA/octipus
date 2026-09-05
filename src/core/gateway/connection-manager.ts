
import { randomBytes } from 'crypto';
import { coreLogger } from '@/utils/logger';
import { validateLocalAuth } from './local-auth';
import {
  type AuthMessage,
  type ConnectionContext,
  type ConnectionState,
  type GatewayMessage,
  parseClientMessage,
  type TrustLevel,
} from './protocol';
import { GatewayRateLimiter } from './rate-limiter';

// ── Types ─────────────────────────────────────────────────────────

/**
 * The subset of a websocket this manager touches. Declared here rather than
 * imported from a runtime package: the manager only ever sends, closes and
 * reads `readyState`, and the connection objects come from the HTTP layer.
 */
export interface ServerWebSocket<T = unknown> {
  data: T;
  readonly readyState: number;
  send(payload: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface GatewayConnection {
  ws: ServerWebSocket<any>;
  state: ConnectionState;
  context: ConnectionContext | null;
  authTimer: NodeJS.Timeout | null;
  createdAt: number;
}

interface ConnectionBudget {
  maxPerUser: number;
  maxPerIp: number;
  maxPreAuth: number;
}

const DEFAULT_BUDGET: ConnectionBudget = {
  maxPerUser: 10,
  maxPerIp: 50,
  maxPreAuth: 20,
};

const AUTH_TIMEOUT_MS = 5_000;

// ── Connection Manager ────────────────────────────────────────────

export class ConnectionManager {
  private connections: Map<string, GatewayConnection> = new Map();
  private byUser: Map<string, Set<string>> = new Map();
  private byIp: Map<string, Set<string>> = new Map();
  private preAuthByIp: Map<string, number> = new Map();
  private rateLimiter: GatewayRateLimiter;
  private budget: ConnectionBudget;

  // External auth handler — set by the gateway server
  private sessionValidator: ((token: string) => Promise<{ userId: string; username: string; isAdmin: boolean } | null>) | null = null;
  private hmacValidator: ((key: string, channelType: string) => Promise<boolean>) | null = null;

  // Event callback for audit logging
  onAuditEvent?: (event: string, data: Record<string, unknown>) => void;

  constructor(options?: { budget?: Partial<ConnectionBudget>; rateLimiter?: GatewayRateLimiter }) {
    this.budget = { ...DEFAULT_BUDGET, ...options?.budget };
    this.rateLimiter = options?.rateLimiter || new GatewayRateLimiter();
  }

  setSessionValidator(validator: (token: string) => Promise<{ userId: string; username: string; isAdmin: boolean } | null>): void {
    this.sessionValidator = validator;
  }

  setHmacValidator(validator: (key: string, channelType: string) => Promise<boolean>): void {
    this.hmacValidator = validator;
  }

  getRateLimiter(): GatewayRateLimiter {
    return this.rateLimiter;
  }

  // ── Connection Lifecycle ──────────────────────────────────────

  /**
   * Register a new WebSocket connection (pre-auth).
   */
  handleOpen(ws: ServerWebSocket<any>, ip: string): string | null {
    // Check pre-auth budget per IP
    const preAuthCount = this.preAuthByIp.get(ip) || 0;
    if (preAuthCount >= this.budget.maxPreAuth) {
      coreLogger.warn({ ip, preAuthCount }, 'Pre-auth connection budget exceeded');
      this.onAuditEvent?.('gateway.connection.rejected', { ip, reason: 'pre_auth_budget' });
      return null;
    }

    // Check per-IP budget
    const ipConns = this.byIp.get(ip);
    if (ipConns && ipConns.size >= this.budget.maxPerIp) {
      coreLogger.warn({ ip, count: ipConns.size }, 'Per-IP connection budget exceeded');
      this.onAuditEvent?.('gateway.connection.rejected', { ip, reason: 'ip_budget' });
      return null;
    }

    const connectionId = randomBytes(16).toString('hex');
    const conn: GatewayConnection = {
      ws,
      state: 'authenticating',
      context: null,
      createdAt: Date.now(),
      authTimer: setTimeout(() => {
        this.handleAuthTimeout(connectionId);
      }, AUTH_TIMEOUT_MS),
    };

    this.connections.set(connectionId, conn);
    this.preAuthByIp.set(ip, preAuthCount + 1);

    // Track by IP
    if (!this.byIp.has(ip)) this.byIp.set(ip, new Set());
    this.byIp.get(ip)!.add(connectionId);

    return connectionId;
  }

  /**
   * Handle an incoming message from a connection.
   */
  async handleMessage(connectionId: string, raw: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // Pre-auth: only accept auth messages
    if (conn.state === 'authenticating') {
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        this.send(conn, { type: 'error', code: 'INVALID_MESSAGE', message: parsed.error });
        return;
      }
      if (parsed.message.type !== 'auth') {
        this.send(conn, { type: 'error', code: 'AUTH_REQUIRED', message: 'First message must be auth' });
        return;
      }
      await this.handleAuth(connectionId, conn, parsed.message);
      return;
    }

    // Post-auth: validate and route
    if (conn.state !== 'active' || !conn.context) return;

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(conn, { type: 'error', code: 'INVALID_MESSAGE', message: parsed.error });
      return;
    }

    // Rate limit check
    const rateCheck = this.rateLimiter.check(connectionId, parsed.message.type, conn.context.trustLevel);
    if (!rateCheck.allowed) {
      this.send(conn, {
        type: 'error',
        code: 'RATE_LIMITED',
        message: `Rate limited. Retry after ${Math.ceil((rateCheck.retryAfterMs || 0) / 1000)}s`,
      });
      this.onAuditEvent?.('gateway.rate_limit.hit', {
        userId: conn.context.userId,
        action: parsed.message.type,
        connectionId,
      });
      return;
    }

    // Update activity
    conn.context.lastActivityAt = Date.now();

    // Route to handler (implemented by gateway server)
    this.onMessage?.(connectionId, conn.context, parsed.message);
  }

  // Message handler callback — set by the gateway server
  onMessage?: (connectionId: string, context: ConnectionContext, message: any) => void;

  /**
   * Handle connection close.
   */
  handleClose(connectionId: string, code?: number, reason?: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // Clear auth timer
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }

    // Clean up tracking
    if (conn.context) {
      const userId = conn.context.userId;
      this.byUser.get(userId)?.delete(connectionId);
      if (this.byUser.get(userId)?.size === 0) this.byUser.delete(userId);

      this.onAuditEvent?.('gateway.connection.close', {
        userId,
        connectionId,
        clientType: conn.context.clientType,
        duration: Date.now() - conn.context.connectedAt,
        reason: reason || `code:${code}`,
      });
    }

    // Clean up IP tracking
    const ip = conn.context?.ip;
    if (ip) {
      this.byIp.get(ip)?.delete(connectionId);
      if (this.byIp.get(ip)?.size === 0) this.byIp.delete(ip);

      // Decrement pre-auth count if was still pre-auth
      if (!conn.context) {
        const count = this.preAuthByIp.get(ip) || 0;
        if (count > 0) this.preAuthByIp.set(ip, count - 1);
      }
    }

    this.rateLimiter.removeConnection(connectionId);
    this.connections.delete(connectionId);
  }

  // ── Auth ────────────────────────────────────────────────────────

  private async handleAuth(connectionId: string, conn: GatewayConnection, msg: AuthMessage): Promise<void> {
    const ip = this.getConnectionIp(connectionId);
    let userId: string | undefined;
    let trustLevel: TrustLevel = 'user';
    let isAdmin = false;

    try {
      switch (msg.method) {
        case 'session_token': {
          if (!this.sessionValidator) {
            this.sendAuthError(conn, 'Session auth not configured');
            return;
          }
          const token = msg.credentials.token as string;
          if (!token) {
            this.sendAuthError(conn, 'Missing token');
            return;
          }
          const session = await this.sessionValidator(token);
          if (!session) {
            this.sendAuthError(conn, 'Invalid or expired session');
            return;
          }
          userId = session.userId;
          isAdmin = session.isAdmin;
          // An admin signing in ON THIS MACHINE keeps the reach the machine
          // token already gave them — otherwise logging in to the TUI would be
          // a downgrade: no /reload, for the same person at the same keyboard.
          // The loopback test is not decoration: `local` also means "may see
          // every user's events" (hub.ts), and unlike the `local` method below
          // — which `validateLocalAuth` refuses off-loopback — a session token
          // travels, so a remote admin console would silently start receiving
          // other users' replies and permission prompts.
          const { isLoopbackIp } = await import('./local-auth');
          trustLevel = session.isAdmin && isLoopbackIp(ip) ? 'local' : 'user';
          break;
        }

        case 'local': {
          const token = msg.credentials.token as string;
          if (!token) {
            this.sendAuthError(conn, 'Missing local token');
            return;
          }
          const result = validateLocalAuth(token, ip);
          if (!result.valid) {
            this.sendAuthError(conn, result.reason || 'Local auth failed');
            return;
          }
          // Local auth gets a synthetic "local" user ID
          userId = 'local';
          trustLevel = 'local';
          isAdmin = true;
          break;
        }

        case 'hmac': {
          if (!this.hmacValidator) {
            this.sendAuthError(conn, 'HMAC auth not configured');
            return;
          }
          const key = msg.credentials.key as string;
          const channelType = msg.credentials.channelType as string;
          if (!key || !channelType) {
            this.sendAuthError(conn, 'Missing HMAC key or channel type');
            return;
          }
          const valid = await this.hmacValidator(key, channelType);
          if (!valid) {
            this.sendAuthError(conn, 'Invalid HMAC credentials');
            return;
          }
          userId = `adapter:${channelType}`;
          trustLevel = 'system';
          break;
        }

        case 'api_key': {
          // API key auth — accepts a personal API token (`octi_…`) issued via
          // Settings → API Tokens, checked against the api_tokens table. The
          // browser extension and any third-party WS client use such a token.
          // (The legacy MASTER_KEY fallback was removed with single-user mode.)
          const key = msg.credentials.key as string;
          if (!key) {
            this.sendAuthError(conn, 'Missing API key');
            return;
          }
          const { getApiTokenManager, looksLikeApiToken } = await import('@/security/api-tokens');
          const { getDb } = await import('@/db');
          const { users } = await import('@/db/schema/users');
          const { eq } = await import('drizzle-orm');
          if (looksLikeApiToken(key)) {
            const validated = await getApiTokenManager().validate(key);
            if (validated) {
              const [u] = await getDb()
                .select({ id: users.id, isAdmin: users.isAdmin })
                .from(users)
                .where(eq(users.id, validated.userId))
                .limit(1);
              if (u) {
                userId = u.id;
                trustLevel = u.isAdmin ? 'system' : 'user';
                isAdmin = u.isAdmin;
                break;
              }
            }
            this.sendAuthError(conn, 'Invalid API key');
            return;
          }
          // Not a valid API token — reject. (The legacy MASTER_KEY fallback
          // was removed with single-user mode; automation uses an API token.)
          this.sendAuthError(conn, 'Invalid API key');
          return;
        }

        default:
          this.sendAuthError(conn, `Unknown auth method: ${msg.method}`);
          return;
      }

      if (!userId) {
        this.sendAuthError(conn, 'Auth failed');
        return;
      }

      // Check per-user budget
      const userConns = this.byUser.get(userId);
      if (userConns && userConns.size >= this.budget.maxPerUser) {
        this.sendAuthError(conn, 'Too many connections');
        this.onAuditEvent?.('gateway.connection.rejected', { userId, reason: 'user_budget' });
        return;
      }

      // Auth success — clear timer, upgrade connection
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }

      // Decrement pre-auth counter
      const preAuth = this.preAuthByIp.get(ip) || 0;
      if (preAuth > 0) this.preAuthByIp.set(ip, preAuth - 1);

      conn.state = 'active';
      conn.context = {
        connectionId,
        userId,
        clientType: msg.clientType as any,
        trustLevel,
        ip,
        connectedAt: Date.now(),
        lastActivityAt: Date.now(),
        eventSubscriptions: new Set(['*']), // Default: receive all events
        metadata: { isAdmin, clientVersion: msg.clientVersion },
      };

      // Track by user
      if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
      this.byUser.get(userId)!.add(connectionId);

      // Send auth_ok
      this.send(conn, {
        type: 'auth_ok',
        connectionId,
        userId,
        capabilities: this.getCapabilities(trustLevel, isAdmin),
        serverTime: new Date().toISOString(),
        serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      this.onAuditEvent?.('gateway.auth.success', {
        userId,
        connectionId,
        method: msg.method,
        clientType: msg.clientType,
        ip,
        trustLevel,
      });

      coreLogger.info({ connectionId, userId, clientType: msg.clientType, trustLevel }, 'Gateway connection authenticated');
    } catch (err) {
      coreLogger.error({ err, connectionId }, 'Auth error');
      this.sendAuthError(conn, 'Internal auth error');
    }
  }

  private handleAuthTimeout(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.state !== 'authenticating') return;

    coreLogger.debug({ connectionId }, 'Auth timeout — closing connection');
    this.send(conn, { type: 'auth_error', reason: 'Authentication timeout (5s)' });

    try {
      conn.ws.close(4001, 'Auth timeout');
    } catch (err) { coreLogger.error({ err }, 'silent failure in connection-manager'); }

    this.handleClose(connectionId, 4001, 'Auth timeout');
  }

  private sendAuthError(conn: GatewayConnection, reason: string): void {
    this.send(conn, { type: 'auth_error', reason });
    const ip = conn.context?.ip || 'unknown';
    this.onAuditEvent?.('gateway.auth.failure', { ip, reason });

    try {
      conn.ws.close(4001, reason);
    } catch (err) { coreLogger.error({ err }, 'silent failure in connection-manager'); }
  }

  // ── Queries ─────────────────────────────────────────────────────

  getConnection(connectionId: string): GatewayConnection | undefined {
    return this.connections.get(connectionId);
  }

  getConnectionsByUser(userId: string): GatewayConnection[] {
    const ids = this.byUser.get(userId);
    if (!ids) return [];
    return [...ids].map(id => this.connections.get(id)).filter(Boolean) as GatewayConnection[];
  }

  getActiveConnections(): ConnectionContext[] {
    return [...this.connections.values()]
      .filter(c => c.state === 'active' && c.context)
      .map(c => c.context!);
  }

  getConnectionCount(): { total: number; authenticated: number; preAuth: number } {
    let authenticated = 0;
    let preAuth = 0;
    for (const conn of this.connections.values()) {
      if (conn.state === 'active') authenticated++;
      else preAuth++;
    }
    return { total: this.connections.size, authenticated, preAuth };
  }

  // ── Send Helpers ────────────────────────────────────────────────

  send(conn: GatewayConnection, msg: GatewayMessage): void {
    try {
      if (conn.ws.readyState === 1) { // OPEN
        conn.ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      coreLogger.debug({ err, connectionId: conn.context?.connectionId }, 'Failed to send to connection');
    }
  }

  sendToConnection(connectionId: string, msg: GatewayMessage): void {
    const conn = this.connections.get(connectionId);
    if (conn) this.send(conn, msg);
  }

  sendToUser(userId: string, msg: GatewayMessage): void {
    for (const conn of this.getConnectionsByUser(userId)) {
      this.send(conn, msg);
    }
  }

  broadcast(msg: GatewayMessage, filter?: (ctx: ConnectionContext) => boolean): void {
    for (const conn of this.connections.values()) {
      if (conn.state !== 'active' || !conn.context) continue;
      if (filter && !filter(conn.context)) continue;
      this.send(conn, msg);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private getConnectionIp(connectionId: string): string {
    // Scan byIp to find which IP owns this connection
    for (const [ip, ids] of this.byIp) {
      if (ids.has(connectionId)) return ip;
    }
    return 'unknown';
  }

  private getCapabilities(trustLevel: TrustLevel, isAdmin: boolean): string[] {
    const caps = ['chat', 'subscribe', 'commands', 'ping'];
    if (trustLevel === 'local' || trustLevel === 'system' || isAdmin) {
      caps.push('admin', 'agent.stop');
    }
    if (trustLevel === 'system') {
      caps.push('channel.send', 'channel.status');
    }
    return caps;
  }

  /**
   * Graceful shutdown — drain all connections.
   */
  async drain(): Promise<void> {
    coreLogger.info({ connections: this.connections.size }, 'Draining gateway connections');
    for (const [_id, conn] of this.connections) {
      conn.state = 'draining';
      this.send(conn, { type: 'error', code: 'SERVER_SHUTDOWN', message: 'Server shutting down' });
      try {
        conn.ws.close(1001, 'Server shutdown');
      } catch (err) { coreLogger.error({ err }, 'silent failure in connection-manager'); }
    }
    this.connections.clear();
    this.byUser.clear();
    this.byIp.clear();
    this.preAuthByIp.clear();
    this.rateLimiter.destroy();
  }
}
