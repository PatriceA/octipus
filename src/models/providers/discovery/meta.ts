import { isMuseChatModel } from '../meta-provider';
import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Meta (Muse) model list — OpenAI-compatible `GET /models`. Keeps chat models
 * only: drops image/voice/sam-* and the `-contributor` variants.
 */
export class MetaDiscovery implements ProviderDiscovery {
  provider = 'meta';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('Meta API key not configured');
    const base = creds.endpoint || 'https://api.meta.ai/v1';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Meta list models returned ${res.status}`);
    }
    const json = await res.json() as { data: Array<{ id: string; created?: number }> };
    const partial = (json.data || [])
      .filter(m => isMuseChatModel(m.id) && !m.id.endsWith('-contributor'))
      .map(m => ({
        id: m.id,
        label: m.id,
        provider: 'meta',
        createdAt: m.created ? m.created * 1000 : undefined,
        raw: m,
      }));
    return applyTierInference(partial);
  }
}
