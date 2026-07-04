/**
 * Per-model native-tool-calling capability signal (Phase 2.1 capability floor).
 *
 * The toolshim only fires AFTER a model returned prose where a tool call was
 * expected — i.e. it reconstructs a call the model failed to emit natively. So
 * recent shim usage is a cheap proxy for "this model can't reliably drive tool
 * calls" and must not orchestrate. The worker records one sample per LLM turn
 * that produced tool calls: `shim=false` when the model emitted them natively,
 * `shim=true` when the shim had to translate prose.
 *
 * Self-healing (so a model isn't blamed forever after a provider fix ships):
 *  - sliding window of the last N samples per model — native calls push old
 *    shim flags out;
 *  - each sample carries a timestamp; samples older than TTL are ignored.
 * Both mean the floor re-evaluates a model automatically once it starts
 * behaving. `resetModelCapabilityStats` is also exported for explicit
 * invalidation (e.g. wiring to a model-registry cache clear later).
 */

const WINDOW = 10;
const TTL_MS = 30 * 60_000; // blame expires 30 min after the last bad sample

interface Sample {
  at: number;
  shim: boolean;
}

const samples = new Map<string, Sample[]>();

/** Record the outcome of one tool-producing LLM turn for `modelId`. */
export function recordModelToolCall(modelId: string, shimFired: boolean): void {
  if (!modelId) return;
  const arr = samples.get(modelId) ?? [];
  arr.push({ at: Date.now(), shim: shimFired });
  if (arr.length > WINDOW) arr.splice(0, arr.length - WINDOW);
  samples.set(modelId, arr);
}

/**
 * True when `modelId` needed the toolshim within the recent window (and the
 * TTL hasn't expired) — the signal the capability floor rejects on.
 */
export function hasRecentShim(modelId: string): boolean {
  const arr = samples.get(modelId);
  if (!arr) return false;
  const cutoff = Date.now() - TTL_MS;
  return arr.some((s) => s.shim && s.at >= cutoff);
}

/** Clear capability stats. Call after model/provider config changes so a fixed model is re-evaluated. */
export function resetModelCapabilityStats(modelId?: string): void {
  if (modelId) samples.delete(modelId);
  else samples.clear();
}
