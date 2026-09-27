import { createHmac, timingSafeEqual } from 'crypto';
import { Elysia, t } from '@/api/http';
import { getHookManager } from '@/hooks';
import type { TriggerContext, TriggerEvent } from '@/hooks/triggers';
import { apiLogger } from '@/utils/logger';

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
 *  - Each path-matched hook is verified against its own webhookSecret; only
 *    hooks whose signature verifies are fired. Hooks without a secret never fire.
 *  - If no matching hook verifies, the request is rejected with 401.
 *  - If no hook matches the path, the request is rejected with 404.
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

      // No hook claims this path: nothing was authenticated, so fire nothing.
      // (Falling through to trigger() used to run every user's webhook hook
      // that has no webhookPath, unauthenticated.)
      if (matchingHooks.length === 0) {
        return new Response(JSON.stringify({ error: 'Webhook not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Several users may register the same path. Each hook is verified on
      // its own secret, and only the hooks whose signature verifies fire, so
      // one user's hook can neither block nor ride along with another user's
      // correctly signed delivery. Hooks without a secret never fire here.
      const verifiedHooks = matchingHooks.filter((hook) => {
        const secret = hook.triggerConfig?.webhookSecret;
        if (!secret) {
          apiLogger.warn({ webhookPath, hookId: hook.id }, 'Webhook hook skipped: no webhookSecret configured');
          return false;
        }
        if (!verifyWebhookSignature(rawBody, secret, signatureHeader)) {
          apiLogger.warn({ webhookPath, hookId: hook.id }, 'Webhook signature verification failed');
          return false;
        }
        return true;
      });

      if (verifiedHooks.length === 0) {
        const anySecret = matchingHooks.some((hook) => hook.triggerConfig?.webhookSecret);
        const error = anySecret
          ? 'Invalid or missing webhook signature'
          : 'Webhook secret not configured. Set a webhookSecret on this hook.';
        return new Response(JSON.stringify({ error }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
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

      // Fire only the hooks whose signature was verified above.
      const results = [];
      for (const hook of verifiedHooks) {
        results.push(...(await hookManager.triggerHook(hook.id, event, context)));
      }

      const executed = results.filter(r => r.result?.success).length;
      const failed = results.filter(r => r.triggered && !r.result?.success).length;

      apiLogger.info({ webhookPath, executed, failed }, 'Webhook processed');

      return { received: true };
    },
    {
      params: t.Object({ path: t.String() }),
      detail: { tags: ['webhooks'] },
    },
  );
