import { turnEventMessage } from './turn-event-message';
import type { Elysia } from '@/api/http';
import { webChatChannel } from '@/channels/webchat';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { getDocumentQueue } from '@/core/documents/queue';
import { trySteerRunningRootAgent } from '@/core/gateway/message-handler';
import { FileRefSchema } from '@/core/gateway/protocol';
import { getAgentService } from '@/core/agent';
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
  unsubscribeRoot?: () => void;
  unsubscribePermissions?: () => void;
  /** Browser-bridge auth flag — true once the bridge handshake succeeded. */
  _bridgeAuthed?: boolean;
  /** Client is in voice mode — narrate lifecycle events as `speak` frames. */
  voiceOn?: boolean;
  /** The session this connection put into voice mode — used to scope narration
   * to it and to clear the root agent's voice flag when the socket closes. */
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

      // Subscribe to root agent events for this user
      const rootAgent = getAgentService();
      const unsubscribeRoot = rootAgent.onEvent((event) => {
        // Only send events belonging to this user
        if (event.userId && event.userId !== session.userId) return;
        safeSend(turnEventMessage(event));
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
      wsData(ws).unsubscribeRoot = unsubscribeRoot;
      wsData(ws).unsubscribePermissions = unsubscribePermissions;

      // Track this connection for dedup
      const cleanup = () => {
        unsubscribe();
        unsubscribeRoot();
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
            // active session into the root agent's propose-then-confirm gate.
            data.voiceOn = !!parsed.on;
            const voiceSid = parsed.sessionId ? String(parsed.sessionId) : data.voiceSessionId;
            if (voiceSid) {
              getAgentService().setVoiceMode(voiceSid, !!parsed.on);
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

            // A running root turn takes the message as guidance, as the gateway
            // does. handleMessage would queue it behind that turn unpersisted:
            // it vanished from the transcript and ran as a new turn afterwards.
            // Attachments need a real turn, so they take the normal path.
            if (content && !fileRefs && parsed.sessionId) {
              const { sessionRepository } = await import('@/db/repositories/session-repository');
              const owned = (await sessionRepository.findById(sessionId))?.userId === userId;
              if (owned && await trySteerRunningRootAgent(sessionId, content)) {
                ws.send(JSON.stringify({ type: 'steer_result', sessionId, steered: true }));
                break;
              }
            }

            // Route through root agent (commands are handled inside handleMessage)
            const rootAgent = getAgentService();
            try {
              const result = await rootAgent.handleMessage(
                sessionId,
                userId,
                content,
                'webchat',
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
            // Resolve a pending root agent approval
            const orch = getAgentService();
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

            const rootAgent = getAgentService();
            const steered = rootAgent.steer(sessionId, {
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
        getAgentService().setVoiceMode(data.voiceSessionId, false);
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

      const permissionManager = getPermissionManager();
      // Subscribe before the snapshot query. Replay transitions after the
      // snapshot so a resolution during hydration cannot resurrect a request.
      let hydrating = true;
      const queued: { type: string; requestId?: string; [key: string]: unknown }[] = [];
      const send = (payload: { type: string; requestId?: string; [key: string]: unknown }) => {
        if (hydrating) { queued.push(payload); return; }
        try { ws.send(JSON.stringify(payload)); } catch (err) { apiLogger.warn({ err }, 'Permission notification send failed'); }
      };
      const unsubscribe = permissionManager.onRequest((request: PermissionRequestEvent) => {
        if (request.userId !== session.userId) return;
        send({ type: 'permission_request', ...request });
      });
      const unsubscribeResolved = permissionManager.onResolved((event) => {
        if (event.userId !== session.userId) return;
        send({ type: 'response_recorded', requestId: event.requestId, status: event.status });
      });
      wsData(ws).unsubscribePermissions = () => { unsubscribe(); unsubscribeResolved(); };
      try {
        const requests = await permissionManager.getPendingRequests(session.userId);
        ws.send(JSON.stringify({ type: 'pending_requests', requests }));
        hydrating = false;
        // A request created during hydration is already in the snapshot;
        // replaying it would hand the client the same requestId twice.
        const snapshot = new Set(requests.map(request => request.id));
        for (const frame of queued) {
          if (frame.type === 'permission_request' && frame.requestId && snapshot.has(frame.requestId)) continue;
          ws.send(JSON.stringify(frame));
        }
      } catch (err) {
        wsData(ws).unsubscribePermissions?.();
        apiLogger.warn({ err }, 'Permission snapshot failed');
        ws.close(1011, 'Permission snapshot unavailable');
        return;
      }

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

          const recorded = parsed.approved
            ? await permissionManager.approve(parsed.requestId, userId, parsed.resolution)
            : await permissionManager.deny(parsed.requestId, userId, parsed.resolution);
          if (!recorded) {
            // Another client may have answered first. Reconcile from owner-scoped state.
            ws.send(JSON.stringify({ type: 'pending_requests', requests: await permissionManager.getPendingRequests(userId) }));
          }
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
