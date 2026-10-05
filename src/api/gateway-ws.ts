import type { Elysia } from '@/api/http';
import { getConfig } from '@/config';
import { assertDocLimits } from '@/core/docs/hub';
import { getGatewayHub } from '@/core/gateway/hub';
import { getSessionManager } from '@/security/auth/session';
import { getOrgWorkspaceManager } from '@/security/orgs';
import { clientIp } from '@/security/client-ip';
import { apiLogger } from '@/utils/logger';

/** RFC 4122 UUID, case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The workspace a gateway connection works in: the one its `?workspace=`
 * names (a workspace id or slug the user owns), else the user's default.
 * Null when the hint names none of the user's workspaces: the sign-in
 * fails rather than silently landing in another workspace.
 */
export async function resolveConnectionWorkspace(userId: string, hint: string | undefined): Promise<string | null> {
  const mgr = getOrgWorkspaceManager();
  const trimmed = hint?.trim();
  if (!trimmed) return (await mgr.ensureDefaultWorkspace(userId)).id;
  const ws = UUID_RE.test(trimmed)
    ? await mgr.findOwnedById(userId, trimmed)
    : await mgr.findOwnedBySlug(userId, trimmed);
  return ws?.id ?? null;
}

/**
 * Set up the /gateway WebSocket endpoint on the Elysia server: the one socket
 * the web (one connection per tab) and the TUI speak. The browser extension
 * (`/ws/browser-bridge`) and voice (`/voice`) keep their own sockets.
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

  hub.setWorkspaceResolver(resolveConnectionWorkspace);

  // Read once, at startup: a frame over it closes the socket (1009). Clients
  // are told this same number in `auth_ok`, not a later config value the
  // socket does not enforce.
  const maxFrameBytes = getConfig().gateway.maxFrameBytes;
  // A full `doc.sync` must fit one frame (live documents, §7.3): refuse to
  // start with a note size the frame cannot carry.
  assertDocLimits(getConfig().spaces.noteMaxBytes, maxFrameBytes);
  hub.connectionManager.setMaxFrameBytes(maxFrameBytes);

  app.ws('/gateway', {
    maxPayload: maxFrameBytes,
    open(ws) {
      // Forwarded headers count only when the peer is a trusted proxy.
      const ip = clientIp(ws.data.request, ws.remoteAddress);

      // The TUI names its workspace in the socket URL (`?workspace=`); it is
      // resolved for the user at auth.
      const workspace = new URL(ws.data.request.url).searchParams.get('workspace') ?? undefined;
      const connectionId = hub.connectionManager.handleOpen(ws as any, ip, workspace);
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

      // Elysia/Bun WS can deliver Buffer, ArrayBuffer, string, or object (auto-parsed)
      let raw: string;
      if (typeof message === 'string') {
        raw = message;
      } else if (typeof message === 'object' && message !== null && !(message instanceof Buffer) && !(message instanceof Uint8Array)) {
        // Elysia may auto-parse JSON — re-stringify it
        raw = JSON.stringify(message);
      } else if (message instanceof Buffer || message instanceof Uint8Array) {
        raw = new TextDecoder().decode(message);
      } else {
        raw = String(message);
      }
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
