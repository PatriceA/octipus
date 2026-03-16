import type { Elysia } from 'elysia';
import { getSessionManager } from '@/security/auth/session';
import { getAgentManager } from '@/core/agent-manager';
import { webChatChannel } from '@/channels/webchat';
import { getPermissionManager } from '@/security/permissions';
import { getOrchestratorService } from '@/core/orchestrator';
import { getBrowserBridge } from './browser-bridge';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';

interface WebSocketData {
  userId: string;
  connectionId: string;
}

// Track active WebSocket connections per user to prevent duplicates
const activeConnections = new Map<string, { ws: any; cleanup: () => void }>();

/**
 * Handle slash commands in webchat. Returns a response string if the message
 * is a recognized command, or null to continue normal processing.
 */
function handleChatCommand(content: string, sessionId: string): string | null {
  if (!content.startsWith('/')) return null;

  const [cmd, ...rest] = content.split(/\s+/);
  const command = cmd.toLowerCase();

  switch (command) {
    case '/help':
      return [
        '**Available Commands**\n',
        '| Command | Description |',
        '|---------|-------------|',
        '| `/help` | Show this list |',
        '| `/status` | Show running agents and session info |',
        '| `/stop` | Stop all running agents in this session |',
        '| `/clear` | Clear conversation context |',
        '| `/experts` | List available expert personas |',
        '| `/models` | List available models |',
      ].join('\n');

    case '/status': {
      const agentManager = getAgentManager();
      const agents = agentManager.getBySession(sessionId);
      const running = agents.filter(a => a.getStatus() === 'running');
      const completed = agents.filter(a => a.getStatus() === 'completed');
      const failed = agents.filter(a => a.getStatus() === 'failed');
      return [
        '**Session Status**\n',
        `Session: \`${sessionId.slice(0, 8)}...\``,
        `Agents: ${running.length} running, ${completed.length} completed, ${failed.length} failed`,
        ...(running.length > 0
          ? ['\n**Running:**', ...running.map(a => {
              const ctx = a.getContext();
              return `- ${ctx.role} (${ctx.model}) — iteration ${a.getIteration()}`;
            })]
          : []),
      ].join('\n');
    }

    case '/stop': {
      const agentManager = getAgentManager();
      const count = agentManager.stopSession(sessionId);
      return count > 0
        ? `Stopped ${count} running agent${count > 1 ? 's' : ''}.`
        : 'No running agents in this session.';
    }

    case '/clear':
      return 'Session context cleared. Send a new message to start fresh.';

    case '/experts': {
      // Async query not possible here — return a hint
      return 'Use the **Experts** panel in the sidebar to see all available expert personas, or send a message and the orchestrator will auto-select the best expert for your task.';
    }

    case '/models': {
      return 'Use the **Models** page in the web UI to see all configured models, their status, and routing rules.';
    }

    default:
      return `Unknown command: \`${command}\`. Type \`/help\` to see available commands.`;
  }
}

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

      // Safe send helper — prevents crashes when WebSocket is closed
      const safeSend = (data: unknown) => {
        try { ws.send(JSON.stringify(data)); } catch { /* connection closed */ }
      };

      // Subscribe to agent events for this user
      const agentManager = getAgentManager();
      const unsubscribe = agentManager.onEvent((event) => {
        // Only send events for agents belonging to this user
        const agent = agentManager.get(event.agentId);
        if (agent?.getContext().userId === session.userId) {
          safeSend({
            type: 'agent_event',
            event: event.type,
            agentId: event.agentId,
            data: event.data,
            timestamp: event.timestamp,
          });
        }
      });

      // Subscribe to orchestrator events for this user
      const orchestrator = getOrchestratorService();
      const unsubscribeOrchestrator = orchestrator.onEvent((event) => {
        // Only send events belonging to this user
        if (event.userId && event.userId !== session.userId) return;
        safeSend({
          type: 'orchestrator_event',
          event: event.type,
          sessionId: event.sessionId,
          data: event.data,
          timestamp: event.timestamp,
        });
      });

      // Subscribe to permission requests for this user
      const permissionManager = getPermissionManager();
      const unsubscribePermissions = permissionManager.onRequest?.((request: any) => {
        if (request.userId === session.userId) {
          safeSend({
            type: 'permission_request',
            ...request,
          });
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
            const sessionId = parsed.sessionId || `ws-${data.connectionId}`;
            const content = (parsed.content || '').trim();

            // Handle slash commands locally (no LLM call needed)
            const commandResponse = handleChatCommand(content, sessionId);
            if (commandResponse) {
              ws.send(JSON.stringify({
                type: 'chat_response',
                response: commandResponse,
                sessionId,
                classification: { type: 'casual', confidence: 1 },
              }));
              break;
            }

            // Route chat messages through the orchestrator
            const orchestrator = getOrchestratorService();
            try {
              const result = await orchestrator.handleMessage(
                sessionId,
                data.userId,
                content,
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

  // Browser bridge WebSocket — registered alongside other WS routes
  const bridge = getBrowserBridge();

  app.ws('/ws/browser-bridge', {
    open(ws) {
      const url = new URL(ws.data?.request?.url || '', 'http://localhost');
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Missing authentication token');
        return;
      }

      const config = getConfig();
      const masterKey = config.security.masterKey;

      if (token !== masterKey) {
        ws.close(4001, 'Invalid authentication token');
        return;
      }

      (ws.data as any)._bridgeAuthed = true;
      apiLogger.info('Browser bridge: WebSocket connected, awaiting handshake');
      ws.send(JSON.stringify({ type: 'ready' }));
    },

    message(ws, message) {
      if (!(ws.data as any)?._bridgeAuthed) return;

      let parsed: any;
      try {
        if (typeof message === 'object' && message !== null && !(message instanceof Buffer) && !(message instanceof Uint8Array)) {
          parsed = message;
        } else {
          const str = typeof message === 'string' ? message : new TextDecoder().decode(message as any);
          parsed = JSON.parse(str);
        }
      } catch (err) {
        apiLogger.warn({ error: (err as Error).message }, 'Browser bridge: failed to parse message');
        return;
      }

      switch (parsed.type) {
        case 'connect':
          bridge.registerConnection(ws, {
            version: parsed.version,
            tabCount: parsed.tabCount,
            userAgent: parsed.userAgent,
          });
          ws.send(JSON.stringify({ type: 'connected' }));
          break;

        case 'result':
          bridge.handleResult(parsed.id, parsed.result, parsed.error);
          break;

        case 'tab_update':
          bridge.handleTabUpdate(parsed.tab);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    },

    close(ws) {
      if ((ws.data as any)?._bridgeAuthed) {
        bridge.handleDisconnect();
      }
    },

    error(ws: any) {
      apiLogger.error('Browser bridge WebSocket error');
    },
  });

}
