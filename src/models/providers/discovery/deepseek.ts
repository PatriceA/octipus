import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * DeepSeek model list — OpenAI-compatible `GET /v1/models`.
 */
interface DeepSeekModelRaw {
  id: string;
  created: number;
  owned_by: string;
}

export class DeepSeekDiscovery implements ProviderDiscovery {
  provider = 'deepseek';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('DeepSeek API key not configured');
    const base = creds.endpoint || 'https://api.deepseek.com/v1';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`DeepSeek list models returned ${res.status}`);
    }
    const json = await res.json() as { data: DeepSeekModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.id,
      provider: 'deepseek',
      createdAt: m.created ? m.created * 1000 : undefined,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
