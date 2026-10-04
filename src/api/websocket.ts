/**
 * The WebSocket endpoints that are not the gateway: the browser extension's
 * `/ws/browser-bridge` and the voice sockets (`/voice`, `/voice/media/:provider`).
 *
 * The web app's chat, permission prompts and install progress travel over
 * `/gateway` (gateway-ws.ts); the legacy `/ws` and `/ws/permissions` were
 * retired with coworking S0d.
 */
import type { Elysia } from '@/api/http';
import { getConfig } from '@/config';
import { getApiTokenManager } from '@/security/api-tokens';
import { userChangeMark } from '@/security/user-change-marks';
import { secureCompare } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';
import { getBrowserBridge } from './browser-bridge';
import { setupVoiceMediaWebSocket } from './voice-media-ws';
import { trackUserSocket } from './user-sockets';
import { setupVoiceWebSocket } from './voice-ws';

interface WebSocketData {
  userId?: string;
  /** Browser-bridge auth flag — true once the bridge handshake succeeded. */
  _bridgeAuthed?: boolean;
  /** Drops this socket from the user's socket list (user-sockets.ts). */
  untrack?: () => void;
}

/**
 * Cast Elysia's untyped `ws.data` to our typed `WebSocketData`. The framework
 * surfaces `data` as a wide structural type; we own the keys we put on it.
 */
function wsData(ws: { data: unknown }): WebSocketData {
  return ws.data as WebSocketData;
}

export function setupWebSocket(app: Elysia): void {
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
      const mark = userChangeMark();
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
      if (userId) {
        const untrack = trackUserSocket(userId, ws, mark);
        if (!untrack) return;
        wsData(ws).untrack = untrack;
      }
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
      wsData(ws).untrack?.();
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
