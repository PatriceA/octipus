import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import { coreLogger, modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import { fetchWithRetryAfter, withTimeoutSignal } from './http-retry';

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
    if (!apiKey) {
      throw new ClassifiedError({
        reason: FailoverReason.AUTH_FAILED,
        recovery: RecoveryAction.ROTATE_CREDENTIAL,
        message: 'Voyage API key not configured. Set VOYAGE_API_KEY env var or add voyage_api_key in Secrets.',
        providerHint: this.name,
      });
    }

    modelLogger.debug({ model, inputCount: texts.length, provider: this.name }, 'Generating embeddings via Voyage AI');

    const response = await fetchWithRetryAfter(`${this.baseUrl}/embeddings`, {
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
      signal: withTimeoutSignal(30_000),
    }, this.name);

    if (!response.ok) {
      const error = await response.text();
      const classified = classifyError({ status: response.status, message: error }, 'voyage');
      throw classified;
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    if (!Array.isArray(data?.data)) {
      throw classifyError(new Error('Voyage returned no embeddings data'), this.name);
    }
    return data.data.map(d => d.embedding);
  }

  // Voyage AI is embeddings-only — chat completions are not supported
  async complete(_options: CompletionOptions): Promise<CompletionResult> {
    throw new ClassifiedError({
      reason: FailoverReason.ABORT_FATAL,
      recovery: RecoveryAction.ABORT,
      message: 'Voyage AI only supports embeddings, not chat completions',
      providerHint: this.name,
    });
  }

  async *stream(_options: CompletionOptions): AsyncGenerator<StreamChunk> {
    throw new ClassifiedError({
      reason: FailoverReason.ABORT_FATAL,
      recovery: RecoveryAction.ABORT,
      message: 'Voyage AI only supports embeddings, not chat completions',
      providerHint: this.name,
    });
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
        signal: withTimeoutSignal(10_000),
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

/**
 * Voyage's embedding models are a static, published set — there is no `/models`
 * discovery endpoint. Kept here so the add-model picker can offer them.
 * https://docs.voyageai.com/docs/embeddings
 */
export const VOYAGE_EMBEDDING_MODELS: Array<{ id: string; label: string }> = [
  { id: 'voyage-3.5', label: 'Voyage 3.5' },
  { id: 'voyage-3.5-lite', label: 'Voyage 3.5 Lite' },
  { id: 'voyage-3-large', label: 'Voyage 3 Large' },
  { id: 'voyage-3', label: 'Voyage 3' },
  { id: 'voyage-3-lite', label: 'Voyage 3 Lite' },
  { id: 'voyage-code-3', label: 'Voyage Code 3' },
  { id: 'voyage-finance-2', label: 'Voyage Finance 2' },
  { id: 'voyage-law-2', label: 'Voyage Law 2' },
  { id: 'voyage-multilingual-2', label: 'Voyage Multilingual 2' },
];

/** True if a Voyage key is available (env var or vault) — mirrors getApiKey(). */
export async function isVoyageConfigured(): Promise<boolean> {
  if (process.env.VOYAGE_API_KEY) return true;
  try {
    const { getVault } = await import('@/security/vault');
    return !!(await getVault().getByName('system', 'voyage_api_key'));
  } catch {
    return false;
  }
}
