import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Grok (xAI) model list — `GET /v1/models`. OpenAI-compatible.
 * https://docs.x.ai/docs/api-reference
 *
 * Response: { object: "list", data: [{ id, created, owned_by, ... }] }.
 * Sparse like OpenAI — curation relies on id heuristics + createdAt.
 */
interface GrokModelRaw {
  id: string;
  created?: number;
  owned_by?: string;
}

export class GrokDiscovery implements ProviderDiscovery {
  provider = 'grok';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('Grok (xAI) API key not configured');
    const base = creds.endpoint || 'https://api.x.ai/v1';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Grok list models returned ${res.status}`);
    }
    const json = await res.json() as { data: GrokModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.id,
      provider: 'grok',
      createdAt: m.created ? m.created * 1000 : undefined,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
