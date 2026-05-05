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
    const partial = (json.models || []).map(m => ({
      id: m.name,
      label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
      provider: 'ollama',
      supportsTools: true,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
