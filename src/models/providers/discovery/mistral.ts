import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Mistral model list — OpenAI-compatible `GET /v1/models`.
 */
interface MistralModelRaw {
  id: string;
  created?: number;
  owned_by?: string;
}

export class MistralDiscovery implements ProviderDiscovery {
  provider = 'mistral';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('Mistral API key not configured');
    const base = creds.endpoint || 'https://api.mistral.ai/v1';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Mistral list models returned ${res.status}`);
    }
    const json = await res.json() as { data: MistralModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.id,
      provider: 'mistral',
      createdAt: m.created ? m.created * 1000 : undefined,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
