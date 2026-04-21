import { classifyError } from '@/core/errors/classification';
import { coreLogger, modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

/** Voyage AI model prefixes — embedding-only provider */
const SUPPORTED_PREFIXES = ['voyage-'];

/**
 * Voyage AI provider — embeddings only.
 * https://docs.voyageai.com/docs/embeddings
 */
export class VoyageProvider implements ModelProvider {
  readonly name = 'voyage';
  readonly type = 'direct' as const;

  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || VOYAGE_BASE_URL;
  }

  supportsModel(modelName: string): boolean {
    return SUPPORTED_PREFIXES.some(p => modelName.startsWith(p));
  }

  private async getApiKey(): Promise<string | null> {
    // Try env var first
    if (process.env.VOYAGE_API_KEY) return process.env.VOYAGE_API_KEY;
    // Try vault
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'voyage_api_key');
      return value || null;
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message }, 'Voyage vault lookup failed; falling back to env var');
    }
    return null;
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('Voyage API key not configured. Set VOYAGE_API_KEY env var or add voyage_api_key in Secrets.');

    modelLogger.debug({ model, inputCount: texts.length, provider: this.name }, 'Generating embeddings via Voyage AI');

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: texts,
        input_type: 'document',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      const classified = classifyError({ status: response.status, message: error }, 'voyage');
      throw classified;
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }

  // Voyage AI is embeddings-only — chat completions are not supported
  async complete(_options: CompletionOptions): Promise<CompletionResult> {
    throw new Error('Voyage AI only supports embeddings, not chat completions');
  }

  async *stream(_options: CompletionOptions): AsyncGenerator<StreamChunk> {
    throw new Error('Voyage AI only supports embeddings, not chat completions');
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) return { healthy: false, error: 'API key not configured' };

      const start = Date.now();
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'voyage-3-lite',
          input: ['health check'],
          input_type: 'document',
        }),
      });

      return {
        healthy: response.ok,
        latencyMs: Date.now() - start,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err: any) {
      return { healthy: false, error: err.message };
    }
  }
}
