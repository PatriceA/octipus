import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';
import { getConfig } from '@/config';
import { modelLogger } from '@/utils/logger';
import type { AgentMessage, ToolCall } from '@/core/types';

export interface CompletionOptions {
  model: string;
  messages: AgentMessage[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  stopSequences?: string[];
  responseFormat?: { type: 'text' | 'json_object' };
  /** Extra body parameters forwarded to the provider (e.g. { think: false } for Ollama Qwen3) */
  extraBody?: Record<string, unknown>;
  /** Per-model endpoint override (e.g. second Ollama instance) */
  endpoint?: string;
  /** Per-model API key (e.g. custom OpenAI-compatible provider) */
  apiKey?: string;
}

export interface CompletionResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model: string;
  latencyMs: number;
}

export interface StreamChunk {
  content?: string;
  toolCallDelta?: {
    id: string;
    name?: string;
    arguments?: string;
  };
  finishReason?: string;
}

/**
 * Client for LiteLLM proxy - provides unified API for all LLM providers
 */
export class LiteLLMClient {
  private client: OpenAI;
  private defaultModel: string;

  constructor() {
    const config = getConfig();

    this.client = new OpenAI({
      baseURL: config.litellm.proxyUrl,
      apiKey: config.litellm.apiKey || 'sk-litellm',
      timeout: config.litellm.timeout,
      maxRetries: config.litellm.maxRetries,
    });

    this.defaultModel = 'gpt-oss'; // Fallback; actual default resolved from DB via ModelRegistry
  }

