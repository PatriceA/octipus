/**
 * Retry keys for work-creating calls (docs/plans/orchestration-gaps-2026-11.md §2).
 *
 * A caller that timed out (the MCP server aborts after 25 s while the turn
 * keeps running) or lost a response retries with the same key; the first
 * call's outcome is returned instead of creating the work a second time.
 *
 * Built on the same claim primitive as webhook delivery ids
 * (`src/hooks/webhook-delivery.ts`): an atomic set-if-absent in the shared kv
 * store, an `in_progress` marker with a short TTL renewed while the work runs,
 * replaced by the stored outcome for 24 h once it finishes. Keys are scoped to
 * (user, scope), so one user's key never answers another's call.
 *
 * A retry while the first call is still running joins it: in this process it
 * awaits the same promise, elsewhere it polls the store, either way up to
 * `joinWaitMs`. Past that it reports `in_progress` with whatever the first
 * call recorded so far (e.g. the session id), so a caller with its own short
 * timeout gets an answer before it gives up again.
 *
 * An outcome the caller marks as not worth keeping (a failure where nothing
 * was created) releases the key, so a retry runs again.
 */
import { randomUUID } from 'node:crypto';
import { getStorageProvider } from '@/db/storage';
import { DELIVERY_DONE_TTL_SECONDS, DELIVERY_IN_PROGRESS_TTL_SECONDS } from '@/hooks/webhook-delivery';
import { sha256 } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';

/** How long a finished call's outcome is kept (same as webhook delivery ids). */
export const IDEMPOTENCY_DONE_TTL_SECONDS = DELIVERY_DONE_TTL_SECONDS;
/** How long an unfinished claim is held without renewal: a crashed run frees its key. */
export const IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS = DELIVERY_IN_PROGRESS_TTL_SECONDS;
/** Renewal period for a running claim; well inside the TTL. */
const REFRESH_INTERVAL_MS = 5 * 60_000;
/** Default time a retry waits on a call still in flight before reporting `in_progress`. */
export const DEFAULT_JOIN_WAIT_MS = 20_000;
/** Longest accepted key. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const POLL_MS = 250;
const FALLBACK_MAX_ENTRIES = 2_000;

export interface IdempotencyTrack {
  /** Record what a retry should be told while this call is still running (e.g. `{ sessionId }`). */
  setMeta(meta: Record<string, unknown>): Promise<void>;
}

export type IdempotentOutcome<T> =
  /** This call ran the work. */
  | { kind: 'fresh'; value: T }
  /** An earlier call with this key finished; its stored outcome. */
  | { kind: 'replayed'; value: T }
  /** An earlier call with this key is still running. */
  | { kind: 'in_progress'; meta: Record<string, unknown> }
  /** The key was used for a different request. */
  | { kind: 'mismatch' };

export interface RunIdempotentOptions<T> {
  userId: string;
  /** What kind of call this is (`chat`, `agents.spawn`, …); keys are per scope. */
  scope: string;
  key: string;
  /** Identifies the request; a reuse of the key for different input is a `mismatch`. */
  fingerprint?: string;
  joinWaitMs?: number;
  run: (track: IdempotencyTrack) => Promise<T>;
  /** False releases the key instead of storing the outcome (nothing was created). Default: keep. */
  keep?: (value: T) => boolean;
}

interface Pending { s: 'p'; t: string; f?: string }
interface Done { s: 'd'; f?: string; v: unknown }
type Stored = Pending | Done;

// --- Store with in-process fallback ---------------------------------------
//
// The shared kv store is the authority whenever it is reachable; the local
// map is used only while it errors (dedupe then holds within this process).

const fallback = new Map<string, { value: string; expiresAt: number }>();

function fallbackGet(key: string): string | null {
  const entry = fallback.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { fallback.delete(key); return null; }
  return entry.value;
}

function fallbackSet(key: string, value: string, ttlSeconds: number): void {
  fallback.delete(key);
  fallback.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  while (fallback.size > FALLBACK_MAX_ENTRIES) {
    const oldest = fallback.keys().next().value;
    if (oldest === undefined) break;
    fallback.delete(oldest);
  }
}

function warn(err: unknown, op: string): void {
  apiLogger.warn({ err, op }, 'Idempotency store unavailable; using in-process dedupe only');
}

