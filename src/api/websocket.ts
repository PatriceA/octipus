import type { Elysia } from '@/api/http';
import { webChatChannel } from '@/channels/webchat';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { getDocumentQueue } from '@/core/documents/queue';
import { FileRefSchema } from '@/core/gateway/protocol';
import { getOrchestratorService } from '@/core/orchestrator';
import { getApiTokenManager } from '@/security/api-tokens';
import { getSessionManager } from '@/security/auth/session';
import { getPermissionManager, type PermissionRequestEvent } from '@/security/permissions';
import { secureCompare } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';
import { narrate } from '@/voice/narrator';
import { getBrowserBridge } from './browser-bridge';
import { setupVoiceMediaWebSocket } from './voice-media-ws';
import { setupVoiceWebSocket } from './voice-ws';

interface WebSocketData {
  userId?: string;
  connectionId?: string;
  unsubscribeAgentEvents?: () => void;
  unsubscribeOrchestrator?: () => void;
  unsubscribePermissions?: () => void;
  /** Browser-bridge auth flag — true once the bridge handshake succeeded. */
  _bridgeAuthed?: boolean;
  /** Client is in voice mode — narrate lifecycle events as `speak` frames. */
  voiceOn?: boolean;
  /** The session this connection put into voice mode — used to scope narration
   * to it and to clear the orchestrator's voice flag when the socket closes. */
  voiceSessionId?: string;
}

/**
 * Cast Elysia's untyped `ws.data` to our typed `WebSocketData`. The framework
 * surfaces `data` as a wide structural type; we own the keys we put on it.
 */
function wsData(ws: { data: unknown }): WebSocketData {
  return ws.data as WebSocketData;
}

