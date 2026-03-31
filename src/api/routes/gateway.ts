import { Elysia } from 'elysia';
import { apiContext } from '@/api/context';
import { getGatewayHub } from '@/core/gateway/hub';

export const gatewayRoutes = new Elysia({ prefix: '/gateway' })
  .use(apiContext)

  // Gateway hub status
  .get('/status', async ({ user }) => {
    if (!user) return { error: 'Not authenticated' };

    const hub = getGatewayHub();
    return hub.getStatus();
  }, { detail: { tags: ['gateway'] } })

  // Active connections
  .get('/connections', async ({ user }) => {
    if (!user?.isAdmin) return { error: 'Admin required' };

    const hub = getGatewayHub();
    const connections = hub.connectionManager.getActiveConnections();

    return {
      connections: connections.map(c => ({
        connectionId: c.connectionId,
        userId: c.userId,
        clientType: c.clientType,
        trustLevel: c.trustLevel,
        ip: c.ip,
        connectedAt: new Date(c.connectedAt).toISOString(),
        lastActivityAt: new Date(c.lastActivityAt).toISOString(),
        idleMs: Date.now() - c.lastActivityAt,
      })),
      total: connections.length,
    };
  }, { detail: { tags: ['gateway'] } })

  // Event bus stats
  .get('/events/stats', async ({ user }) => {
    if (!user) return { error: 'Not authenticated' };

    const hub = getGatewayHub();
    return hub.eventBus.getStats();
  }, { detail: { tags: ['gateway'] } })

  // Channel adapter status
  .get('/adapters', async ({ user }) => {
    if (!user) return { error: 'Not authenticated' };

    // Return status of known channel types
    try {
      const { getUMI } = await import('@/channels/interface');
      const umi = getUMI();
      const channels = umi.getAllChannels();

      return {
        adapters: channels.map(ch => ({
          type: ch.type,
          name: ch.name,
          connected: ch.isConnected(),
        })),
      };
    } catch {
      return { adapters: [] };
    }
  }, { detail: { tags: ['gateway'] } });
