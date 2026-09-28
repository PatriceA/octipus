/**
 * Shared plumbing for the two inbound webhook routes (`/api/webhooks/:path`
 * and `/api/hooks/incoming/:hookId`):
 *
 *  - signature checks over the exact request bytes, in constant time;
 *  - delivery-id idempotency, so a sender's redelivery (GitHub retries after
 *    ~10s without a response) doesn't start a second agent run;
 *  - running the hook actions in the background once the request has been
 *    accepted, the way the cron-runner fires scheduled hooks, under a
 *    per-hook and a global concurrency cap.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hook } from '@/db/schema/hooks';
import { getStorageProvider } from '@/db/storage';
import { sha256 } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';
import type { TriggerContext, TriggerEvent } from './triggers';

/** How long a finished delivery id is remembered per hook. */
export const DELIVERY_DONE_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long a claimed-but-unfinished delivery id is held. Short, so a run
 * lost to a crash or shutdown frees the id for the sender's redelivery
 * instead of blocking it for a day. Extended to the done TTL on completion.
 */
export const DELIVERY_IN_PROGRESS_TTL_SECONDS = 15 * 60;

/** Upper bound on the fallback LRU, so a flood of ids can't grow memory. */
const LRU_MAX_ENTRIES = 10_000;

/** Seconds a sender is asked to wait when the run caps are reached. */
export const RETRY_AFTER_SECONDS = 30;

/**
 * Headers senders put a unique per-delivery id in, most specific first.
 * Vendor delivery ids plus the generic `Idempotency-Key` convention. Generic
 * request-tracing ids (X-Request-Id) are deliberately not used: proxies set
 * them per hop, and they don't identify a delivery.
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
] as const;

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
//
// The shared kv store is the only authority whenever it is reachable, so a
// claim, a completion or a release made by one process is seen by all. The
// in-process LRU is consulted only when the store errors, as a best-effort
// fallback (dedupe then only holds within this process).

/** key -> expiry (epoch ms). Map insertion order is LRU order. */
const fallback = new Map<string, number>();

function fallbackHas(key: string): boolean {
  const expiresAt = fallback.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    fallback.delete(key);
    return false;
  }
  return true;
}

function fallbackSet(key: string, ttlSeconds: number): void {
  fallback.delete(key);
  fallback.set(key, Date.now() + ttlSeconds * 1000);
  while (fallback.size > LRU_MAX_ENTRIES) {
    const oldest = fallback.keys().next().value;
    if (oldest === undefined) break;
    fallback.delete(oldest);
  }
}

/** Hashed so an arbitrarily long / odd sender id can't blow up the key. */
function dedupeKey(hookId: string, deliveryId: string): string {
  return `webhook-delivery:${hookId}:${sha256(deliveryId)}`;
}

/**
 * Claim a delivery for a hook: true for the first delivery with this id,
 * false for a duplicate. The claim is an atomic set-if-absent marked
 * `in_progress` with a short TTL; {@link completeDelivery} extends it once
 * the run is over, {@link releaseDelivery} frees it if nothing ran.
 *
 * Only call this after the delivery has been authenticated, so an
 * unauthenticated caller can't burn delivery ids.
 */
export async function claimDelivery(hookId: string, deliveryId: string): Promise<boolean> {
  const key = dedupeKey(hookId, deliveryId);
  try {
    return await getStorageProvider().setRawIfAbsent(key, 'in_progress', DELIVERY_IN_PROGRESS_TTL_SECONDS);
  } catch (err) {
    apiLogger.warn({ err, hookId }, 'Webhook dedupe store unavailable; using in-process dedupe only');
    if (fallbackHas(key)) return false;
    fallbackSet(key, DELIVERY_IN_PROGRESS_TTL_SECONDS);
    return true;
  }
}

/**
 * Mark a claimed delivery done: an action ran (successfully or not), so a
 * redelivery is dropped for the full TTL — its side effects may have
 * happened.
 */
export async function completeDelivery(hookId: string, deliveryId: string): Promise<void> {
  const key = dedupeKey(hookId, deliveryId);
  try {
    await getStorageProvider().setRaw(key, 'done', DELIVERY_DONE_TTL_SECONDS);
  } catch (err) {
    apiLogger.warn({ err, hookId }, 'Webhook dedupe store unavailable while completing a delivery');
    fallbackSet(key, DELIVERY_DONE_TTL_SECONDS);
  }
}

/**
 * Free a claimed delivery. Only for a run where no action started (the hook
 * was skipped, or triggerHook failed before executing), so a redelivery can
 * try again.
 */
export async function releaseDelivery(hookId: string, deliveryId: string): Promise<void> {
  const key = dedupeKey(hookId, deliveryId);
  fallback.delete(key);
  try {
    await getStorageProvider().delRaw(key);
  } catch (err) {
    apiLogger.warn({ err, hookId }, 'Webhook dedupe store unavailable while releasing a delivery');
  }
}

