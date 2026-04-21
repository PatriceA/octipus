import { getConfig } from '@/config';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getLiteLLMClient } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

/**
 * LiteLLM proxy provider — routes through the LiteLLM Docker container.
 * This is the default provider for all API-based models.
 */
export class LiteLLMProvider implements ModelProvider {
  readonly name = 'litellm';
  readonly type = 'litellm' as const;

  /** LiteLLM handles all standard model names */
  supportsModel(_modelName: string): boolean {
    return true;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = getLiteLLMClient();
    return client.completeViaProxy(options);
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = getLiteLLMClient();
    yield* client.streamViaProxy(options);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const config = getConfig();
    const startTime = Date.now();

    try {
      const response = await fetch(`${config.litellm.proxyUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { healthy: false, error: `HTTP ${response.status}` };
      }

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }
}
