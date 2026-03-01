import { Elysia, t } from 'elysia';
import { getHookManager } from '@/hooks';
import { apiLogger } from '@/utils/logger';
import type { TriggerEvent, TriggerContext } from '@/hooks/triggers';

/**
 * Webhook receiver — unauthenticated endpoint for external services
 * (GitHub, GitLab, etc.) to trigger hooks.
 *
 * Hooks match on `triggerConfig.webhookPath` against the `:path` param.
 */
export const webhookRoutes = new Elysia({ prefix: '/webhooks' })
  .post(
    '/:path',
    async ({ params, body, request }) => {
      const webhookPath = params.path;

      apiLogger.info({ webhookPath }, 'Webhook received');

      // Build trigger context from the incoming request
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const event: TriggerEvent = {
        type: 'webhook',
        data: { path: webhookPath, body },
        timestamp: new Date(),
      };

      const context: TriggerContext = {
        webhook: {
          path: webhookPath,
          method: 'POST',
          headers,
          body: body as unknown,
        },
      };

      const hookManager = getHookManager();
      const results = await hookManager.trigger(event, context);

      const executed = results.filter(r => r.result?.success).length;
      const failed = results.filter(r => r.triggered && !r.result?.success).length;

      apiLogger.info({ webhookPath, executed, failed }, 'Webhook processed');

      return {
        received: true,
        path: webhookPath,
        hooksTriggered: results.length,
        executed,
        failed,
      };
    },
    {
      params: t.Object({ path: t.String() }),
      detail: { tags: ['webhooks'] },
    },
  );