  /**
   * Remove orphaned tool messages that have no preceding assistant message
   * with matching tool_calls. This prevents LLM API errors.
   */
  private sanitizeToolMessages(messages: AgentMessage[]): AgentMessage[] {
    // Collect all tool_call IDs from assistant messages
    const validToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          validToolCallIds.add(tc.id);
        }
      }
    }

    // Filter out tool messages whose toolCallId isn't in the set
    return messages.filter((msg) => {
      if (msg.role !== 'tool') return true;
      return msg.toolCallId && validToolCallIds.has(msg.toolCallId);
    });
  }

  /**
   * Convert internal message format to OpenAI format
   */
  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    const sanitized = this.sanitizeToolMessages(messages);
    return sanitized.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId || '',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
    });
  }

  /**
   * Create a chat completion.
   * Tries a direct provider (Ollama, OpenAI, Anthropic, Gemini, DeepSeek, CLI)
   * first. Falls through to the LiteLLM proxy when no direct provider matches.
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    // Try direct provider first
    const resolvedModel = options.model || this.defaultModel;
    try {
      const { getProviderRouter } = await import('@/models/providers');
      const router = getProviderRouter();
      const provider = router.getProvider(resolvedModel);
      if (provider.name !== 'litellm') {
        modelLogger.debug(
          { model: resolvedModel, provider: provider.name },
          'Routing completion through direct provider'
        );
        return await router.complete({ ...options, model: resolvedModel });
      }
    } catch {
      // Fall through to LiteLLM proxy path
    }

    return this.completeViaProxy({ ...options, model: resolvedModel });
  }

  /**
   * Create a chat completion directly via the LiteLLM proxy, bypassing
   * the ProviderRouter. Used internally and by the LiteLLMProvider.
   */
  async completeViaProxy(options: CompletionOptions): Promise<CompletionResult> {
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: options.model || this.defaultModel,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      response_format: options.responseFormat,
      stream: false,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Ollama Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.info({ model: params.model, messageCount: options.messages.length }, 'LLM request');

    try {
      const response = await this.client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];

      // Strip <think>...</think> blocks from models that include reasoning tokens
      let content = choice.message.content || '';
      if (content.includes('<think>')) {
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }

      const result: CompletionResult = {
        content,
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
        model: response.model,
        latencyMs,
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        }));
      }

      modelLogger.info(
        {
          model: response.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs,
          hasToolCalls: !!result.toolCalls?.length,
          finishReason: result.finishReason,
        },
        'LLM completion'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model }, 'Completion failed');
      throw error;
    }
  }

  /**
   * Create a streaming chat completion.
   * Tries a direct provider first, falls through to LiteLLM proxy.
   */
  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    // Try direct provider first
    const resolvedModel = options.model || this.defaultModel;
    try {
      const { getProviderRouter } = await import('@/models/providers');
      const router = getProviderRouter();
      const provider = router.getProvider(resolvedModel);
      if (provider.name !== 'litellm') {
        modelLogger.debug(
          { model: resolvedModel, provider: provider.name },
          'Routing stream through direct provider'
        );
        yield* router.stream({ ...options, model: resolvedModel });
        return;
      }
    } catch {
      // Fall through to LiteLLM proxy path
    }

    yield* this.streamViaProxy({ ...options, model: resolvedModel });
  }

  /**
   * Stream directly via the LiteLLM proxy, bypassing the ProviderRouter.
   * Used internally and by the LiteLLMProvider.
   */
  async *streamViaProxy(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const params: ChatCompletionCreateParams = {
      model: options.model || this.defaultModel,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Ollama Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model }, 'Starting streaming completion via LiteLLM proxy');

    const stream = await this.client.chat.completions.create(params);

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let insideThinkBlock = false;
    let thinkBuffer = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        // Filter out <think>...</think> blocks from streaming content
        let text = delta.content;
        if (insideThinkBlock) {
          thinkBuffer += text;
          const closeIdx = thinkBuffer.indexOf('</think>');
          if (closeIdx !== -1) {
            insideThinkBlock = false;
            text = thinkBuffer.substring(closeIdx + 8);
            thinkBuffer = '';
            if (text) yield { content: text };
          }
          continue;
        }
        const openIdx = text.indexOf('<think>');
        if (openIdx !== -1) {
          const before = text.substring(0, openIdx);
          if (before) yield { content: before };
          insideThinkBlock = true;
          thinkBuffer = text.substring(openIdx + 7);
          const closeIdx = thinkBuffer.indexOf('</think>');
          if (closeIdx !== -1) {
            insideThinkBlock = false;
            const after = thinkBuffer.substring(closeIdx + 8);
            thinkBuffer = '';
            if (after) yield { content: after };
          }
          continue;
        }
        yield { content: text };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallBuffers.has(tc.index)) {
            toolCallBuffers.set(tc.index, { id: tc.id || '', name: '', arguments: '' });
          }
          const buffer = toolCallBuffers.get(tc.index)!;
          if (tc.id) buffer.id = tc.id;
          if (tc.function?.name) buffer.name = tc.function.name;
          if (tc.function?.arguments) buffer.arguments += tc.function.arguments;

          yield {
            toolCallDelta: {
              id: buffer.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            },
          };
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        yield { finishReason: chunk.choices[0].finish_reason };
      }
    }
  }

  /**
   * Generate embeddings.
   * Tries a direct provider first (Ollama, OpenAI), falls through to LiteLLM proxy.
   */
  async embed(text: string | string[], model?: string): Promise<number[][]> {
    const input = Array.isArray(text) ? text : [text];
    const embeddingModel = model || 'text-embedding-3-small';

    // Try direct provider first
    try {
      const { getProviderRouter } = await import('@/models/providers');
      const router = getProviderRouter();
      const provider = router.getProvider(embeddingModel);
      if (provider.name !== 'litellm' && provider.embed) {
        modelLogger.debug(
          { model: embeddingModel, provider: provider.name, inputCount: input.length },
          'Routing embed through direct provider'
        );
        return await provider.embed(input, embeddingModel);
      }
    } catch {
      // Fall through to LiteLLM proxy path
    }

    modelLogger.debug({ model: embeddingModel, inputCount: input.length }, 'Generating embeddings via LiteLLM proxy');

    const response = await this.client.embeddings.create({
      model: embeddingModel,
      input,
      encoding_format: 'float',
    });

    return response.data.map((d) => d.embedding);
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    const response = await this.client.models.list();
    return response.data.map((m) => m.id);
  }

  /**
   * Send an image to a vision model and get a text response.
   * Uses the OpenAI-compatible multimodal content format.
   * Tries a direct provider first (Ollama, OpenAI), falls through to LiteLLM proxy.
   */
  async completeVision(options: {
    model: string;
    prompt: string;
    imageBase64: string;
    mimeType?: string;
    maxTokens?: number;
  }): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; latencyMs: number }> {
    const mediaType = options.mimeType || 'image/png';
    const maxTokens = options.maxTokens || 4096;
    const visionMessages: ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: options.prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${options.imageBase64}` } },
        ],
      },
    ];

    // Try direct provider first — vision is just a chat completion with image content
    try {
      const { getProviderRouter } = await import('@/models/providers');
      const router = getProviderRouter();
      const provider = router.getProvider(options.model);
      if (provider.name !== 'litellm') {
        modelLogger.info({ model: options.model, provider: provider.name }, 'Routing vision request through direct provider');
        const startTime = Date.now();

        // Resolve endpoint + API key for the model (supports per-model overrides)
        const { getVault } = await import('@/security/vault');
        const vault = getVault();
        const { getModelRegistry: getVisionRegistry } = await import('@/models/model-registry');
        const visionModelEntry = await getVisionRegistry().getModelByModelId(options.model);
        const modelEndpoint = visionModelEntry?.endpoint;
        const modelApiKeyRef = visionModelEntry?.apiKeyRef;

        // Build endpoint + API key for each provider type
        const providerEndpoints: Record<string, { baseURL: string; vaultName: string; envVar: string }> = {
          ollama: { baseURL: `${modelEndpoint || getConfig().ollama.url}/v1`, vaultName: '', envVar: '' },
          openai: { baseURL: 'https://api.openai.com/v1', vaultName: 'openai_api_key', envVar: 'OPENAI_API_KEY' },
          anthropic: { baseURL: 'https://api.anthropic.com/v1/', vaultName: 'anthropic_api_key', envVar: 'ANTHROPIC_API_KEY' },
          gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', vaultName: 'gemini_api_key', envVar: 'GEMINI_API_KEY' },
          deepseek: { baseURL: 'https://api.deepseek.com/v1', vaultName: 'deepseek_api_key', envVar: 'DEEPSEEK_API_KEY' },
        };

        const pe = providerEndpoints[provider.name];
        if (!pe) throw new Error(`Unsupported provider for vision: ${provider.name}`);

        let apiKey = 'ollama';
        if (provider.name !== 'ollama') {
          apiKey = (modelApiKeyRef ? await vault.getByName('system', modelApiKeyRef) : null)
            || await vault.getByName('system', pe.vaultName)
            || process.env[pe.envVar]
            || '';
          if (!apiKey) throw new Error(`No API key for ${provider.name}`);
        } else if (modelApiKeyRef) {
          apiKey = await vault.getByName('system', modelApiKeyRef) || 'ollama';
        }

        const client = new OpenAI({
          baseURL: modelEndpoint ? `${modelEndpoint}/v1` : pe.baseURL,
          apiKey,
          timeout: 120_000,
          maxRetries: 2,
        });

        const response = await client.chat.completions.create({
          model: options.model,
          messages: visionMessages,
          max_tokens: maxTokens,
          stream: false,
        });

        const latencyMs = Date.now() - startTime;
        const choice = response.choices[0];
        const msg = choice?.message as unknown as Record<string, unknown>;
        let content = (choice?.message?.content || msg?.reasoning || '') as string;
        if (content.includes('<think>')) {
          content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        }

        modelLogger.info({ model: options.model, provider: provider.name, latencyMs, tokens: response.usage?.total_tokens }, 'Vision response (direct)');

        return {
          content,
          usage: {
            inputTokens: response.usage?.prompt_tokens || 0,
            outputTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
          },
          latencyMs,
        };
      }
    } catch (err) {
      // Fall through to LiteLLM proxy path
      modelLogger.debug({ error: (err as Error).message, model: options.model }, 'Direct vision provider failed, falling back to LiteLLM proxy');
    }

    // Fall through to LiteLLM proxy
    const startTime = Date.now();
    modelLogger.info({ model: options.model }, 'Vision request via LiteLLM proxy');

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: visionMessages,
      max_tokens: maxTokens,
      stream: false,
    });

    const latencyMs = Date.now() - startTime;
    let content = response.choices[0]?.message?.content || '';
    if (content.includes('<think>')) {
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    modelLogger.info({ model: options.model, latencyMs, tokens: response.usage?.total_tokens }, 'Vision response');

    return {
      content,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      latencyMs,
    };
  }

  /**
   * Check if a specific model is available
   */
  async isModelAvailable(model: string): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.includes(model);
    } catch {
      return false;
    }
  }
}

// Singleton instance
let clientInstance: LiteLLMClient | null = null;

export function getLiteLLMClient(): LiteLLMClient {
  if (!clientInstance) {
    clientInstance = new LiteLLMClient();
  }
  return clientInstance;
}

/**
 * Reset the LiteLLM client singleton (for hot-reload).
 * Next call to getLiteLLMClient() will create a fresh client with updated config.
 */
export function resetLiteLLMClient(): void {
  clientInstance = null;
  modelLogger.info('LiteLLM client reset for config reload');
}
