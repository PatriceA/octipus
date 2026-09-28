/**
 * Shared plumbing for the two inbound webhook routes (`/api/webhooks/:path`
 * and `/api/hooks/incoming/:hookId`):
 *
 *  - signature checks over the exact request bytes, in constant time;
 *  - delivery-id idempotency, so a sender's redelivery (GitHub retries after
 *    ~10s without a response) doesn't start a second agent run;
 *  - running the hook actions in the background once the request has been
 *    accepted, the way the cron-runner fires scheduled hooks, through a
 *    bounded queue that is FIFO per hook and fair across users.
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
 * instead of blocking it for a day. Restarted when a queued run starts, and
 * extended to the done TTL on completion.
 */
export const DELIVERY_IN_PROGRESS_TTL_SECONDS = 15 * 60;

/** Upper bound on the fallback LRU, so a flood of ids can't grow memory. */
const LRU_MAX_ENTRIES = 10_000;

/** Seconds a sender is asked to wait when a run queue is full (503). */
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

/**
 * Restart a queued delivery's in_progress TTL as its run starts, so time
 * spent in the queue doesn't eat into the window that protects the run.
 */
export async function refreshDelivery(hookId: string, deliveryId: string): Promise<void> {
  const key = dedupeKey(hookId, deliveryId);
  try {
    await getStorageProvider().setRaw(key, 'in_progress', DELIVERY_IN_PROGRESS_TTL_SECONDS);
  } catch (err) {
    apiLogger.warn({ err, hookId }, 'Webhook dedupe store unavailable while refreshing a delivery');
    fallbackSet(key, DELIVERY_IN_PROGRESS_TTL_SECONDS);
  }
}

/**
 * The queue entry for one claimed hook run: refresh the claim when it
 * starts, release it if the run is dropped at shutdown.
 */
export function webhookRunJob(run: WebhookRun, label: Record<string, unknown>): QueuedRun {
  const { hook, deliveryId } = run;
  return {
    label,
    run: () => fireWebhookHook(run),
    onStart: deliveryId ? () => refreshDelivery(hook.id, deliveryId) : undefined,
    onDrop: deliveryId ? () => releaseDelivery(hook.id, deliveryId) : undefined,
  };
}

/** Test helper: clear the fallback LRU. */
export function _resetDeliveryCache(): void {
  fallback.clear();
}

// --- Run queue -----------------------------------------------------------
//
// Accepted deliveries are queued, never rejected for being busy: GitHub,
// GitLab and Gitea don't retry on their own, so turning a delivery away
// loses the event. The queue runs them under three limits:
//  - per hook: at most `perHook` running, FIFO;
//  - per user (hook owner): at most `perUser` running;
//  - global: at most `global` running, handed out round-robin across users,
//    so one user's backlog can't hold every slot.
// Only the queue bounds (`hookPending` per hook, `userPending` per user) turn
// a delivery away (503), before its delivery id is claimed.

const DEFAULT_LIMITS = {
  perHook: 2,
  perUser: 4,
  global: 20,
  hookPending: 50,
  userPending: 200,
};
let limits = { ...DEFAULT_LIMITS };

export interface QueuedRun {
  /** Log fields for a failure. */
  label: Record<string, unknown>;
  run: () => Promise<void>;
  /** Called when the run leaves the queue and starts (e.g. refresh the claim). */
  onStart?: () => Promise<void>;
  /** Called when a pending run is dropped at shutdown (e.g. release the claim). */
  onDrop?: () => Promise<void>;
}

interface Job extends QueuedRun {
  hookId: string;
  userId: string;
}

export interface QueueTicket {
  /** Queue the run this ticket reserved room for. Call once. */
  submit(run: QueuedRun): void;
  /** Give the reserved room back without queueing anything. */
  cancel(): void;
}

/** Queued + reserved (not yet submitted) runs, per hook and per user. */
const hookPending = new Map<string, number>();
const userPending = new Map<string, number>();
const hookRunning = new Map<string, number>();
const userRunning = new Map<string, number>();
let globalRunning = 0;
/** Per-user FIFO of queued jobs. A hook belongs to one user, so this is FIFO per hook too. */
const userQueues = new Map<string, Job[]>();
/** Users with queued jobs, in round-robin order. */
let userOrder: string[] = [];
let rrNext = 0;
let accepting = true;
const running = new Set<Promise<void>>();
/** Resolvers of callers waiting for the queue to go idle. */
let idleWaiters: Array<() => void> = [];

const inc = (m: Map<string, number>, k: string, by = 1) => {
  const v = (m.get(k) ?? 0) + by;
  if (v > 0) m.set(k, v);
  else m.delete(k);
};

/**
 * Reserve queue room for one run per item, all or nothing, synchronously (so
 * concurrent requests can't overshoot a bound). Returns null — answer 503 —
 * when a hook's or a user's queue bound would be exceeded, or while shutting
 * down. Call before claiming the delivery id.
 */
export function reserveQueueSlots(items: Array<{ hookId: string; userId: string }>): QueueTicket[] | null {
  if (!accepting) return null;
  const perHook = new Map<string, number>();
  const perUser = new Map<string, number>();
  for (const { hookId, userId } of items) {
    inc(perHook, hookId);
    inc(perUser, userId);
  }
  for (const [id, n] of perHook) if ((hookPending.get(id) ?? 0) + n > limits.hookPending) return null;
  for (const [id, n] of perUser) if ((userPending.get(id) ?? 0) + n > limits.userPending) return null;

  return items.map(({ hookId, userId }) => {
    inc(hookPending, hookId);
    inc(userPending, userId);
    let used = false;
    const giveBack = () => {
      inc(hookPending, hookId, -1);
      inc(userPending, userId, -1);
    };
    return {
      submit(run: QueuedRun) {
        if (used) return;
        used = true;
        if (!accepting) {
          // Shutdown began after the reservation: drop it like a pending run.
          giveBack();
          void run.onDrop?.().catch(() => {});
          return;
        }
        const queue = userQueues.get(userId) ?? [];
        if (queue.length === 0) {
          userQueues.set(userId, queue);
          if (!userOrder.includes(userId)) userOrder.push(userId);
        }
        queue.push({ ...run, hookId, userId });
        pump();
      },
      cancel() {
        if (used) return;
        used = true;
        giveBack();
        notifyIdle();
      },
    };
  });
}