/** Test helper: clear the fallback LRU. */
export function _resetDeliveryCache(): void {
  fallback.clear();
}

// --- Concurrency caps ----------------------------------------------------

let perHookLimit = 2;
let globalLimit = 20;
const runningPerHook = new Map<string, number>();
let runningTotal = 0;

export interface RunSlot {
  hookId: string;
  /** Idempotent. */
  release(): void;
}

/**
 * Take one background-run slot for each hook, all or nothing, synchronously
 * (so two requests can't both pass the check). Returns null when a hook is at
 * its per-hook cap or the global cap would be exceeded — the caller answers
 * 429 so the sender retries later.
 */
export function acquireRunSlots(hookIds: string[]): RunSlot[] | null {
  if (runningTotal + hookIds.length > globalLimit) return null;
  const wanted = new Map<string, number>();
  for (const id of hookIds) wanted.set(id, (wanted.get(id) ?? 0) + 1);
  for (const [id, n] of wanted) {
    if ((runningPerHook.get(id) ?? 0) + n > perHookLimit) return null;
  }
  return hookIds.map((hookId) => {
    runningPerHook.set(hookId, (runningPerHook.get(hookId) ?? 0) + 1);
    runningTotal++;
    let released = false;
    return {
      hookId,
      release() {
        if (released) return;
        released = true;
        runningTotal--;
        const left = (runningPerHook.get(hookId) ?? 1) - 1;
        if (left > 0) runningPerHook.set(hookId, left);
        else runningPerHook.delete(hookId);
      },
    };
  });
}

/** Test helper: override the caps; call with no arguments to restore them. */
export function _setRunLimits(limits: { perHook?: number; global?: number } = {}): void {
  perHookLimit = limits.perHook ?? 2;
  globalLimit = limits.global ?? 20;
}

// --- Background execution ------------------------------------------------

const inFlight = new Set<Promise<void>>();

/**
 * Run a webhook's hook actions after the response has gone out. Errors are
 * caught and logged here; nothing propagates to the request. The slot, if
 * any, is released when the task settles.
 */
export function runInBackground(
  label: Record<string, unknown>,
  task: () => Promise<void>,
  slot?: RunSlot,
): void {
  const p: Promise<void> = Promise.resolve()
    .then(task)
    .catch((err: unknown) => apiLogger.error({ err, ...label }, 'Background webhook processing failed'))
    .finally(() => {
      slot?.release();
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/**
 * Wait for the background webhook tasks started so far. With a timeout,
 * gives up after `timeoutMs` and returns false if any are still running
 * (shutdown uses this to stay inside its exit budget).
 */
export async function drainWebhookTasks(timeoutMs?: number): Promise<boolean> {
  const drain = (async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    return true;
  })();
  if (timeoutMs === undefined) return drain;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([drain, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- One hook run --------------------------------------------------------

export interface WebhookRun {
  hook: Pick<Hook, 'id' | 'name' | 'action'>;
  event: TriggerEvent;
  context: TriggerContext;
  deliveryId: string | null;
  /** Stored as the trigger context of a failure row. */
  failureContext: Record<string, unknown>;
}

/**
 * Fire one verified hook for a webhook delivery; meant to run inside
 * {@link runInBackground}. Settles the delivery claim:
 *  - nothing ran (the hook was skipped by its gates, or triggerHook failed
 *    before executing the action) -> release, so a redelivery can retry;
 *  - an action ran, successfully or not -> done, so a redelivery is dropped
 *    (its side effects may already have happened).
 * Every failure lands in hook_executions: runHook logs action failures
 * itself, and a failure before the action is logged here.
 */
export async function fireWebhookHook(run: WebhookRun): Promise<void> {
  const { hook, event, context, deliveryId } = run;
  const { getHookManager } = await import('./manager');
  const manager = getHookManager();
  const started = Date.now();

  let results: Awaited<ReturnType<typeof manager.triggerHook>>;
  try {
    results = await manager.triggerHook(hook.id, event, context);
  } catch (err) {
    // runHook catches action errors, so a rejection means no action started.
    if (deliveryId) await releaseDelivery(hook.id, deliveryId);
    await manager.logExecution({
      hookId: hook.id,
      source: 'hook',
      status: 'error',
      triggerType: 'webhook',
      actionType: hook.action,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      triggerContext: run.failureContext,
    });
    throw err;
  }

  if (results.length === 0) {
    // Skipped (conditions, cooldown, maxExecutions, disabled): nothing ran.
    if (deliveryId) await releaseDelivery(hook.id, deliveryId);
    apiLogger.info({ hookId: hook.id, deliveryId }, 'Webhook hook skipped');
    return;
  }

  if (deliveryId) await completeDelivery(hook.id, deliveryId);
  const succeeded = results.filter((r) => r.result?.success).length;
  const failed = results.filter((r) => r.triggered && !r.result?.success).length;
  apiLogger.info({ hookId: hook.id, hookName: hook.name, deliveryId, succeeded, failed }, 'Webhook processed');
}
