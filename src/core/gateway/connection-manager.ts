
import { randomBytes } from 'crypto';
import { userChangedSince, userChangeMark } from '@/security/user-change-marks';
import { coreLogger } from '@/utils/logger';
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
  /** Client address from `clientIp` (security/client-ip.ts), fixed at open. */
  ip: string;
  state: ConnectionState;
  context: ConnectionContext | null;
  authTimer: NodeJS.Timeout | null;
  /** `artifact_token` viewers only: closes the connection when the token expires. */
  expiryTimer?: NodeJS.Timeout;
  createdAt: number;
  /** The socket URL's `?workspace=` (id or slug), resolved for the user at auth. */
  workspaceHint?: string;
  /**
   * The key of the connection's rate buckets when it is not its own id: a
   * virtual peer connection shares its visitor's buckets on the link
   * (`registerVirtual`), so opening another `conn` buys no fresh budget.
   */
  rateKey?: string;
}

/**
 * Resolves the workspace a connection works in for its user: the `hint`
 * (a workspace id or slug the user owns) or, without one, the user's
 * default. Returns null when the hint names no workspace of the user's.
 */
export type ConnectionWorkspaceResolver = (userId: string, hint: string | undefined) => Promise<string | null>;

/**
 * There is no cap per address on authenticated connections: behind a reverse
 * proxy every client shares one address, and such a cap would become an
 * install-wide one. An address is capped only while it holds connections that
 * have not authenticated yet; once signed in, the per-user cap applies.
 */
interface ConnectionBudget {
  /**
   * Authenticated connections per user (`gateway.maxConnectionsPerUser`). A
   * function so a settings change applies to the next sign-in.
   */
  maxPerUser: number | (() => number);
  maxPreAuth: number;
}

const DEFAULT_BUDGET: ConnectionBudget = {
  maxPerUser: 20,
  maxPreAuth: 20,
};

const AUTH_TIMEOUT_MS = 5_000;
/**
 * Live `artifact_token` viewers of one artifact. They are not a user, so the
 * per-user cap does not apply; this bounds what one embed token (or a page
 * opened in many tabs) can hold open.
 */
export const MAX_VIEWERS_PER_ARTIFACT = 50;
/** Same as user-lifecycle's USER_CHANGED_CLOSE_CODE: reconnect to pick up the new rights. */
const USER_CHANGED_CLOSE_CODE = 4004;

// ── Connection Manager ────────────────────────────────────────────

export class ConnectionManager {
  private connections: Map<string, GatewayConnection> = new Map();
  private byUser: Map<string, Set<string>> = new Map();
  private preAuthByIp: Map<string, number> = new Map();
  private rateLimiter: GatewayRateLimiter;
  private budget: ConnectionBudget;

  // External auth handler — set by the gateway server
  private sessionValidator: ((token: string) => Promise<{ userId: string; username: string; isAdmin: boolean } | null>) | null = null;
  private workspaceResolver: ConnectionWorkspaceResolver | null = null;

  // Event callback for audit logging
  onAuditEvent?: (event: string, data: Record<string, unknown>) => void;

  /** Called once for every authenticated connection that ends, with its context. */
  onConnectionClosed?: (context: ConnectionContext) => void;

  /**
   * Told to clients in `auth_ok` (`gateway.maxFrameBytes`), so they can refuse
   * a frame the server would. The socket's own limit is fixed when it is set
   * up, so this is the number it was set up with (`setMaxFrameBytes`), never
   * a later config value the socket does not enforce.
   */
  private maxFrameBytes?: number;

  constructor(options?: { budget?: Partial<ConnectionBudget>; rateLimiter?: GatewayRateLimiter }) {
    this.budget = { ...DEFAULT_BUDGET, ...options?.budget };
    this.rateLimiter = options?.rateLimiter || new GatewayRateLimiter();
  }

  /** The frame cap the socket enforces (its `maxPayload`). */
  setMaxFrameBytes(bytes: number): void {
    this.maxFrameBytes = bytes;
  }

  private maxPerUser(): number {
    const max = this.budget.maxPerUser;
    return typeof max === 'function' ? max() : max;
  }

  setSessionValidator(validator: (token: string) => Promise<{ userId: string; username: string; isAdmin: boolean } | null>): void {
    this.sessionValidator = validator;
  }

  setWorkspaceResolver(resolver: ConnectionWorkspaceResolver): void {
    this.workspaceResolver = resolver;
  }