/** Index of the first queued job of `userId` that may start now, or -1. */
function runnableIndex(userId: string): number {
  if ((userRunning.get(userId) ?? 0) >= limits.perUser) return -1;
  const queue = userQueues.get(userId);
  if (!queue) return -1;
  const blocked = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (blocked.has(job.hookId)) continue;
    if ((hookRunning.get(job.hookId) ?? 0) >= limits.perHook) {
      // Keep per-hook FIFO: nothing later for this hook may jump ahead.
      blocked.add(job.hookId);
      continue;
    }
    return i;
  }
  return -1;
}

function removeUser(userId: string): void {
  userQueues.delete(userId);
  const idx = userOrder.indexOf(userId);
  if (idx < 0) return;
  userOrder.splice(idx, 1);
  if (idx < rrNext) rrNext--;
  if (rrNext >= userOrder.length) rrNext = 0;
}

/**
 * Start queued jobs while global slots are free. Each free slot goes to the
 * user with a runnable job and the fewest runs in progress (fair share);
 * ties go round-robin from `rrNext`. So a user who already holds slots
 * yields the next one to a user waiting behind them.
 */
function pump(): void {
  while (globalRunning < limits.global && userOrder.length > 0) {
    const n = userOrder.length;
    let bestIdx = -1;
    let bestJob = -1;
    let bestRunning = Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      const idx = (rrNext + k) % n;
      const userId = userOrder[idx];
      const jobIdx = runnableIndex(userId);
      if (jobIdx < 0) continue;
      const busy = userRunning.get(userId) ?? 0;
      if (busy < bestRunning) {
        bestRunning = busy;
        bestIdx = idx;
        bestJob = jobIdx;
      }
    }
    if (bestIdx < 0) break;
    const userId = userOrder[bestIdx];
    const queue = userQueues.get(userId)!;
    const [job] = queue.splice(bestJob, 1);
    // Next tie goes to the user after this one.
    rrNext = (bestIdx + 1) % n;
    if (queue.length === 0) removeUser(userId);
    start(job);
  }
  notifyIdle();
}

function start(job: Job): void {
  inc(hookPending, job.hookId, -1);
  inc(userPending, job.userId, -1);
  inc(hookRunning, job.hookId);
  inc(userRunning, job.userId);
  globalRunning++;
  const p: Promise<void> = (async () => {
    try {
      if (job.onStart) {
        try {
          await job.onStart();
        } catch (err) {
          apiLogger.warn({ err, ...job.label }, 'Webhook run start hook failed');
        }
      }
      await job.run();
    } catch (err) {
      apiLogger.error({ err, ...job.label }, 'Background webhook processing failed');
    }
  })();
  running.add(p);
  // p never rejects (the body catches everything).
  void p.then(() => {
    inc(hookRunning, job.hookId, -1);
    inc(userRunning, job.userId, -1);
    globalRunning--;
    running.delete(p);
    pump();
  });
}

function isIdle(): boolean {
  return running.size === 0 && userOrder.length === 0 && hookPending.size === 0;
}

function notifyIdle(): void {
  if (!isIdle() || idleWaiters.length === 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const w of waiters) w();
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number | undefined, onTimeout: T): Promise<T> {
  if (timeoutMs === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Wait until nothing is queued or running (tests). With a timeout, returns
 * false if that didn't happen in time.
 */
export function drainWebhookTasks(timeoutMs?: number): Promise<boolean> {
  const idle = isIdle()
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => idleWaiters.push(() => resolve(true)));
  return withTimeout(idle, timeoutMs, false);
}

/**
 * Shutdown: stop accepting, drop every pending run and release its claim
 * (so the sender's redelivery runs later), then give the running ones up to
 * `timeoutMs`. Returns false if runs were still going at the deadline.
 */
export async function shutdownWebhookTasks(timeoutMs: number): Promise<boolean> {
  accepting = false;
  const deadline = Date.now() + timeoutMs;
  const dropped: Job[] = [];
  for (const queue of userQueues.values()) dropped.push(...queue);
  for (const job of dropped) {
    inc(hookPending, job.hookId, -1);
    inc(userPending, job.userId, -1);
  }
  userQueues.clear();
  userOrder = [];
  rrNext = 0;
  if (dropped.length > 0) apiLogger.warn({ count: dropped.length }, 'Dropping queued webhook runs at shutdown');
  const releases = Promise.allSettled(dropped.map((job) => job.onDrop?.())).then(() => true);
  await withTimeout(releases, Math.max(0, deadline - Date.now()), false);
  const runs = (async () => {
    while (running.size > 0) await Promise.allSettled([...running]);
    return true;
  })();
  return withTimeout(runs, Math.max(0, deadline - Date.now()), false);
}

/** Test helper: override limits (no argument restores the defaults) and accept again after a shutdown. */
export function _setRunLimits(overrides: Partial<typeof DEFAULT_LIMITS> = {}): void {
  limits = { ...DEFAULT_LIMITS, ...overrides };
  accepting = true;
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
 * the run queue (see {@link webhookRunJob}). Settles the delivery claim:
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
