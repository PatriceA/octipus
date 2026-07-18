import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Moonshot (Kimi) model list — OpenAI-compatible `GET /models`.
 */
interface MoonshotModelRaw {
  id: string;
  created?: number;
  owned_by?: string;
}

export class MoonshotDiscovery implements ProviderDiscovery {
  provider = 'moonshot';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('Moonshot API key not configured');
    const base = creds.endpoint || 'https://api.moonshot.ai/v1';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Moonshot list models returned ${res.status}`);
    }
    const json = await res.json() as { data: MoonshotModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.id,
      provider: 'moonshot',
      createdAt: m.created ? m.created * 1000 : undefined,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
