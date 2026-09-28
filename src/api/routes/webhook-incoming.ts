import { and, eq } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { getDb } from '@/db/postgres';
import { hooks } from '@/db/schema/hooks';
import {
  acquireRunSlots,
  claimDelivery,
  fireWebhookHook,
  getDeliveryId,
  RETRY_AFTER_SECONDS,
  runInBackground,
} from '@/hooks/webhook-delivery';
import { secureCompare } from '@/utils/crypto';
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
 *
 * The request is answered 202 once authenticated and the action runs in the
 * background (results go to the hook's execution log). Past the concurrency
 * caps (2 runs per hook, 20 overall) the answer is 429 with Retry-After. A
 * delivery id (X-GitHub-Delivery, Idempotency-Key, ...) is claimed per hook;
 * a repeat is answered 200 `{duplicate: true}` without firing. See
 * docs/WEBHOOKS.md.
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

        // Constant-time compares; evaluate both so timing doesn't reveal which
        // header was tried.
        const bearerOk = bearerToken !== null && secureCompare(bearerToken, webhookSecret);
        const headerOk = headerSecret !== null && secureCompare(headerSecret, webhookSecret);
        if (!bearerOk && !headerOk) {
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

      // Concurrency caps, before the delivery id is claimed, so a 429'd
      // delivery is still new when the sender retries it.
      const [slot] = acquireRunSlots([hook.id]) ?? [];
      if (!slot) {
        apiLogger.warn({ hookId }, 'Incoming webhook rejected: too many runs in progress');
        set.status = 429;
        set.headers['Retry-After'] = String(RETRY_AFTER_SECONDS);
        return { error: 'Too many webhook runs in progress; retry later' };
      }

      // Idempotency: a redelivery with the same delivery id is acknowledged
      // without firing the hook again.
      const deliveryId = getDeliveryId(request.headers);
      if (deliveryId && !(await claimDelivery(hook.id, deliveryId))) {
        slot.release();
        apiLogger.info({ hookId, deliveryId }, 'Duplicate incoming webhook delivery ignored');
        return { status: 'duplicate', duplicate: true, hookId: hook.id, hookName: hook.name };
      }

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

      // Pass hookId in event.data so matchesTrigger targets only this hook
      // (same pattern as the schedule trigger).
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

      // Trigger through the standard HookManager pipeline, in the background:
      // the action can be a full agent turn, and senders time out (GitHub
      // after ~10s) and redeliver, which would start duplicate runs.
      runInBackground(
        { hookId, deliveryId },
        () =>
          fireWebhookHook({
            hook,
            event,
            context,
            deliveryId,
            failureContext: { webhook: { hookId, deliveryId, body: payload } },
          }),
        slot,
      );

      set.status = 202;
      return {
        status: 'accepted',
        accepted: true,
        hookId: hook.id,
        hookName: hook.name,
        hooks: 1,
      };
    },
    {
      params: t.Object({ hookId: t.String() }),
      detail: { tags: ['webhooks'], summary: 'Receive incoming webhook by hook ID' },
    },
  );
