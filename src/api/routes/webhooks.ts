import { Elysia, t } from '@/api/http';
import { getHookManager } from '@/hooks';
import type { TriggerContext, TriggerEvent } from '@/hooks/triggers';
import {
  acquireRunSlots,
  claimDelivery,
  fireWebhookHook,
  getDeliveryId,
  RETRY_AFTER_SECONDS,
  runInBackground,
  verifyHmacSha256,
} from '@/hooks/webhook-delivery';
import { apiLogger } from '@/utils/logger';

/** The request body exactly as sent. */
async function readRawBody(request: Request): Promise<Uint8Array> {
  try {
    return new Uint8Array(await request.arrayBuffer());
  } catch {
    return new Uint8Array();
  }
}

/**
 * The payload handed to hooks, parsed from the raw bytes that were verified.
 * JSON bodies are parsed directly; GitHub's form content type carries the JSON
 * in a `payload` field. Anything else falls back to the framework's parse.
 */
function parsePayload(raw: Uint8Array, contentType: string | null, fallback: unknown): unknown {
  const text = new TextDecoder().decode(raw);
  if (text === '') return fallback;
  const type = contentType ?? '';
  try {
    if (type.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(text);
      const inner = form.get('payload');
      return inner !== null ? JSON.parse(inner) : Object.fromEntries(form);
    }
    return JSON.parse(text);
  } catch {
    return fallback ?? text;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
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
 *  - The signature is checked over the raw request bytes.
 *
 * Once verified, the request is answered 202 and the hook actions run in the
 * background (results go to the hook's execution log). Each hook runs at
 * most 2 deliveries at once, 20 across all hooks; past that the answer is
 * 429 with Retry-After. A delivery id (X-GitHub-Delivery, Idempotency-Key,
 * ...) is claimed per hook; a repeat is answered 200 `{duplicate: true}`
 * without firing. See docs/WEBHOOKS.md.
 */
export const webhookRoutes = new Elysia({ prefix: '/webhooks' })
  .post(
    '/:path',
    async ({ params, body, request, set }) => {
      const webhookPath = params.path;

      apiLogger.info({ webhookPath }, 'Webhook received');

      const hookManager = getHookManager();
      const matchingHooks = hookManager.getWebhookHooksByPath(webhookPath);

      // No hook claims this path: nothing was authenticated, so fire nothing.
      // (Falling through to trigger() used to run every user's webhook hook
      // that has no webhookPath, unauthenticated.)
      if (matchingHooks.length === 0) {
        return json(404, { error: 'Webhook not found' });
      }

      // --- Signature verification ---
      // Verify over the exact bytes the sender signed, never a re-serialised
      // body: JSON.stringify(JSON.parse(raw)) drops escapes like < and
      // whitespace, so real GitHub signatures would not match. The framework
      // parsed a clone, so the original stream is still unread.
      const rawBytes = await readRawBody(request);
      const signatureHeader = request.headers.get('x-hub-signature-256');

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
        if (!verifyHmacSha256(rawBytes, secret, signatureHeader)) {
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
        return json(401, { error });
      }

      // --- Concurrency caps ---
      // Taken before the delivery id is claimed, so a 429'd delivery is
      // still new when the sender retries it.
      const slots = acquireRunSlots(verifiedHooks.map((hook) => hook.id));
      if (!slots) {
        apiLogger.warn({ webhookPath }, 'Webhook rejected: too many runs in progress');
        return json(
          429,
          { error: 'Too many webhook runs in progress; retry later' },
          { 'Retry-After': String(RETRY_AFTER_SECONDS) },
        );
      }

      // --- Idempotency ---
      // A sender that redelivers (GitHub retries on a slow response, or on
      // "Redeliver") reuses its delivery id. Claim it per hook, after
      // authentication, and fire only the hooks that haven't seen it.
      const deliveryId = getDeliveryId(request.headers);
      let toFire = verifiedHooks.map((hook, i) => ({ hook, slot: slots[i] }));
      if (deliveryId) {
        let claimed: boolean[];
        try {
          claimed = await Promise.all(verifiedHooks.map((hook) => claimDelivery(hook.id, deliveryId)));
        } catch (err) {
          for (const slot of slots) slot.release();
          throw err;
        }
        for (const [i, { slot }] of toFire.entries()) if (!claimed[i]) slot.release();
        toFire = toFire.filter((_, i) => claimed[i]);
        if (toFire.length === 0) {
          apiLogger.info({ webhookPath, deliveryId }, 'Duplicate webhook delivery ignored');
          return { received: true, duplicate: true };
        }
      }

      const payload = parsePayload(rawBytes, request.headers.get('content-type'), body);

      // Build trigger context from the incoming request
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const event: TriggerEvent = {
        type: 'webhook',
        data: { path: webhookPath, body: payload },
        timestamp: new Date(),
      };

      const context: TriggerContext = {
        webhook: {
          path: webhookPath,
          method: 'POST',
          headers,
          body: payload,
        },
      };

      // Respond now and run the actions (possibly a full agent turn) in the
      // background: senders like GitHub give up after ~10s and redeliver.
      for (const { hook, slot } of toFire) {
        runInBackground(
          { webhookPath, hookId: hook.id, deliveryId },
          () =>
            fireWebhookHook({
              hook,
              event,
              context,
              deliveryId,
              failureContext: { webhook: { path: webhookPath, deliveryId, body: payload } },
            }),
          slot,
        );
      }

      set.status = 202;
      return { received: true, accepted: true, hooks: toFire.length };
    },
    {
      params: t.Object({ path: t.String() }),
      detail: { tags: ['webhooks'] },
    },
  );
