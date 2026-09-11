import type { ModelConfigEntry } from '@/db/schema/models';

/** A missing rate stays unknown. We never invent a provider-family discount. */
export function estimateCost(model: Pick<ModelConfigEntry, 'provider' | 'costPerInputToken' | 'costPerOutputToken' | 'metadata'> | undefined,
  input: number, output: number, read = 0, write = 0): number | null {
  if (!model) return null;
  const pricing = model.metadata?.pricing;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (![input, output, read, write].every(finite) || read + write > input) return null;
  if (pricing?.free) return 0;
  if (![model.costPerInputToken, model.costPerOutputToken].every(finite)) return null;
  const fresh = input - read - write;
  const inputRate = model.costPerInputToken;
  const outputRate = model.costPerOutputToken;
  // Existing zero defaults are not evidence that a remote model is free.
  if ((fresh > 0 && !(inputRate > 0)) || (output > 0 && !(outputRate > 0))) return null;
  if ((read > 0 && !finite(pricing?.cacheRead)) || (write > 0 && !finite(pricing?.cacheWrite))) return null;
  return (fresh * inputRate + output * outputRate + read * (pricing?.cacheRead ?? 0) + write * (pricing?.cacheWrite ?? 0)) / 1_000_000;
}
