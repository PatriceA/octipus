import type { Elysia } from 'elysia';
import { getGatewayHub } from '@/core/gateway/hub';
import { getSessionManager } from '@/security/auth/session';
import { apiLogger } from '@/utils/logger';

/**
 * Set up the /gateway WebSocket endpoint on the Elysia server.
 * This is the new unified gateway protocol — clients connect here
 * instead of the legacy /ws, /ws/permissions, /ws/browser-bridge endpoints.
 */
export function setupGatewayWebSocket(app: Elysia): void {
  const hub = getGatewayHub();

  // Wire session validator
  hub.setSessionValidator(async (token: string) => {
    const sessionManager = getSessionManager();
    const session = await sessionManager.validate(token);
    if (!session) return null;
    return {
      userId: session.userId,
      username: session.username,
      isAdmin: session.isAdmin,
    };
  });

  app.ws('/gateway', {
    open(ws) {
      const url = new URL(ws.data.request.url);
      const ip = ws.data.request.headers.get('x-forwarded-for')
        || ws.data.request.headers.get('x-real-ip')
        || ws.remoteAddress
        || '127.0.0.1';

      const connectionId = hub.connectionManager.handleOpen(ws as any, ip);
      if (!connectionId) {
        ws.close(4003, 'Connection rejected');
        return;
      }

      // Store connectionId in ws data for message/close routing
      (ws.data as any).gatewayConnectionId = connectionId;

      apiLogger.debug({ connectionId, ip }, 'Gateway WS connection opened');
    },

    async message(ws, message) {
      const connectionId = (ws.data as any).gatewayConnectionId as string;
      if (!connectionId) return;

      const raw = typeof message === 'string' ? message : String(message);
      await hub.connectionManager.handleMessage(connectionId, raw);
    },

    close(ws, code, reason) {
      const connectionId = (ws.data as any).gatewayConnectionId as string;
      if (!connectionId) return;

      hub.connectionManager.handleClose(connectionId, code, typeof reason === 'string' ? reason : undefined);
      apiLogger.debug({ connectionId, code }, 'Gateway WS connection closed');
    },
  });
}
