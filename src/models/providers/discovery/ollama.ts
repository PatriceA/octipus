import { detectOllamaInputs } from '@/models/capability-detect';
import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Ollama installed-model list — `GET /api/tags`.
 * https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models
 *
 * No curation needed for installed list — show whatever the user pulled.
 * Tier inference still applies so the UI groups them sensibly.
 */
interface OllamaTagRaw {
  name: string;
  size?: number;
  digest?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export class OllamaDiscovery implements ProviderDiscovery {
  provider = 'ollama';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    const base = creds.endpoint || 'http://localhost:11434';
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      throw new Error(`Ollama unreachable at ${base} (${res.status})`);
    }
    const json = await res.json() as { models: OllamaTagRaw[] };
    const models = json.models || [];
    // What each model reads (images, audio) and whether it calls tools comes
    // from Ollama itself (`/api/show` → capabilities), a few at a time.
    const inputs = await mapLimit(models, 4, (m) => detectOllamaInputs(base, m.name, 3_000).catch(() => undefined));
    const partial = models.map((m, i) => ({
      id: m.name,
      label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
      provider: 'ollama',
      supportsTools: inputs[i]?.tools ?? true,
      supportsVision: inputs[i]?.image ?? false,
      supportsAudioInput: inputs[i]?.audio ?? false,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
