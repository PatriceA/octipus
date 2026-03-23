import { Elysia, t } from 'elysia';
import { eq, and } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { hooks } from '@/db/schema/hooks';
import { hookExecutions } from '@/db/schema/hook-executions';
import { apiLogger } from '@/utils/logger';

/**
 * Simple Mustache-style template rendering.
 * Supports `{{path.to.value}}` syntax with dot-notation traversal.
 */
function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const keys = path.trim().split('.');
    let value: unknown = data;
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = (value as Record<string, unknown>)[key];
      } else {
        return '';
      }
    }
    return value !== undefined && value !== null ? String(value) : '';
  });
}

/**
 * Incoming webhook routes — receive external HTTP calls and trigger hook actions.
 *
 * These endpoints are unauthenticated (no Bearer JWT required).
 * Authentication is performed via the hook's own webhookSecret:
 *   - `Authorization: Bearer <secret>` header
 *   - `X-Webhook-Secret: <secret>` header
 *
 * The hook's configured action (notify, spawn_agent, etc.) is executed
 * through the standard HookManager trigger pipeline, ensuring cooldown,
 * max-execution limits, condition checks, and execution logging all work.
 */
export const webhookIncomingRoutes = new Elysia({ prefix: '/hooks/incoming' })
  .post(
    '/:hookId',
    async ({ params, body, request, set }) => {
      const { hookId } = params;
      const db = getDb();

      // Find the hook by ID
      const [hook] = await db
        .select()
        .from(hooks)
        .where(and(eq(hooks.id, hookId), eq(hooks.isEnabled, true)))
        .limit(1);

      if (!hook) {
        set.status = 404;
        return { error: 'Webhook not found or disabled' };
      }

      // Verify trigger type is webhook
      if (hook.trigger !== 'webhook') {
        set.status = 400;
        return { error: 'Hook is not a webhook trigger' };
      }

      // Authenticate via webhook secret
      const triggerConfig = hook.triggerConfig;
      const webhookSecret = triggerConfig?.webhookSecret;

      if (webhookSecret) {
        const authHeader = request.headers.get('authorization');
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const headerSecret = request.headers.get('x-webhook-secret');

        if (bearerToken !== webhookSecret && headerSecret !== webhookSecret) {
          apiLogger.warn({ hookId }, 'Incoming webhook auth failed');
          set.status = 401;
          return { error: 'Invalid webhook secret' };
        }
      } else {
        // No secret configured — reject for security
        apiLogger.warn({ hookId }, 'Incoming webhook rejected: no webhookSecret configured');
        set.status = 401;
        return { error: 'Webhook secret not configured. Set a webhookSecret in the hook triggerConfig.' };
      }

      apiLogger.info({ hookId, hookName: hook.name }, 'Incoming webhook received');

      // Build request headers map for context
      const reqHeaders: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        reqHeaders[key] = value;
      });

      const payload = body as Record<string, unknown>;

      // If a messageTemplate is configured, render it and inject into the
      // webhook body so downstream actions (spawn_agent, etc.) can use it.
      let renderedMessage: string | undefined;
      if (triggerConfig.messageTemplate) {
        renderedMessage = renderTemplate(triggerConfig.messageTemplate, {
          body: payload,
          headers: reqHeaders,
        });
      }

      // Trigger through the standard HookManager pipeline.
      // Pass hookId in event.data so matchesTrigger targets only this hook
      // (same pattern as the schedule trigger).
      try {
        const { getHookManager } = await import('@/hooks/manager');
        const hookManager = getHookManager();

        const event = {
          type: 'webhook' as const,
          data: { hookId, body: payload, renderedMessage },
          timestamp: new Date(),
        };

        const context = {
          webhook: {
            path: triggerConfig.webhookPath || hookId,
            method: 'POST',
            headers: reqHeaders,
            body: renderedMessage
              ? { ...payload, _renderedMessage: renderedMessage }
              : payload,
          },
        };

        const results = await hookManager.trigger(event, context);

        const executed = results.filter(r => r.triggered).length;
        const succeeded = results.filter(r => r.result?.success).length;
        const failed = results.filter(r => r.triggered && !r.result?.success).length;

        apiLogger.info(
          { hookId, hookName: hook.name, executed, succeeded, failed },
          'Incoming webhook processed',
        );

        return {
          status: 'processed',
          hookId: hook.id,
          hookName: hook.name,
          executed,
          succeeded,
          failed,
          results: results.map(r => ({
            hookId: r.hookId,
            hookName: r.hookName,
            triggered: r.triggered,
            success: r.result?.success,
            error: r.error || r.result?.error,
            executionTime: r.executionTime,
          })),
        };
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        apiLogger.error({ err, hookId }, 'Incoming webhook processing failed');

        // Log failed execution
        try {
          await db.insert(hookExecutions).values({
            hookId: hook.id,
            source: 'hook',
            status: 'error',
            triggerType: 'webhook',
            actionType: hook.action,
            error: errorMessage,
            triggerContext: { webhook: { hookId, body: payload } },
          });
        } catch {}

        set.status = 500;
        return { error: 'Processing failed', message: errorMessage };
      }
    },
    {
      params: t.Object({ hookId: t.String() }),
      detail: { tags: ['webhooks'], summary: 'Receive incoming webhook by hook ID' },
    },
  );
