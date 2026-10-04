import { randomBytes } from 'crypto';
import { getConfig } from '@/config';
import { onSessionsRemoved } from '@/db/repositories/session-lifecycle';
import { coreLogger } from '@/utils/logger';
import { type ConnectionWorkspaceResolver, ConnectionManager } from './connection-manager';
import { GatewayEventBus } from './event-bus';
import type { ClientMessage, ConnectionContext, GatewayMessage, PermissionPendingMessage, UserGatewayEvent } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import { GatewayRateLimiter } from './rate-limiter';
import { canSubscribeToResource } from './resource-access';

/**
 * Events that change the pending-prompt list `permission.pending` describes.
 * While a connection's snapshot is being read they are held, then sent after
 * it (`ConnectionContext.hydrationQueue`).
 */
const HYDRATED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'permission.request',
  'permission.resolved',
  'agent.approval_required',
  'approval.resolved',
]);

/** Reads a user's open permission requests and root-agent approvals for `permission.pending`. */
export type PendingSnapshotProvider = (userId: string) => Promise<Omit<PermissionPendingMessage, 'type'>>;

/**
 * GatewayHub — central WebSocket hub that all clients connect to.
 * Manages connections, events, authentication, and message routing.
 */
export class GatewayHub {
  readonly connectionManager: ConnectionManager;
  readonly eventBus: GatewayEventBus;
  private started = false;

  // External handlers set by the server that integrates the hub
  private messageHandler?: (connectionId: string, context: ConnectionContext, message: ClientMessage) => Promise<void> | void;
  private pendingSnapshot?: PendingSnapshotProvider;
  private connectionClosedHandler?: (context: ConnectionContext) => void;

  constructor() {
    const rateLimiter = new GatewayRateLimiter();
    this.connectionManager = new ConnectionManager({
      rateLimiter,
      budget: { maxPerUser: () => getConfig().gateway.maxConnectionsPerUser },
    });
    this.eventBus = new GatewayEventBus({ maxSessions: () => getConfig().gateway.replayMaxSessions });

    // A deleted or archived session's events are not kept for replay.
    onSessionsRemoved((sessionIds) => {
      for (const sessionId of sessionIds) this.eventBus.clearReplay(sessionId);
    });

    this.connectionManager.onConnectionClosed = (context) => {
      this.connectionClosedHandler?.(context);
    };

    // Wire connection manager's message callback to our router
    this.connectionManager.onMessage = (connectionId, context, message) => {
      this.routeMessage(connectionId, context, message);
    };

    // Wire audit events
    this.connectionManager.onAuditEvent = (event, data) => {
      this.emitAuditEvent(event, data);
    };
  }

  /**
   * Start the gateway hub.
   */
  async start(): Promise<void> {
    if (this.started) return;

    this.started = true;
    coreLogger.info({ protocolVersion: PROTOCOL_VERSION }, 'Gateway hub started');
  }

  /**
   * Stop the gateway hub, draining all connections.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    await this.connectionManager.drain();
    this.eventBus.destroy();
    this.started = false;

    coreLogger.info('Gateway hub stopped');
  }

  /**
   * Set the session validator (called during auth).
   */
  setSessionValidator(validator: (token: string) => Promise<{ userId: string; username: string; isAdmin: boolean } | null>): void {
    this.connectionManager.setSessionValidator(validator);
  }

  /** Set how a user connection's workspace is resolved at auth (`?workspace=`). */
  setWorkspaceResolver(resolver: ConnectionWorkspaceResolver): void {
    this.connectionManager.setWorkspaceResolver(resolver);
  }

  /**
   * Set the handler for authenticated client messages.
   */
  setMessageHandler(handler: (connectionId: string, context: ConnectionContext, message: ClientMessage) => Promise<void> | void): void {
    this.messageHandler = handler;
  }

  /** Set how `permission.pending` snapshots are read (wired with the message handler). */
  setPendingSnapshotProvider(provider: PendingSnapshotProvider): void {
    this.pendingSnapshot = provider;
  }

