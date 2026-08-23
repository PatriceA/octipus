import { Elysia } from '@/api/http';
import { apiLogger } from '@/utils/logger';

/**
 * Teams webhook endpoint — unauthenticated (called by Azure Bot Framework).
 *
 * POST /api/channels/teams/webhook — incoming activities from Teams
 */
export const teamsWebhookRoutes = new Elysia({ prefix: '/channels/teams' })
  .post('/webhook', async ({ request, body }) => {
    const { getUMI } = await import('@/channels');
    const umi = getUMI();
    const channel = umi.getChannel('teams');

    if (!channel) {
      apiLogger.warn('Teams webhook received but channel not registered');
      return new Response('Service unavailable', { status: 503 });
    }

    const teams = channel as import('@/channels/teams').TeamsChannel;
    const authHeader = request.headers.get('authorization') || '';

    try {
      await teams.processActivityFromWebhook(body as any, authHeader);
      return new Response('OK', { status: 200 });
    } catch (error) {
      apiLogger.error({ error }, 'Failed to process Teams webhook activity');
      return new Response('Internal Server Error', { status: 500 });
    }
  }, {
    detail: { tags: ['channels'] },
  });