  getRateLimiter(): GatewayRateLimiter {
    return this.rateLimiter;
  }

  // ── Connection Lifecycle ──────────────────────────────────────

  /**
   * Register a new WebSocket connection (pre-auth). `ip` must come from
   * `clientIp`, never from a forwarded header read directly. `workspace` is
   * the socket URL's `?workspace=`, resolved once the user is known.
   */
  handleOpen(ws: ServerWebSocket<any>, ip: string, workspace?: string): string | null {
    // The only per-address cap: connections that have not authenticated yet.
    const preAuthCount = this.preAuthByIp.get(ip) || 0;
    if (preAuthCount >= this.budget.maxPreAuth) {
      coreLogger.warn({ ip, preAuthCount }, 'Pre-auth connection budget exceeded');
      this.onAuditEvent?.('gateway.connection.rejected', { ip, reason: 'pre_auth_budget' });
      return null;
    }

    const connectionId = randomBytes(16).toString('hex');
    const conn: GatewayConnection = {
      ws,
      ip,
      state: 'authenticating',
      context: null,
      createdAt: Date.now(),
      authTimer: setTimeout(() => {
        this.handleAuthTimeout(connectionId);
      }, AUTH_TIMEOUT_MS),
      ...(workspace ? { workspaceHint: workspace } : {}),
    };

    this.connections.set(connectionId, conn);
    this.preAuthByIp.set(ip, preAuthCount + 1);

    return connectionId;
  }

  /**
   * Register a virtual connection: a member of another install, carried on
   * its install's peer link (docs/plans/federation-spec.md §7.2). It is an
   * ordinary authenticated connection from here on — in `connections` and
   * `byUser`, so `getConnectionsByUser`, `closeUserConnections`,
   * `publishEvent`, `publishToResource` and the room and document pruning
   * all reach it, and its frames go through `handleMessage` (zod and the
   * per-connection rate buckets) — except that it has no socket: what the
   * manager sends it goes to `sink` (sealed onto the link by the caller),
   * and closing it calls `onClose` once. It never counts against
   * `gateway.maxConnectionsPerUser`; the federation layer bounds it.
   *
   * Its rate buckets are keyed by `rateKey` (the visitor on its link), not
   * by the connection: every virtual connection of one visitor draws on
   * the same buckets, which outlive any one of them. Its event
   * subscriptions are `eventPatterns` only — the visitor's own events the
   * federation layer lets out — never `*`.
   */
  registerVirtual(input: {
    userId: string;
    instanceId: string;
    /** The visitor install's client connection this one stands for. */
    conn: string;
    /** The key of the rate buckets this connection shares with the visitor's others. */
    rateKey: string;
    /** The visitor's own event types (`publishEvent`) this connection receives. */
    eventPatterns: readonly string[];
    sink: (message: GatewayMessage) => void;
    onClose: () => void;
  }): string {
    const connectionId = randomBytes(16).toString('hex');
    let closed = false;
    const ws: ServerWebSocket<Record<string, unknown>> = {
      data: {},
      readyState: 1,
      send: (payload) => {
        if (closed) return;
        const text = typeof payload === 'string' ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
        input.sink(JSON.parse(text) as GatewayMessage);
      },
      close: () => {
        if (closed) return;
        closed = true;
        input.onClose();
      },
    };
    const now = Date.now();
    const conn: GatewayConnection = {
      ws,
      ip: `peer:${input.instanceId}`,
      state: 'active',
      authTimer: null,
      createdAt: now,
      rateKey: input.rateKey,
      context: {
        connectionId,
        userId: input.userId,
        clientType: 'peer',
        trustLevel: 'user',
        ip: `peer:${input.instanceId}`,
        connectedAt: now,
        lastActivityAt: now,
        // The member's own events the federation layer lets out (a
        // requester error from a room turn, a mention): `publishEvent`
        // delivers by user id. Never `*`: a host turn's progress events
        // carry raw tool arguments and results.
        eventSubscriptions: new Set(input.eventPatterns),
        resources: new Set(),
        metadata: { isAdmin: false, federation: { instanceId: input.instanceId, conn: input.conn } },
      },
    };
    this.connections.set(connectionId, conn);
    if (!this.byUser.has(input.userId)) this.byUser.set(input.userId, new Set());
    this.byUser.get(input.userId)!.add(connectionId);
    coreLogger.info({ connectionId, userId: input.userId, instanceId: input.instanceId }, 'Virtual peer connection registered');
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
    const rateCheck = this.rateLimiter.check(conn.rateKey ?? connectionId, parsed.message.type, conn.context.trustLevel);
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
    if (conn.expiryTimer) clearTimeout(conn.expiryTimer);

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
      try {
        this.onConnectionClosed?.(conn.context);
      } catch (err) {
        coreLogger.error({ err, connectionId, userId }, 'Gateway connection close handler failed');
      }
    }

