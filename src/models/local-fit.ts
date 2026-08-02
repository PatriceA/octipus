/**
 * Fail fast when a local model cannot fit in memory *right now*.
 *
 * `OLLAMA_LOAD_TIMEOUT` is 15m to accommodate genuinely slow first loads, so a
 * load that cannot fit burns the full 15 minutes before failing — pure loss,
 * and from outside it looks identical to a healthy wait.
 *
 * **The check is about the moment, never the model.** Measured 2026-08-02:
 * `ornith:35b` offloads 41/41 layers to GPU in ~6s and outruns the smaller lane
 * model when it has room; the same model stalled for 50 minutes when ~22GB was
 * held by a browser. A static "too big for this box" rule would permanently
 * disable the *faster* option because of a transient condition. So: compare
 * against live available memory at request time, cache no verdict, and
 * re-evaluate on every dispatch.
 *
 * Where a starved load actually dies is worth knowing — it is NOT during weight
 * loading. `load_tensors: offloaded N/N layers` completes, then llama-server
 * goes silent in context construction and never prints
 * `llama_context: constructing llama_context`. Elapsed time tells you nothing;
 * the missing line is the tell.
 *
 * docs/plans/blocked-vs-stuck.md Phase 3.
 */

import { freemem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { modelLogger } from '@/utils/logger';

const BYTES_PER_GB = 1024 ** 3;

/** Short timeout — these are loopback calls; a slow one must not delay dispatch. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Multiplier applied to the model's on-disk weight size to approximate what a
 * load actually needs. The KV cache is comparatively small (640 MiB for a 32k
 * context on the model measured), so the weights dominate; the margin covers
 * the context, the compute graph, and allocator slack.
 *
 * Kept deliberately tight. Overestimating need blocks work that would have run,
 * which is the failure mode this whole check must not introduce.
 */
const LOAD_OVERHEAD_FACTOR = 1.08;

export interface FitVerdict {
  /** False ONLY when we positively determined it cannot fit. Unknown ⇒ true. */
  ok: boolean;
  /** Actionable operator-facing explanation, set when `ok` is false. */
  reason?: string;
}

const FITS: FitVerdict = { ok: true };

/**
 * Bytes of memory a new allocation could actually get.
 *
 * `MemAvailable` (not `free`) is the right number: it accounts for reclaimable
 * page cache, and it *does* include memory an already-resident model holds via
 * GTT — which per-process views like `ps`/RSS completely miss, because the GPU
 * driver holds it rather than the llama-server process. On a box with a
 * resident 21GB model, RSS says ~0.8GB while 21GB of system RAM is genuinely
 * gone; only MemAvailable reflects that.
 */
export async function availableMemoryBytes(): Promise<number> {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf-8');
    const m = meminfo.match(/^MemAvailable:\s+(\d+) kB$/m);
    if (m) return Number(m[1]) * 1024;
  } catch {
    // Not Linux, or /proc unreadable — fall through.
  }
  return freemem();
}

/** Is this endpoint served by the machine we are measuring memory on? */
function isLoopback(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

async function probe<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Decide whether dispatching `modelId` to a local ollama at `endpoint` can
 * succeed right now.
 *
 * Fails OPEN in every uncertain case — a wrong "won't fit" blocks work that
 * would have run, which is strictly worse than the 15-minute wait it replaces.
 * Specifically returns `ok` when: the endpoint is not loopback (a remote daemon
 * has its own memory), the model is already resident (no load needed), the
 * model's size is unknown, or any probe fails.
 */
export async function checkLocalModelFit(modelId: string, endpoint: string): Promise<FitVerdict> {
  // A non-loopback daemon (e.g. ollama2 on another host) has memory we are not
  // measuring. Gating it on OUR free RAM would be plainly wrong.
  if (!isLoopback(endpoint)) return FITS;

  const base = endpoint.replace(/\/v1\/?$/, '').replace(/\/$/, '');

  // Already resident ⇒ no load to fail. This is also why the check must not be
  // cached: residency changes underneath us.
  const ps = await probe<{ models?: Array<{ model?: string; name?: string }> }>(`${base}/api/ps`);
  if (ps?.models?.some((m) => m.model === modelId || m.name === modelId)) return FITS;

  const tags = await probe<{ models?: Array<{ model?: string; name?: string; size?: number }> }>(`${base}/api/tags`);
  const entry = tags?.models?.find((m) => m.model === modelId || m.name === modelId);
  const sizeBytes = entry?.size;
  if (!sizeBytes || !Number.isFinite(sizeBytes)) return FITS; // unknown ⇒ let it try

  const needBytes = sizeBytes * LOAD_OVERHEAD_FACTOR;
  const availBytes = await availableMemoryBytes();
  if (needBytes <= availBytes) return FITS;

  const gb = (b: number) => `${(b / BYTES_PER_GB).toFixed(1)}GB`;
  const reason =
    `${modelId} needs ~${gb(needBytes)} to load but only ${gb(availBytes)} is available right now. ` +
    `Free memory (a browser or a test run is the usual culprit) and retry, or route this lane to a smaller model. ` +
    `Not attempted, because a load that cannot fit blocks for up to 15 minutes before failing.`;

  modelLogger.warn(
    { model: modelId, needBytes: Math.round(needBytes), availBytes, endpoint: base },
    'Local model cannot fit in available memory — failing fast instead of blocking on the load timeout',
  );
  return { ok: false, reason };
}
