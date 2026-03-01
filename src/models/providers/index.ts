import type { ModelProvider } from './interface';
import { LiteLLMProvider } from './litellm-provider';
import { CLIProvider } from './cli-provider';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getConfig } from '@/config';
import { modelLogger } from '@/utils/logger';

export type { ModelProvider, ProviderType, ProviderHealthStatus, QuotaStatus } from './interface';
export { LiteLLMProvider } from './litellm-provider';
export { CLIProvider } from './cli-provider';
export { OllamaProvider } from './ollama-provider';
export { OpenAIProvider } from './openai-provider';
export { AnthropicProvider } from './anthropic-provider';
export { GeminiProvider } from './gemini-provider';

/**
 * Provider router — selects the right provider based on the model name
 * and handles fallback when a provider is unhealthy or quota-exhausted.
 *
 * Priority: CLI → Ollama → OpenAI → Anthropic → Gemini → LiteLLM (catch-all)
 * LiteLLM is only registered if proxyUrl is configured.
 */
export class ProviderRouter {
  private providers: ModelProvider[] = [];

  constructor() {
    const config = getConfig();

    // Register providers in priority order
    this.providers.push(new CLIProvider());
    this.providers.push(new OllamaProvider());
    this.providers.push(new OpenAIProvider());
    this.providers.push(new AnthropicProvider());
    this.providers.push(new GeminiProvider());

    // LiteLLM as catch-all fallback — only if configured
    if (config.litellm.proxyUrl) {
      this.providers.push(new LiteLLMProvider());
    }
  }

  /** Get the provider that handles a given model */
  getProvider(modelName: string): ModelProvider {
    for (const provider of this.providers) {
      if (provider.supportsModel(modelName)) {
        return provider;
      }
    }
    // Default to LiteLLM (it accepts everything)
    return this.providers[this.providers.length - 1];
  }

  /** Complete with automatic provider selection */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const provider = this.getProvider(options.model);

    modelLogger.debug({
      model: options.model,
      provider: provider.name,
    }, 'Routing completion request');

    return provider.complete(options);
  }

  /** Stream with automatic provider selection */
  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const provider = this.getProvider(options.model);

    modelLogger.debug({
      model: options.model,
      provider: provider.name,
    }, 'Routing streaming request');

    yield* provider.stream(options);
  }

  /** Get all registered providers */
  getAllProviders(): ModelProvider[] {
    return [...this.providers];
  }

  /** Get the CLI provider for quota management */
  getCLIProvider(): CLIProvider {
    return this.providers.find(p => p.type === 'cli') as CLIProvider;
  }
}

// Singleton
let routerInstance: ProviderRouter | null = null;

export function getProviderRouter(): ProviderRouter {
  if (!routerInstance) {
    routerInstance = new ProviderRouter();
  }
  return routerInstance;
}