const kv = {
  async setIfAbsent(key: string, value: string, ttl: number): Promise<boolean> {
    try { return await getStorageProvider().setRawIfAbsent(key, value, ttl); } catch (err) {
      warn(err, 'claim');
      if (fallbackGet(key) !== null) return false;
      fallbackSet(key, value, ttl);
      return true;
    }
  },
  async renew(key: string, value: string, ttl: number): Promise<boolean> {
    try { return await getStorageProvider().setRawIfAbsentOrEqual(key, value, ttl); } catch (err) {
      warn(err, 'renew');
      const current = fallbackGet(key);
      if (current !== null && current !== value) return false;
      fallbackSet(key, value, ttl);
      return true;
    }
  },
  async get(key: string): Promise<string | null> {
    try { return await getStorageProvider().getRaw(key); } catch (err) {
      warn(err, 'read');
      return fallbackGet(key);
    }
  },
  async set(key: string, value: string, ttl: number): Promise<void> {
    try { await getStorageProvider().setRaw(key, value, ttl); } catch (err) {
      warn(err, 'store');
      fallbackSet(key, value, ttl);
    }
  },
  async del(key: string): Promise<void> {
    fallback.delete(key);
    try { await getStorageProvider().delRaw(key); } catch (err) { warn(err, 'release'); }
  },
};

/** Hashed so an arbitrary key can't blow up the store key or leak into it. */
function storeKey(userId: string, scope: string, key: string): string {
  return `idempotency:${scope}:${userId}:${sha256(key)}`;
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Stored;
    return value && (value.s === 'p' || value.s === 'd') ? value : null;
  } catch {
    return null;
  }
}

/** Calls running in this process, so a retry here joins the same promise. */
const inflight = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Run `run` once per (user, scope, key). See the module comment for the
 * retry semantics.
 */
export async function runIdempotent<T>(options: RunIdempotentOptions<T>): Promise<IdempotentOutcome<T>> {
  const { userId, scope, key, fingerprint } = options;
  const k = storeKey(userId, scope, key);
  const metaKey = `${k}:meta`;
  const deadline = Date.now() + (options.joinWaitMs ?? DEFAULT_JOIN_WAIT_MS);

  for (;;) {
    const claim = JSON.stringify({ s: 'p', t: randomUUID(), f: fingerprint } satisfies Pending);
    if (await kv.setIfAbsent(k, claim, IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS)) {
      return { kind: 'fresh', value: await execute(options, k, metaKey, claim) };
    }
    const raw = await kv.get(k);
    const stored = parse(raw);
    if (raw === null) {
      // Released or lapsed between the claim attempt and the read: claim again.
      if (Date.now() < deadline) continue;
    } else if (stored) {
      // A row that does not parse is not ours to overwrite; it is treated as running.
      if ((stored.f ?? null) !== (fingerprint ?? null)) return { kind: 'mismatch' };
      if (stored.s === 'd') return { kind: 'replayed', value: stored.v as T };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const meta = parseMeta(await kv.get(metaKey));
      return { kind: 'in_progress', meta };
    }
    const local = inflight.get(k);
    if (local) await Promise.race([local.catch(() => undefined), sleep(remaining)]);
    else await sleep(Math.min(POLL_MS, remaining));
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function execute<T>(options: RunIdempotentOptions<T>, k: string, metaKey: string, claim: string): Promise<T> {
  let renewing = true;
  const timer = setInterval(() => {
    if (!renewing) return;
    void kv.renew(k, claim, IDEMPOTENCY_IN_PROGRESS_TTL_SECONDS).then(ok => {
      if (!ok) renewing = false;
    });
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();
  const track: IdempotencyTrack = {
    setMeta: meta => kv.set(metaKey, JSON.stringify(meta), IDEMPOTENCY_DONE_TTL_SECONDS),
  };
  const work = (async () => {
    try {
      const value = await options.run(track);
      if (options.keep ? options.keep(value) : true) {
        const done: Done = { s: 'd', f: options.fingerprint, v: value };
        await kv.set(k, JSON.stringify(done), IDEMPOTENCY_DONE_TTL_SECONDS);
      } else {
        await kv.del(k);
        await kv.del(metaKey);
      }
      return value;
    } catch (err) {
      // Nothing to replay: free the key so a retry can try again.
      await kv.del(k);
      await kv.del(metaKey);
      throw err;
    } finally {
      clearInterval(timer);
      inflight.delete(k);
    }
  })();
  inflight.set(k, work);
  return work;
}

/** Test helper: forget the in-process fallback and in-flight calls. */
export function _resetIdempotency(): void {
  fallback.clear();
  inflight.clear();
}
