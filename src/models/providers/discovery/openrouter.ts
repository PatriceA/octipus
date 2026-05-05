import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * OpenRouter model list — `GET /api/v1/models`.
 * https://openrouter.ai/docs/api-reference/list-available-models
 *
 * Rich response: id, name, context_length, pricing.{prompt,completion},
 * architecture.{input_modalities, output_modalities}, supported_parameters
 * (array). No date field — curation falls back to id-pattern heuristics.
 */
interface OpenRouterModelRaw {
  id: string;
  name: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number };
}

export class OpenRouterDiscovery implements ProviderDiscovery {
  provider = 'openrouter';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('OpenRouter API key not configured');
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter list models returned ${res.status}`);
    }
    const json = await res.json() as { data: OpenRouterModelRaw[] };
    const partial = (json.data || [])
      // Curation requires tool support for an agentic app. Vendor exposes this.
      .filter(m => (m.supported_parameters || []).includes('tools'))
      .map(m => ({
        id: m.id,
        label: m.name || m.id,
        provider: 'openrouter',
        createdAt: m.created ? m.created * 1000 : undefined,
        contextWindow: m.context_length,
        maxOutputTokens: m.top_provider?.max_completion_tokens,
        costPerInputToken: m.pricing?.prompt ? +(parseFloat(m.pricing.prompt) * 1_000_000).toFixed(4) : undefined,
        costPerOutputToken: m.pricing?.completion ? +(parseFloat(m.pricing.completion) * 1_000_000).toFixed(4) : undefined,
        supportsVision: (m.architecture?.input_modalities || []).includes('image'),
        supportsTools: true,
        raw: m,
      }));
    return applyTierInference(partial);
  }
}