// Track active WebSocket connections per user to prevent duplicates.
// `ws` is unknown because Bun's WebSocket type leaks into Elysia's surface
// — we only need to call `.close()` on it.
const activeConnections = new Map<string, { ws: { close: (code?: number, reason?: string) => void }; cleanup: () => void }>();

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
      wsData(ws).userId = session.userId;
      wsData(ws).connectionId = connectionId;

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
            sessionId: agent.getContext().sessionId,
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
        // Narrate lifecycle to voice clients — decoupled from the slow reply path,
        // so long agent turns get acked/announced instead of read back stale.
        // Scoped to the voice-mode session so a user's OTHER sessions (2nd tab,
        // background run) don't get narrated into this conversation.
        if (wsData(ws).voiceOn && event.sessionId === wsData(ws).voiceSessionId) {
          const line = narrate(event);
          if (line) safeSend({ type: 'speak', text: line });
        }
      });

      // Subscribe to document processing events for this user
      const docQueue = getDocumentQueue();
      const docHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
      for (const eventName of ['enqueued', 'processing', 'completed', 'failed'] as const) {
        const handler = (documentId: string, errorOrUserId?: string, maybeUserId?: string) => {
          const docUserId = eventName === 'failed' ? maybeUserId : errorOrUserId;
          if (docUserId && docUserId !== session.userId) return;
          safeSend({
            type: 'document_event',
            event: eventName,
            documentId,
            ...(eventName === 'failed' ? { error: errorOrUserId } : {}),
            timestamp: Date.now(),
          });
        };
        docQueue.on(eventName, handler);
        docHandlers.push({ event: eventName, handler });
      }

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

      // Subscribe to swarm events on the shared GatewayEventBus so the legacy
      // /ws endpoint also receives Phase 1 swarm lifecycle events. We relay
      // them as `swarm_event` messages so the web client can route them.
      let unsubscribeSwarm: (() => void) | undefined;
      try {
        const { getGatewayHub } = await import('@/core/gateway/hub');
        const hub = getGatewayHub();
        unsubscribeSwarm = hub.eventBus.subscribe('swarm.*', (event) => {
          if (event.userId && event.userId !== session.userId) return;
          safeSend({
            type: 'swarm_event',
            event: event.type,
            sessionId: event.sessionId,
            payload: event.payload,
            timestamp: event.timestamp,
          });
        });
      } catch (err) {
        apiLogger.debug({ err }, 'swarm event subscription skipped');
      }

      // Subscribe to hwfit model-install progress for this user — the
      // Recommended-models panel listens for these instead of polling.
      let unsubscribeInstall: (() => void) | undefined;
      try {
        const { onInstallProgress } = await import('@/capabilities/hwfit/install-events');
        unsubscribeInstall = onInstallProgress((job) => {
          if (job.ownerId !== session.userId) return;
          safeSend({ type: 'model_install_progress', job, timestamp: Date.now() });
        });
      } catch (err) {
        apiLogger.debug({ err }, 'install-progress subscription skipped');
      }

      // Store unsubscribe functions
      wsData(ws).unsubscribeAgentEvents = unsubscribe;
      wsData(ws).unsubscribeOrchestrator = unsubscribeOrchestrator;
      wsData(ws).unsubscribePermissions = unsubscribePermissions;

      // Track this connection for dedup
      const cleanup = () => {
        unsubscribe();
        unsubscribeOrchestrator();
        if (unsubscribePermissions) unsubscribePermissions();
        if (unsubscribeSwarm) unsubscribeSwarm();
        if (unsubscribeInstall) unsubscribeInstall();
        for (const { event, handler } of docHandlers) {
          docQueue.off(event, handler);
        }
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
      const data = wsData(ws);
      // open() always sets these — guard so the type-narrowed branches below
      // don't have to keep re-checking. If they're missing the WS skipped auth.
      if (!data.userId || !data.connectionId) {
        ws.close(4001, 'Connection not authenticated');
        return;
      }
      const userId = data.userId;
      const connectionId = data.connectionId;

      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;

        // Sanitize content: trim and limit length
        if (parsed.content !== undefined) {
          parsed.content = String(parsed.content || '').trim().slice(0, 50000);
        }

        switch (parsed.type) {
          case 'message':
            // Handle chat message
            await webChatChannel.handleIncoming(connectionId, {
              type: 'message',
              content: parsed.content,
              attachments: parsed.attachments,
              metadata: parsed.metadata,
            });
            break;

          case 'typing':
            // Broadcast typing indicator (if needed)
            break;

          case 'voice': {
            // Toggle voice mode: narrate lifecycle to this connection, and put the
            // active session into the orchestrator's propose-then-confirm gate.
            data.voiceOn = !!parsed.on;
            const voiceSid = parsed.sessionId ? String(parsed.sessionId) : data.voiceSessionId;
            if (voiceSid) {
              getOrchestratorService().setVoiceMode(voiceSid, !!parsed.on);
              // Remember the session so close() can clear it; forget it on 'off'.
              data.voiceSessionId = parsed.on ? voiceSid : undefined;
            }
            break;
          }

          case 'permission_response':
            // Handle permission approval/denial
            const permissionManager = getPermissionManager();
            if (parsed.approved) {
              await permissionManager.approve(parsed.requestId, userId, parsed.resolution);
            } else {
              await permissionManager.deny(parsed.requestId, userId, parsed.resolution);
            }
            break;

          case 'chat': {
            const content = (parsed.content || '').trim();
            let sessionId = parsed.sessionId as string | undefined;

            // Auto-create a proper DB session when none provided
            if (!sessionId) {
              const { sessionRepository } = await import('@/db/repositories/session-repository');
              const { generateId } = await import('@/utils/crypto');
              const session = await sessionRepository.create({
                userId: userId,
                channelType: 'webchat',
                channelId: `chat-${generateId().slice(0, 8)}`,
                title: content.slice(0, 100) || 'New Chat',
              });
              sessionId = session.id;
            }

            // Edit-and-continue: validate any attached session-file refs. A
            // malformed payload is logged and dropped (the turn still runs),
            // never silently coerced.
            let fileRefs: Array<{ path: string; version?: string }> | undefined;
            if (parsed.fileRefs !== undefined) {
              const refs = FileRefSchema.array().max(10).safeParse(parsed.fileRefs);
              if (refs.success) fileRefs = refs.data;
              else apiLogger.warn({ issues: refs.error.issues }, 'Ignoring malformed chat fileRefs');
            }
            // Chat/work split: per-message deliverable override (inline | file).
            const outputMode = parsed.outputMode === 'inline' || parsed.outputMode === 'file' ? parsed.outputMode : undefined;

            // Route through orchestrator (commands are handled inside handleMessage)
            const orchestrator = getOrchestratorService();
            try {
              const result = await orchestrator.handleMessage(
                sessionId,
                userId,
                content,
                'webchat',
                parsed.expertId,
                fileRefs,
                outputMode,
              );
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

          case 'steer': {
            // Inject a steering message into the active agent for a session
            const content = (parsed.content || '').trim();
            const sessionId = parsed.sessionId as string | undefined;
            if (!content || !sessionId) {
              ws.send(JSON.stringify({
                type: 'steer_error',
                error: 'Missing content or sessionId',
              }));
              break;
            }

            const orchestrator = getOrchestratorService();
            const steered = orchestrator.steer(sessionId, {
              role: parsed.role || 'user',
              content,
              timestamp: new Date(),
            });
            ws.send(JSON.stringify({
              type: 'steer_result',
              sessionId,
              steered,
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
      const data = wsData(ws);

      // Clear this connection's voice flag so a session left in voice mode isn't
      // stuck in the propose-then-confirm gate after a refresh/disconnect.
      if (data.voiceSessionId) {
        getOrchestratorService().setVoiceMode(data.voiceSessionId, false);
        data.voiceSessionId = undefined;
      }

      // Only clean up if this is still the active connection for this user
      const active = data.userId ? activeConnections.get(data.userId) : null;
      if (active && active.ws === ws && data.userId) {
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

      wsData(ws).userId = session.userId;

      // Send pending permission requests
      const permissionManager = getPermissionManager();
      const pendingRequests = await permissionManager.getPendingRequests(session.userId);

      ws.send(JSON.stringify({
        type: 'pending_requests',
        requests: pendingRequests,
      }));

      // Live forwarding: without this subscription, only requests that already
      // existed at connect time reached this endpoint. New `permission_request`
      // events fired during the session were dropped, so the global permission
      // banner on non-chat pages never lit up.
      const unsubscribe = permissionManager.onRequest?.((request: PermissionRequestEvent) => {
        if (request.userId !== session.userId) return;
        try {
          ws.send(JSON.stringify({
            type: 'permission_request',
            requestId: request.requestId,
            toolId: request.toolId,
            action: request.action,
            toolName: request.toolName,
            args: request.args,
            agentId: request.agentId,
            sessionId: request.sessionId,
          }));
        } catch (err) {
          apiLogger.warn({ err }, 'permission live-forward send failed');
        }
      });
      wsData(ws).unsubscribePermissions = unsubscribe;

      apiLogger.info({ userId: session.userId }, 'Permission WS connected');
    },

    async message(ws, message) {
      const data = wsData(ws);
      if (!data.userId) {
        ws.close(4001, 'Connection not authenticated');
        return;
      }
      const userId = data.userId;

      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;

        if (parsed.type === 'respond') {
          const permissionManager = getPermissionManager();

          if (parsed.approved) {
            await permissionManager.approve(parsed.requestId, userId, parsed.resolution);
          } else {
            await permissionManager.deny(parsed.requestId, userId, parsed.resolution);
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
      const data = wsData(ws);
      if (data.unsubscribePermissions) {
        try { data.unsubscribePermissions(); } catch { /* ignore */ }
      }
      apiLogger.info({ userId: data.userId }, 'Permission WS disconnected');
    },
  });

  // Browser bridge WebSocket — registered alongside other WS routes
  const bridge = getBrowserBridge();

  app.ws('/ws/browser-bridge', {
    async open(ws) {
      const url = new URL(ws.data?.request?.url || '', 'http://localhost');
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Missing authentication token');
        return;
      }

      // Authenticate with a generated API token (preferred — revocable and
      // per-user; create one in Settings → API Tokens). The master key is
      // still accepted as a legacy fallback so existing setups keep working.
      let userId: string | undefined;
      const apiAuth = await getApiTokenManager().validate(token);
      if (apiAuth) {
        userId = apiAuth.userId;
      } else {
        const masterKey = getConfig().security.masterKey;
        if (!masterKey || !secureCompare(token, masterKey)) {
          ws.close(4001, 'Invalid authentication token');
          return;
        }
      }

      wsData(ws)._bridgeAuthed = true;
      wsData(ws).userId = userId;
      apiLogger.info({ userId }, 'Browser bridge: WebSocket connected, awaiting handshake');
      ws.send(JSON.stringify({ type: 'ready' }));
    },

    message(ws, message) {
      if (!wsData(ws)._bridgeAuthed) return;

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
      if (wsData(ws)._bridgeAuthed) {
        bridge.handleDisconnect();
      }
    },

    error(ws: any) {
      apiLogger.error('Browser bridge WebSocket error');
    },
  });

  // Realtime voice duplex socket (Phase 4b): browser PCM frames → streaming STT.
  setupVoiceWebSocket(app);
  // Telephony media stream (Phase 4d): Twilio μ-law ↔ STT/TTS duplex.
  setupVoiceMediaWebSocket(app);
}
