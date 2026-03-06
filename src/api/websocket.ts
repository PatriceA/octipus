import type { Elysia } from 'elysia';
import { getSessionManager } from '@/security/auth/session';
import { getAgentManager } from '@/core/agent-manager';
import { webChatChannel } from '@/channels/webchat';
import { getPermissionManager } from '@/security/permissions';
import { getOrchestratorService } from '@/core/orchestrator';
import { apiLogger } from '@/utils/logger';

interface WebSocketData {
  userId: string;
  connectionId: string;
}

// Track active WebSocket connections per user to prevent duplicates
const activeConnections = new Map<string, { ws: any; cleanup: () => void }>();

export function setupWebSocket(app: Elysia): void {
  app.ws('/ws', {
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Authentication required');
        return;
      }

      const sessionManager = getSessionManager();
      const session = await sessionManager.validate(token);

      if (!session) {
        ws.close(4001, 'Invalid or expired token');
        return;
      }

      // Register connection
      const connectionId = webChatChannel.registerConnection(
        session.userId,
        (data) => ws.send(JSON.stringify(data)),
        () => ws.close(),
        session.channelId
      );

      // Store user info in ws data
      (ws.data as any).userId = session.userId;
      (ws.data as any).connectionId = connectionId;

      // Close previous connection for this user (prevents duplicate events from React Strict Mode / HMR)
      const existing = activeConnections.get(session.userId);
      if (existing) {
        existing.cleanup();
        try { existing.ws.close(4000, 'Superseded by new connection'); } catch { /* ignore */ }
        apiLogger.debug({ userId: session.userId }, 'Closed previous WebSocket connection');
      }

      // Subscribe to agent events for this user
      const agentManager = getAgentManager();
      const unsubscribe = agentManager.onEvent((event) => {
        // Only send events for agents belonging to this user
        const agent = agentManager.get(event.agentId);
        if (agent?.getContext().userId === session.userId) {
          ws.send(JSON.stringify({
            type: 'agent_event',
            event: event.type,
            agentId: event.agentId,
            data: event.data,
            timestamp: event.timestamp,
          }));
        }
      });

      // Subscribe to orchestrator events for this user
      const orchestrator = getOrchestratorService();
      const unsubscribeOrchestrator = orchestrator.onEvent((event) => {
        // Only send events belonging to this user
        if (event.userId && event.userId !== session.userId) return;
        ws.send(JSON.stringify({
          type: 'orchestrator_event',
          event: event.type,
          sessionId: event.sessionId,
          data: event.data,
          timestamp: event.timestamp,
        }));
      });

      // Subscribe to permission requests for this user
      const permissionManager = getPermissionManager();
      const unsubscribePermissions = permissionManager.onRequest?.((request: any) => {
        if (request.userId === session.userId) {
          ws.send(JSON.stringify({
            type: 'permission_request',
            ...request,
          }));
        }
      });

      // Store unsubscribe functions
      (ws.data as any).unsubscribeAgentEvents = unsubscribe;
      (ws.data as any).unsubscribeOrchestrator = unsubscribeOrchestrator;
      (ws.data as any).unsubscribePermissions = unsubscribePermissions;

      // Track this connection for dedup
      const cleanup = () => {
        unsubscribe();
        unsubscribeOrchestrator();
        if (unsubscribePermissions) unsubscribePermissions();
        webChatChannel.unregisterConnection(connectionId);
      };
      activeConnections.set(session.userId, { ws, cleanup });

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        connectionId,
        userId: session.userId,
      }));

      apiLogger.info({ connectionId, userId: session.userId }, 'WebSocket connected');
    },

    async message(ws, message) {
      const data = ws.data as any as WebSocketData;

      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;

        // Sanitize content: trim and limit length
        if (parsed.content !== undefined) {
          parsed.content = String(parsed.content || '').trim().slice(0, 50000);
        }

        switch (parsed.type) {
          case 'message':
            // Handle chat message
            await webChatChannel.handleIncoming(data.connectionId, {
              type: 'message',
              content: parsed.content,
              attachments: parsed.attachments,
              metadata: parsed.metadata,
            });
            break;

          case 'typing':
            // Broadcast typing indicator (if needed)
            break;

          case 'permission_response':
            // Handle permission approval/denial
            const permissionManager = getPermissionManager();
            if (parsed.approved) {
              await permissionManager.approve(parsed.requestId, data.userId, parsed.resolution);
            } else {
              await permissionManager.deny(parsed.requestId, data.userId, parsed.resolution);
            }
            break;

          case 'chat': {
            // Route chat messages through the orchestrator
            const orchestrator = getOrchestratorService();
            const sessionId = parsed.sessionId || `ws-${data.connectionId}`;
            try {
              const result = await orchestrator.handleMessage(
                sessionId,
                data.userId,
                parsed.content,
                'webchat',
                parsed.expertId,
              );
              // Use the resolved UUID sessionId from orchestrator (not the ephemeral ws- one)
              const resolvedId = result.sessionId || sessionId;
              ws.send(JSON.stringify({
                type: 'chat_response',
                response: result.response,
                sessionId: resolvedId,
                agentId: result.agentId,
                classification: result.classification,
                metadata: result.metadata,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'chat_error',
                error: (error as Error).message,
                sessionId,
              }));
            }
            break;
          }

          case 'approval_response': {
            // Resolve a pending orchestrator approval
            const orch = getOrchestratorService();
            const resolved = orch.resolveApproval(
              parsed.requestId,
              parsed.approved,
              parsed.response,
            );
            ws.send(JSON.stringify({
              type: 'approval_resolved',
              requestId: parsed.requestId,
              resolved,
            }));
            break;
          }

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

          default:
            apiLogger.debug({ type: parsed.type }, 'Unknown WebSocket message type');
        }
      } catch (error) {
        apiLogger.error({ error }, 'WebSocket message handling error');
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    },

    close(ws) {
      const data = ws.data as any;

      // Only clean up if this is still the active connection for this user
      const active = data.userId ? activeConnections.get(data.userId) : null;
      if (active?.ws === ws) {
        active.cleanup();
        activeConnections.delete(data.userId);
      } else {
        // Stale connection — just unregister webchat
        if (data.connectionId) {
          webChatChannel.unregisterConnection(data.connectionId);
        }
      }

      apiLogger.info({ connectionId: data.connectionId }, 'WebSocket disconnected');
    },

    error(ws) {
      apiLogger.error('WebSocket error');
    },
  });

  // Permission request notifications endpoint
  app.ws('/ws/permissions', {
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Authentication required');
        return;
      }

      const sessionManager = getSessionManager();
      const session = await sessionManager.validate(token);

      if (!session) {
        ws.close(4001, 'Invalid or expired token');
        return;
      }

      (ws.data as any).userId = session.userId;

      // Send pending permission requests
      const permissionManager = getPermissionManager();
      const pendingRequests = await permissionManager.getPendingRequests(session.userId);

      ws.send(JSON.stringify({
        type: 'pending_requests',
        requests: pendingRequests,
      }));

      apiLogger.info({ userId: session.userId }, 'Permission WS connected');
    },

    async message(ws, message) {
      const data = ws.data as any;

      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;

        if (parsed.type === 'respond') {
          const permissionManager = getPermissionManager();

          if (parsed.approved) {
            await permissionManager.approve(parsed.requestId, data.userId, parsed.resolution);
          } else {
            await permissionManager.deny(parsed.requestId, data.userId, parsed.resolution);
          }

          ws.send(JSON.stringify({
            type: 'response_recorded',
            requestId: parsed.requestId,
            approved: parsed.approved,
          }));
        }
      } catch (error) {
        apiLogger.error({ error }, 'Permission WS message error');
      }
    },

    close(ws) {
      const data = ws.data as any;
      apiLogger.info({ userId: data.userId }, 'Permission WS disconnected');
    },
  });
}
