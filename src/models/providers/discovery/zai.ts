import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * z.ai (GLM) model list — OpenAI-compatible `GET /models`.
 */
interface ZaiModelRaw {
  id: string;
  created?: number;
  owned_by?: string;
}

export class ZaiDiscovery implements ProviderDiscovery {
  provider = 'zai';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('z.ai API key not configured');
    const base = creds.endpoint || 'https://api.z.ai/api/paas/v4';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`z.ai list models returned ${res.status}`);
    }
    const json = await res.json() as { data: ZaiModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.id,
      provider: 'zai',
      createdAt: m.created ? m.created * 1000 : undefined,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
