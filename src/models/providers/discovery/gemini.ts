import { applyTierInference } from './curation';
import type { CanonicalModel, DiscoveryCreds, ProviderDiscovery } from './types';

/**
 * Gemini model list — `GET /v1beta/models?key=…`.
 * https://ai.google.dev/api/models
 *
 * Response includes inputTokenLimit, outputTokenLimit, and
 * supportedGenerationMethods — the richest metadata of the three.
 */
interface GeminiModelRaw {
  name: string;                          // "models/gemini-2.5-pro"
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export class GeminiDiscovery implements ProviderDiscovery {
  provider = 'gemini';

  async listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]> {
    if (!creds.apiKey) throw new Error('Gemini API key not configured');
    const base = creds.endpoint || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${base}/models?key=${encodeURIComponent(creds.apiKey)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Gemini list models returned ${res.status}`);
    }
    const json = await res.json() as { models: GeminiModelRaw[] };
    const partial = (json.models || [])
      // Drop entries that can't run generateContent — embeddings, AQA, etc.
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => {
        const id = m.name.replace(/^models\//, '');
        return {
          id,
          label: m.displayName || id,
          provider: 'gemini',
          contextWindow: m.inputTokenLimit,
          maxOutputTokens: m.outputTokenLimit,
          supportsTools: true,
          raw: m,
        };
      });
    return applyTierInference(partial);
  }
}