  /** Called with the context of every authenticated connection that ends. */
  setConnectionClosedHandler(handler: (context: ConnectionContext) => void): void {
    this.connectionClosedHandler = handler;
  }

  /**
   * Publish a user's event: to the internal bus, and to that user's
   * connections whose patterns match. Delivery is by user id alone — trust
   * level, admin rights and client type widen nothing. Events that belong to
   * no user are `GLOBAL_EVENT_TYPES` and never come through here.
   *
   * `only` narrows delivery further, to some of the user's connections
   * (`voice.speak` goes to the voice-mode connection only); it can never
   * widen it past the user.
   */
  publishEvent(event: Omit<UserGatewayEvent, 'id' | 'timestamp'>, only?: (ctx: ConnectionContext) => boolean): void {
    const fullEvent: UserGatewayEvent = {
      ...event,
      id: randomBytes(12).toString('hex'),
      timestamp: Date.now(),
    };

    // Publish to event bus (internal subscribers)
    this.eventBus.publish(fullEvent);

    // Fan out to WebSocket connections that match
    this.connectionManager.broadcast(
      { type: 'event', event: fullEvent },
      (ctx) => {
        // Security: an event reaches its own user's connections only. No
        // trust level or admin right widens this.
        if (fullEvent.userId !== ctx.userId) return false;
        if (only && !only(ctx)) return false;
        // Check subscription patterns
        let subscribed = false;
        for (const pattern of ctx.eventSubscriptions) {
          if (matchesPatternImport(fullEvent.type, pattern)) {
            subscribed = true;
            break;
          }
        }
        if (!subscribed) return false;
        // Held until this connection's pending snapshot has gone out.
        if (ctx.hydrationQueue && HYDRATED_EVENT_TYPES.has(fullEvent.type)) {
          ctx.hydrationQueue.push(fullEvent);
          return false;
        }
        return true;
      },
    );
  }

