import { Elysia, t } from 'elysia';
import { networkInterfaces } from 'os';
import { apiContext } from '@/api/context';
import { getSessionManager } from '@/security/auth/session';
import { apiLogger } from '@/utils/logger';
import { randomBytes } from 'crypto';
import { getRedis } from '@/db/redis';
import { getSettingsService } from '@/config/settings-service';

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
      const redis = getRedis();

      const pairingData = JSON.stringify({
        userId: user.id,
        username: user.username,
        isAdmin: user.isAdmin,
        createdAt: new Date().toISOString(),
      });

      await redis.set(`${PAIRING_CODE_PREFIX}${code}`, pairingData, 'EX', PAIRING_CODE_TTL);

      apiLogger.info({ userId: user.id }, 'Device pairing code generated');

      const lanIp = getLanIp();
      const port = process.env.PORT || process.env.API_PORT || 3005;
      const lanUrl = lanIp ? `http://${lanIp}:${port}` : null;

      // Include public URL for remote connections (Cloudflare Tunnel etc.)
      const settings = getSettingsService();
      const publicUrl = (await settings.get('oauth.publicUrl') as string) || null;

      return { code, expiresIn: PAIRING_CODE_TTL, serverUrl: lanUrl, publicUrl };
    },
    { detail: { tags: ['devices'] } }
  )

  // Redeem a pairing code (unauthenticated — called from mobile app)
  .post(
    '/pair/redeem',
    async ({ body, request, set }) => {
      const { code, deviceName } = body;
      const redis = getRedis();

      const pairingDataRaw = await redis.get(`${PAIRING_CODE_PREFIX}${code}`);
      if (!pairingDataRaw) {
        set.status = 400;
        return { error: 'Invalid or expired pairing code' };
      }

      // Delete the code immediately (one-time use)
      await redis.del(`${PAIRING_CODE_PREFIX}${code}`);

      const pairingData = JSON.parse(pairingDataRaw);
      const sessionManager = getSessionManager();

      const ipAddress = request.headers.get('x-forwarded-for') || undefined;
      const userAgent = deviceName || request.headers.get('user-agent') || 'Mobile App';

      const { token, session } = await sessionManager.create(pairingData.userId, {
        ipAddress,
        userAgent: `Mobile: ${userAgent}`,
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
