/**
 * Shared plumbing for the two inbound webhook routes (`/api/webhooks/:path`
 * and `/api/hooks/incoming/:hookId`):
 *
 *  - signature / secret checks over the exact request bytes, in constant time;
 *  - delivery-id idempotency, so a sender's redelivery (GitHub retries after
 *    ~10s without a response) doesn't start a second agent run;
 *  - running the hook actions in the background once the request has been
 *    accepted, the way the cron-runner fires scheduled hooks.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getStorageProvider } from '@/db/storage';
import { apiLogger } from '@/utils/logger';

/** How long a delivery id is remembered per hook. */
export const DELIVERY_TTL_SECONDS = 24 * 60 * 60;

/** Upper bound on the in-process LRU, so a flood of ids can't grow memory. */
const LRU_MAX_ENTRIES = 10_000;

/**
 * Headers senders put a unique per-delivery id in, most specific first.
 * GitHub / Gitea / Gogs / GitLab / Svix-style senders and the generic
 * `Idempotency-Key` convention.
 */
const DELIVERY_ID_HEADERS = [
  'x-github-delivery',
  'x-gitea-delivery',
  'x-gogs-delivery',
  'x-gitlab-event-uuid',
  'x-gitlab-webhook-uuid',
  'svix-id',
  'webhook-id',
  'idempotency-key',
  'x-idempotency-key',
  'x-delivery-id',
  'x-request-id',
] as const;

/** Compare two strings in constant time (for equal lengths). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify an HMAC-SHA256 signature in the `sha256=<hex>` format
 * (`X-Hub-Signature-256`) over the raw request bytes. Signing the
 * re-serialised JSON instead would fail real GitHub deliveries, whose bytes
 * (escaped unicode, spacing, key order) don't round-trip through JSON.parse.
 */
export function verifyHmacSha256(
  rawBody: string | Uint8Array,
  secret: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!signatureHeader) return false;
  const sep = signatureHeader.indexOf('=');
  if (sep < 0) return false;
  const algo = signatureHeader.slice(0, sep).trim().toLowerCase();
  const hex = signatureHeader.slice(sep + 1).trim();
  if (algo !== 'sha256' || !/^[0-9a-fA-F]{64}$/.test(hex)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(hex, 'hex');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/** The sender's delivery id, if it supplied one. */
export function getDeliveryId(headers: Headers): string | null {
  for (const name of DELIVERY_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

// --- Idempotency ---------------------------------------------------------

/** hook+delivery key -> expiry (epoch ms). Map insertion order is LRU order. */
const recent = new Map<string, number>();

function lruHas(key: string): boolean {
  const expiresAt = recent.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    recent.delete(key);
    return false;
  }
  // Refresh recency.
  recent.delete(key);
  recent.set(key, expiresAt);
  return true;
}

function lruAdd(key: string): void {
  recent.delete(key);
  recent.set(key, Date.now() + DELIVERY_TTL_SECONDS * 1000);
  while (recent.size > LRU_MAX_ENTRIES) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

/** Hashed so an arbitrarily long / odd sender id can't blow up the key. */
function dedupeKey(hookId: string, deliveryId: string): string {
  const digest = createHash('sha256').update(deliveryId).digest('hex');
  return `webhook-delivery:${hookId}:${digest}`;
}

/**
 * Claim a delivery for a hook. Returns true for the first delivery with this
 * id within the TTL, false for a duplicate.
 *
 * Checked against the in-process LRU first, then claimed atomically in the
 * shared kv store (an INSERT ... ON CONFLICT increment on Postgres), so two
 * API processes don't both fire. If the store is unavailable, the LRU alone
 * decides — dedupe fails open rather than dropping deliveries.
 *
 * Only call this after the delivery has been authenticated, so an
 * unauthenticated caller can't burn delivery ids.
 */
export async function claimDelivery(hookId: string, deliveryId: string): Promise<boolean> {
  const key = dedupeKey(hookId, deliveryId);
  if (lruHas(key)) return false;
  lruAdd(key);

  try {
    const cache = getStorageProvider().createCache('', DELIVERY_TTL_SECONDS);
    const count = await cache.increment(key);
    if (count > 1) return false;
    await cache.expire(key, DELIVERY_TTL_SECONDS);
  } catch (err) {
    apiLogger.warn({ err, hookId }, 'Webhook dedupe store unavailable; using in-process dedupe only');
  }
  return true;
}

/**
 * Forget a claimed delivery, so a redelivery of a run that failed can retry.
 */
export async function releaseDelivery(hookId: string, deliveryId: string): Promise<void> {
  const key = dedupeKey(hookId, deliveryId);
  recent.delete(key);
  try {
    await getStorageProvider().createCache('', DELIVERY_TTL_SECONDS).delete(key);
  } catch (err) {
    apiLogger.warn({ err, hookId }, 'Webhook dedupe store unavailable while releasing a delivery');
  }
}

/** Test helper: clear the in-process LRU. */
export function _resetDeliveryCache(): void {
  recent.clear();
}

// --- Background execution ------------------------------------------------

const inFlight = new Set<Promise<void>>();

/**
 * Run a webhook's hook actions after the response has gone out. Errors are
 * caught and logged here; nothing propagates to the request.
 */
export function runInBackground(label: Record<string, unknown>, task: () => Promise<void>): void {
  const p: Promise<void> = Promise.resolve()
    .then(task)
    .catch((err: unknown) => apiLogger.error({ err, ...label }, 'Background webhook processing failed'))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** Wait for every background webhook task started so far (tests, shutdown). */
export async function drainWebhookTasks(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
