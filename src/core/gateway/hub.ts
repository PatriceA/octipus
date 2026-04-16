import { randomBytes } from 'crypto';
import { coreLogger } from '@/utils/logger';
import { ConnectionManager } from './connection-manager';
import { GatewayEventBus } from './event-bus';
import { GatewayRateLimiter } from './rate-limiter';
import { ensureLocalToken } from './local-auth';
import type { ConnectionContext, GatewayEvent, ClientMessage } from './protocol';
import { PROTOCOL_VERSION } from './protocol';

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

  constructor() {
    const rateLimiter = new GatewayRateLimiter();
    this.connectionManager = new ConnectionManager({ rateLimiter });
    this.eventBus = new GatewayEventBus();

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
   * Start the gateway hub. Generates local token if needed.
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Ensure local auth token exists
    ensureLocalToken();

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

  /**
   * Set the HMAC validator for channel adapters.
   */
  setHmacValidator(validator: (key: string, channelType: string) => Promise<boolean>): void {
    this.connectionManager.setHmacValidator(validator);
  }

  /**
   * Set the handler for authenticated client messages.
   */
  setMessageHandler(handler: (connectionId: string, context: ConnectionContext, message: ClientMessage) => Promise<void> | void): void {
    this.messageHandler = handler;
  }

  /**
   * Publish a gateway event to all subscribed connections.
   */
  publishEvent(event: Omit<GatewayEvent, 'id' | 'timestamp'>): void {
    const fullEvent: GatewayEvent = {
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
        // Security: only deliver events the connection is allowed to see
        if (fullEvent.userId && fullEvent.userId !== ctx.userId && ctx.trustLevel !== 'system' && ctx.trustLevel !== 'local') {
          return false;
        }
        // Check subscription patterns
        for (const pattern of ctx.eventSubscriptions) {
          if (matchesPatternImport(fullEvent.type, pattern)) return true;
        }
        return false;
      },
    );
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
      switch (message.type) {
        case 'ping':
          this.connectionManager.sendToConnection(connectionId, {
            type: 'pong',
            serverTime: new Date().toISOString(),
          });
          break;

        case 'subscribe': {
          for (const pattern of message.patterns) {
            context.eventSubscriptions.add(pattern);
          }
          break;
        }

        case 'unsubscribe': {
          for (const pattern of message.patterns) {
            context.eventSubscriptions.delete(pattern);
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
