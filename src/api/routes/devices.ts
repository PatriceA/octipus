import { randomBytes } from 'crypto';
import { Elysia, t } from '@/api/http';
import { networkInterfaces } from 'os';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { getSettingsService } from '@/config/settings-service';
import { rawStore } from '@/db/cache';
import { getPushService } from '@/core/push/fcm';
import { getSessionManager } from '@/security/auth/session';
import { apiLogger } from '@/utils/logger';

/** Get the first non-internal IPv4 address */
function getLanIp(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

const PAIRING_CODE_PREFIX = 'device:pair:';
const PAIRING_CODE_TTL = 300; // 5 minutes

export const deviceRoutes = new Elysia({ prefix: '/devices' })
  .use(apiContext)

  // Generate a pairing code (authenticated — called from web UI)
  .post(
    '/pair/generate',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const code = randomBytes(16).toString('hex');
      const store = rawStore();

      const pairingData = JSON.stringify({
        userId: user.id,
        username: user.username,
        isAdmin: user.isAdmin,
        createdAt: new Date().toISOString(),
      });

      await store.set(`${PAIRING_CODE_PREFIX}${code}`, pairingData, PAIRING_CODE_TTL);

      apiLogger.info({ userId: user.id }, 'Device pairing code generated');

      // The QR must point at an address the phone can reach. A backend bound
      // to loopback (API_HOST=127.0.0.1, the install default behind a
      // reverse proxy) would otherwise hand out a LAN URL that refuses every
      // connection; say so instead of letting the app fail with ECONNREFUSED.
      const { host, port } = getConfig().api;
      const loopbackOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      const lanIp = loopbackOnly ? null : getLanIp();
      const lanUrl = lanIp ? `http://${lanIp}:${port}` : null;
      const warning = loopbackOnly
        ? `The API listens on ${host} only, so phones on the LAN cannot reach it. Set API_HOST=0.0.0.0 (or a LAN address) and restart, or configure a public URL.`
        : lanIp ? null : 'No LAN address found on this host; only the public URL can be used.';

      // Include public URL for remote connections (Cloudflare Tunnel etc.)
      const settings = getSettingsService();
      const publicUrl = (await settings.get('oauth.publicUrl') as string) || null;

      return { code, expiresIn: PAIRING_CODE_TTL, serverUrl: lanUrl, publicUrl, warning };
    },
    { detail: { tags: ['devices'] } }
  )

  // Redeem a pairing code (unauthenticated — called from mobile app)
  .post(
    '/pair/redeem',
    async ({ body, request, set }) => {
      const { code, deviceName } = body;
      const store = rawStore();

      const pairingDataRaw = await store.get(`${PAIRING_CODE_PREFIX}${code}`);
      if (!pairingDataRaw) {
        set.status = 400;
        return { error: 'Invalid or expired pairing code' };
      }

      // Delete the code immediately (one-time use)
      await store.del(`${PAIRING_CODE_PREFIX}${code}`);

      const pairingData = JSON.parse(pairingDataRaw);
      const sessionManager = getSessionManager();

      const ipAddress = request.headers.get('x-forwarded-for') || undefined;
      const userAgent = deviceName || request.headers.get('user-agent') || 'Mobile App';

      const { token, session } = await sessionManager.create(pairingData.userId, {
        ipAddress,
        userAgent: `Mobile: ${userAgent}`,
        ttlMs: getConfig().security.mobileSessionMaxAge,
      });

      apiLogger.info(
        { userId: pairingData.userId, deviceName },
        'Mobile device paired successfully'
      );

      return {
        token,
        user: {
          id: pairingData.userId,
          username: pairingData.username,
          isAdmin: pairingData.isAdmin,
        },
        expiresAt: session.expiresAt,
      };
    },
    {
      body: t.Object({
        code: t.String(),
        deviceName: t.Optional(t.String()),
      }),
      detail: { tags: ['devices'] },
    }
  )

  // List paired devices / active mobile sessions
  .get(
    '/',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const sessionManager = getSessionManager();
      const sessions = await sessionManager.listForUserWithHashes(user.id);

      const mobileDevices = sessions
        .filter((s) => s.userAgent?.startsWith('Mobile:'))
        .map((s) => ({
          sessionId: s.id,
          deviceName: s.userAgent?.replace('Mobile: ', '') || 'Unknown Device',
          lastActivity: s.lastActivityAt,
          createdAt: s.createdAt,
          ipAddress: s.ipAddress,
        }));

      return { devices: mobileDevices };
    },
    { detail: { tags: ['devices'] } }
  )

  // Register (or refresh) this device's FCM token
  .put(
    '/push-token',
    async ({ body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      await getPushService().register(user.id, body.token, body.platform, body.deviceName);
      return { registered: true, pushConfigured: await getPushService().isConfigured() };
    },
    {
      body: t.Object({
        token: t.String({ minLength: 16, maxLength: 4096 }),
        platform: t.Union([t.Literal('android'), t.Literal('ios')]),
        deviceName: t.Optional(t.String({ maxLength: 120 })),
      }),
      detail: { tags: ['devices'] },
    }
  )

  // Forget this device's FCM token (logout / disconnect)
  .delete(
    '/push-token/:token',
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const removed = await getPushService().unregister(user.id, params.token);
      return { removed };
    },
    {
      params: t.Object({ token: t.String() }),
      detail: { tags: ['devices'] },
    }
  )

  // Revoke a device session
  .delete(
    '/:sessionId',
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const sessionManager = getSessionManager();
      const success = await sessionManager.revokeByHash(user.id, params.sessionId);

      if (!success) {
        set.status = 404;
        return { error: 'Device session not found or access denied' };
      }

      apiLogger.info({ userId: user.id }, 'Mobile device session revoked');

      return { success: true };
    },
    {
      params: t.Object({ sessionId: t.String() }),
      detail: { tags: ['devices'] },
    }
  );