    // A connection that never authenticated still holds its pre-auth slot.
    if (conn.state === 'authenticating') this.releasePreAuth(conn.ip);

    // A shared key (a visitor's buckets on its link) outlives the connection;
    // its windows age out in the limiter's own sweep.
    if (!conn.rateKey) this.rateLimiter.removeConnection(connectionId);
    this.connections.delete(connectionId);
  }

  // ── Auth ────────────────────────────────────────────────────────

  private async handleAuth(connectionId: string, conn: GatewayConnection, msg: AuthMessage): Promise<void> {
    const ip = conn.ip;
    let userId: string | undefined;
    // Every authenticated connection is `user` trust: trust never widens what
    // a connection may see or touch. Admin rights come from the database
    // (`isAdmin` below, re-read where a command needs it), not from where the
    // connection comes from or which credential it used.
    const trustLevel: TrustLevel = 'user';
    let isAdmin = false;
    let scopes: readonly string[] | undefined;
    let artifactId: string | undefined;
    let artifactTokenExp: number | undefined;
    // Taken before the credential is checked: see the re-check after
    // registration below.
    const mark = userChangeMark();

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
          // The validator reads `is_admin` from the users row at auth time.
          isAdmin = session.isAdmin;
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
                isAdmin = u.isAdmin;
                // The token's scopes travel with the connection, as on REST.
                scopes = validated.scopes;
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

        case 'artifact_token': {
          // The live-artifact SDK inside an embed page. The token is the one
          // minted for that page (artifact-pages.ts); the connection is a
          // viewer of that one artifact, not a user — the hub lets it ping
          // and subscribe to `artifact:<id>` only.
          const aid = msg.credentials.artifactId;
          const token = msg.credentials.token;
          if (typeof aid !== 'string' || !aid || typeof token !== 'string' || !token) {
            this.sendAuthError(conn, 'Missing artifact id or token');
            return;
          }
          const { verifyArtifactToken } = await import('@/core/artifacts/token');
          const payload = verifyArtifactToken(token, { aid });
          const { isArtifactTokenRevoked } = await import('@/core/artifacts/viewer-access');
          // A token issued before the artifact's visibility changed (or before
          // it was deleted) no longer stands for the access it was minted under.
          if (!payload || isArtifactTokenRevoked(aid, payload.iat)) {
            this.sendAuthError(conn, 'Invalid or expired artifact token');
            return;
          }
          const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
          const artifact = await artifactsRepository.getById(aid);
          if (!artifact || artifact.workspaceId !== payload.wid) {
            this.sendAuthError(conn, 'Artifact not found');
            return;
          }
          artifactId = aid;
          artifactTokenExp = payload.exp;
          userId = `artifact:${aid}`;
          break;
        }

        default:
          this.sendAuthError(conn, `Unknown auth method: ${msg.method}`);
          return;
      }

      if (!userId) {
        this.sendAuthError(conn, 'Auth failed');
        return;
      }

      // Check per-user budget. Artifact viewers share one id per artifact and
      // are not a user: they have a cap per artifact instead.
      const userConns = this.byUser.get(userId);
      const cap = artifactId === undefined ? this.maxPerUser() : MAX_VIEWERS_PER_ARTIFACT;
      if (userConns && userConns.size >= cap) {
        this.sendAuthError(conn, 'Too many connections');
        this.onAuditEvent?.('gateway.connection.rejected', { userId, reason: artifactId === undefined ? 'user_budget' : 'artifact_viewer_budget' });
        return;
      }

      // The workspace this connection works in (user connections only; an
      // artifact viewer is not a user). A `?workspace=` that names none of
      // the user's workspaces fails the sign-in rather than quietly
      // switching the client to another workspace.
      let workspaceId: string | undefined;
      if (artifactId === undefined) {
        if (!this.workspaceResolver) {
          this.sendAuthError(conn, 'Workspace resolution not configured');
          return;
        }
        const resolved = await this.workspaceResolver(userId, conn.workspaceHint);
        if (!resolved) {
          this.sendAuthError(conn, 'Unknown workspace');
          return;
        }
        workspaceId = resolved;
      }

      // Auth success — clear timer, upgrade connection
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }

      this.releasePreAuth(ip);

      conn.state = 'active';
      conn.context = {
        connectionId,
        userId,
        clientType: msg.clientType as any,
        trustLevel,
        ip,
        connectedAt: Date.now(),
        lastActivityAt: Date.now(),
        eventSubscriptions: new Set(['*']), // Default: all of this user's own events
        resources: new Set(),
        ...(artifactId !== undefined ? { artifactId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(scopes && scopes.length > 0 ? { scopes } : {}),
        metadata: { isAdmin, clientVersion: msg.clientVersion },
      };

      // Track by user
      if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
      this.byUser.get(userId)!.add(connectionId);

      // The user was deactivated or their admin flag changed while this
      // connection was authenticating: the sweep (closeUserConnections) may
      // have run before it was registered. Close it; the client reconnects
      // against the current row.
      if (userChangedSince(userId, mark)) {
        this.closeUserConnection(connectionId, USER_CHANGED_CLOSE_CODE, 'Account changed');
        return;
      }

      // The token was checked once, above; the connection ends when it expires.
      if (artifactTokenExp !== undefined) {
        conn.expiryTimer = setTimeout(() => {
          this.closeUserConnection(connectionId, 4001, 'Artifact token expired');
        }, Math.max(0, artifactTokenExp * 1000 - Date.now()));
      }

      // Send auth_ok
      this.send(conn, {
        type: 'auth_ok',
        connectionId,
        userId,
        capabilities: artifactId !== undefined ? ['subscribe', 'ping'] : this.getCapabilities(isAdmin),
        serverTime: new Date().toISOString(),
        serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(this.maxFrameBytes !== undefined ? { maxFrameBytes: this.maxFrameBytes } : {}),
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
    this.onAuditEvent?.('gateway.auth.failure', { ip: conn.ip, reason });

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

  /**
   * Close every connection of `userId`. A connection's identity, trust and
   * admin rights are fixed at auth, so a deactivation or an admin change ends
   * them; the client reconnects and authenticates afresh (or is refused).
   * Returns how many were closed.
   */
  closeUserConnections(userId: string, code: number, reason: string): number {
    const conns = [...(this.byUser.get(userId) ?? [])];
    for (const connectionId of conns) this.closeUserConnection(connectionId, code, reason);
    if (conns.length > 0) coreLogger.info({ userId, count: conns.length, reason }, 'Closed user gateway connections');
    return conns.length;
  }

  /**
   * Close every `artifact_token` viewer of `artifactId` (the artifact was
   * deleted or its visibility changed). Returns how many were closed.
   */
  closeArtifactViewers(artifactId: string, code: number, reason: string): number {
    return this.closeUserConnections(`artifact:${artifactId}`, code, reason);
  }

  /** Close one connection (a virtual peer connection the federation layer drops). */
  closeConnection(connectionId: string, code: number, reason: string): void {
    this.closeUserConnection(connectionId, code, reason);
  }

  /** Close one authenticated connection and drop its bookkeeping at once. */
  private closeUserConnection(connectionId: string, code: number, reason: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.state = 'draining';
    try {
      conn.ws.close(code, reason);
    } catch (err) {
      coreLogger.warn({ err, connectionId, userId: conn.context?.userId }, 'Could not close a gateway connection');
    }
    // The transport's close callback lands later (or never, for a socket
    // already gone); drop the bookkeeping now so nothing more is sent to it.
    this.handleClose(connectionId, code, reason);
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

  private releasePreAuth(ip: string): void {
    const count = this.preAuthByIp.get(ip) || 0;
    if (count > 1) this.preAuthByIp.set(ip, count - 1);
    else this.preAuthByIp.delete(ip);
  }

  private getCapabilities(isAdmin: boolean): string[] {
    // `agent.stop` stops the caller's own agents, so every user has it.
    const caps = ['chat', 'subscribe', 'commands', 'ping', 'agent.stop'];
    if (isAdmin) caps.push('admin');
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
    this.preAuthByIp.clear();
    this.rateLimiter.destroy();
  }
}
