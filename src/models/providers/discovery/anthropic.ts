import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Anthropic model list — `GET /v1/models`.
 * https://docs.anthropic.com/en/api/models-list
 *
 * Response: { data: [{ type, id, display_name, created_at }] }
 * Anthropic's list is already curated (~10 models). No context/pricing
 * fields — curation infers tier from the id pattern.
 */
interface AnthropicModelRaw {
  type: 'model';
  id: string;
  display_name: string;
  created_at: string; // ISO-8601
}

export class AnthropicDiscovery implements ProviderDiscovery {
  provider = 'anthropic';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('Anthropic API key not configured');
    const base = creds.endpoint || 'https://api.anthropic.com/v1';
    const res = await fetch(`${base}/models`, {
      headers: {
        'x-api-key': creds.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Anthropic list models returned ${res.status}`);
    }
    const json = await res.json() as { data: AnthropicModelRaw[] };
    const partial = (json.data || []).map(m => ({
      id: m.id,
      label: m.display_name || m.id,
      provider: 'anthropic',
      createdAt: m.created_at ? Date.parse(m.created_at) : undefined,
      supportsTools: true,
      supportsVision: true,
      raw: m,
    }));
    return applyTierInference(partial);
  }
}
