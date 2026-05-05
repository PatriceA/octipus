import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * OpenAI model list — `GET /v1/models`.
 * https://platform.openai.com/docs/api-reference/models/list
 *
 * Response is sparse: { id, object, created, owned_by }.
 * No context window, no capabilities, no pricing in the API. Curation must
 * rely on id-pattern heuristics + the createdAt timestamp the vendor provides.
 */
interface OpenAiModelRaw {
  id: string;
  created: number;       // unix seconds
  owned_by: string;
}

export class OpenAIDiscovery implements ProviderDiscovery {
  provider = 'openai';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('OpenAI API key not configured');
    const base = creds.endpoint || 'https://api.openai.com/v1';
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`OpenAI list models returned ${res.status}`);
    }
    const json = await res.json() as { data: OpenAiModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.id,
      provider: 'openai',
      createdAt: m.created ? m.created * 1000 : undefined,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