  /**
   * Send a user connection its `permission.pending` snapshot. Live
   * `permission.*` / approval events raised while it is read are held and
   * sent after it; a `permission.request` already in the snapshot is not
   * sent twice. A failed read is reported to the connection, never
   * swallowed: the client keeps the list it has.
   */
  async sendPendingSnapshot(connectionId: string, context: ConnectionContext): Promise<void> {
    if (!this.pendingSnapshot || context.artifactId !== undefined) return;
    if (context.hydrationQueue) return; // a snapshot is already on its way
    const queue: UserGatewayEvent[] = [];
    context.hydrationQueue = queue;
    try {
      const snapshot = await this.pendingSnapshot(context.userId);
      this.connectionManager.sendToConnection(connectionId, { type: 'permission.pending', ...snapshot });
      const inSnapshot = new Set([
        ...snapshot.requests.map((r) => r.requestId),
        ...snapshot.approvals.map((a) => a.requestId),
      ]);
      context.hydrationQueue = undefined;
      for (const event of queue) {
        const requestId = (event.payload as { requestId?: unknown } | null)?.requestId;
        const raised = event.type === 'permission.request' || event.type === 'agent.approval_required';
        if (raised && typeof requestId === 'string' && inSnapshot.has(requestId)) continue;
        this.connectionManager.sendToConnection(connectionId, { type: 'event', event });
      }
    } catch (err) {
      context.hydrationQueue = undefined;
      coreLogger.warn({ err, connectionId, userId: context.userId }, 'Pending permission snapshot failed');
      this.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'PENDING_SNAPSHOT_FAILED',
        message: 'Could not read your pending permission requests',
      });
      // The held events are still true: deliver them rather than drop them.
      for (const event of queue) this.connectionManager.sendToConnection(connectionId, { type: 'event', event });
    }
  }

  /**
   * Send a message to every connection subscribed to `resource`
   * (`artifact:<id>`, …). Outside the event bus and outside the user rule:
   * a connection is in a resource only after `canSubscribeToResource` let it in.
   */
  publishToResource(resource: string, message: GatewayMessage): void {
    this.connectionManager.broadcast(message, (ctx) => ctx.resources.has(resource));
  }

  /**
   * Get hub status.
   */
  getStatus(): { started: boolean; connections: ReturnType<ConnectionManager['getConnectionCount']>; events: ReturnType<GatewayEventBus['getStats']> } {
    return {
      started: this.started,
      connections: this.connectionManager.getConnectionCount(),
      events: this.eventBus.getStats(),
    };
  }

  // ── Internal ────────────────────────────────────────────────────

  private async routeMessage(connectionId: string, context: ConnectionContext, message: ClientMessage): Promise<void> {
    try {
      // An artifact-token connection is a viewer of one artifact, not a user:
      // it pings and (un)subscribes, nothing else reaches a handler.
      if (context.artifactId !== undefined && message.type !== 'ping' && message.type !== 'subscribe' && message.type !== 'unsubscribe') {
        this.connectionManager.sendToConnection(connectionId, {
          type: 'error',
          code: 'FORBIDDEN',
          message: `An artifact connection cannot send ${message.type}`,
        });
        return;
      }
      switch (message.type) {
        case 'ping':
          this.connectionManager.sendToConnection(connectionId, {
            type: 'pong',
            serverTime: new Date().toISOString(),
          });
          break;

        case 'subscribe': {
          for (const pattern of message.patterns ?? []) {
            context.eventSubscriptions.add(pattern);
          }
          await this.subscribeResources(connectionId, context, message.resources ?? []);
          // A subscribing user connection learns what is already waiting on
          // its user (a tab opened after the prompt was raised shows it).
          if ((message.patterns?.length ?? 0) > 0) await this.sendPendingSnapshot(connectionId, context);
          break;
        }

        case 'unsubscribe': {
          for (const pattern of message.patterns ?? []) {
            context.eventSubscriptions.delete(pattern);
          }
          for (const resource of message.resources ?? []) {
            context.resources.delete(resource);
          }
          break;
        }

        default:
          // Delegate to external handler
          if (this.messageHandler) {
            await this.messageHandler(connectionId, context, message);
          } else {
            this.connectionManager.sendToConnection(connectionId, {
              type: 'error',
              code: 'NO_HANDLER',
              message: `No handler for message type: ${message.type}`,
            });
          }
      }
    } catch (err) {
      coreLogger.error({ err, connectionId, messageType: message.type }, 'Error routing message');
      this.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    }
  }

  private async subscribeResources(connectionId: string, context: ConnectionContext, resources: string[]): Promise<void> {
    if (resources.length === 0) return;
    const granted: string[] = [];
    for (const resource of resources) {
      if (!(await canSubscribeToResource(context, resource))) {
        coreLogger.warn({ connectionId, userId: context.userId, resource }, 'Gateway resource subscribe denied');
        this.connectionManager.sendToConnection(connectionId, {
          type: 'error',
          code: 'FORBIDDEN',
          message: `Not allowed to subscribe to ${resource}`,
        });
        continue;
      }
      context.resources.add(resource);
      granted.push(resource);
    }
    if (granted.length > 0) {
      this.connectionManager.sendToConnection(connectionId, { type: 'subscribed', resources: granted });
    }
  }

  private emitAuditEvent(event: string, data: Record<string, unknown>): void {
    // Audit events from the connection manager carry their original name in
    // the payload so subscribers can filter; the bus type is the catch-all
    // 'audit' so the GatewayEventType union stays closed.
    this.eventBus.publish({
      id: randomBytes(12).toString('hex'),
      type: 'audit',
      source: 'gateway',
      userId: data.userId as string | undefined,
      timestamp: Date.now(),
      payload: { originalType: event, ...data },
    });
  }
}

// Need the pattern matcher
import { matchesPattern as matchesPatternImport } from './protocol';

// ── Singleton ─────────────────────────────────────────────────────

let instance: GatewayHub | null = null;

export function getGatewayHub(): GatewayHub {
  if (!instance) {
    instance = new GatewayHub();
  }
  return instance;
}
