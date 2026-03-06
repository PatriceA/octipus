import { Elysia, t } from 'elysia';
import { createHmac, timingSafeEqual } from 'crypto';
import { getHookManager } from '@/hooks';
import { apiLogger } from '@/utils/logger';
import type { TriggerEvent, TriggerContext } from '@/hooks/triggers';

/**
 * Verify HMAC-SHA256 signature from the X-Hub-Signature-256 header.
 * Returns true when the signature is valid, false otherwise.
 */
function verifyWebhookSignature(
  payload: string,
  secret: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) {
    return false;
  }

  // Header format: "sha256=<hex digest>"
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    return false;
  }

  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(parts[1], 'hex');

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Webhook receiver — endpoint for external services (GitHub, GitLab, etc.)
 * to trigger hooks.
 *
 * Hooks match on `triggerConfig.webhookPath` against the `:path` param.
 *
 * Signature verification (HMAC-SHA256 via X-Hub-Signature-256):
 *  - If a matching hook has a webhookSecret configured and the signature is
 *    missing or invalid, the request is rejected with 401.
 *  - If no hook has a webhookSecret, the request is processed with a warning
 *    (backward compatibility).
 */
export const webhookRoutes = new Elysia({ prefix: '/webhooks' })
  .post(
    '/:path',
    async ({ params, body, request }) => {
      const webhookPath = params.path;

      apiLogger.info({ webhookPath }, 'Webhook received');

      const hookManager = getHookManager();

      // --- Signature verification ---
      const matchingHooks = hookManager.getWebhookHooksByPath(webhookPath);
      const rawBody = JSON.stringify(body);
      const signatureHeader = request.headers.get('x-hub-signature-256');

      for (const hook of matchingHooks) {
        const secret = hook.triggerConfig?.webhookSecret;

        if (secret) {
          // Secret is configured — signature MUST be present and valid
          if (!verifyWebhookSignature(rawBody, secret, signatureHeader)) {
            apiLogger.warn(
              { webhookPath, hookId: hook.id },
              'Webhook signature verification failed',
            );
            return new Response(JSON.stringify({ error: 'Invalid or missing webhook signature' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } else {
          // No secret configured — warn but allow (backward compatibility)
          apiLogger.warn(
            { webhookPath, hookId: hook.id },
            'Webhook hook has no secret configured — skipping signature verification',
          );
        }
      }

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
