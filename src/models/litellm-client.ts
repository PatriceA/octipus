import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { getConfig } from '@/config';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage, ToolCall } from '@/core/types';
import { transformMessagesForProvider } from '@/models/message-transform';
import { modelLogger } from '@/utils/logger';

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
  /**
   * Calling user ID — threaded through so providers can look up user-scoped
   * vault entries (e.g. custom-provider apiKeyRef stored under the user, not
   * the system scope).
   */
  userId?: string;
  /**
   * Pre-resolved custom-provider config that bypasses DB lookup.
   * Used by the test-model endpoint where the model row hasn't been saved yet.
   * When set, BaseCustomProvider.resolveModelConfig() returns this directly.
   */
  customProviderOverride?: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    custom: import('@/db/schema/models').CustomProviderConfig;
  };
}

export interface CompletionResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  model: string;
  latencyMs: number;
  /**
   * DeepSeek thinking-mode chain-of-thought. The reasoner returns this
   * alongside `content`; on the next turn we MUST echo it back inside the
   * prior assistant message or the API rejects the call with 400. Other
   * providers ignore it.
   */
  reasoningContent?: string;
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
   * Enforce the OpenAI tool-call <-> tool-message pairing invariant in BOTH
   * directions:
   *   (a) Drop tool messages whose tool_call_id has no matching assistant
   *       tool_calls entry (lenient providers accept; strict ones don't).
   *   (b) For every assistant `tool_calls` id that's missing a following
   *       `tool` message in the slice sent upstream, synthesize a placeholder
   *       tool message. Prevents DeepSeek's 400
   *       "insufficient tool messages following tool_calls message"
   *       after compaction, history re-slices, or bailed-out agent loops.
   */
  private sanitizeToolMessages(messages: AgentMessage[]): AgentMessage[] {
    // (a) Collect tool_call ids declared on assistant messages.
    const validToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) validToolCallIds.add(tc.id);
      }
    }
    const filtered = messages.filter((msg) => {
      if (msg.role !== 'tool') return true;
      return msg.toolCallId && validToolCallIds.has(msg.toolCallId);
    });

    // (b) Walk forward; after each assistant-with-tool_calls, make sure the
    // immediately-following `tool` messages cover every expected id. Missing
    // ones get a placeholder inserted at the boundary.
    const out: AgentMessage[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const msg = filtered[i];
      out.push(msg);
      if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;

      const expected = new Map(msg.toolCalls.map((tc) => [tc.id, tc.name] as const));
      let j = i + 1;
      const seen = new Set<string>();
      while (j < filtered.length && filtered[j].role === 'tool') {
        const id = filtered[j].toolCallId;
        if (id && expected.has(id)) seen.add(id);
        out.push(filtered[j]);
        j++;
      }
      for (const [id, name] of expected) {
        if (!seen.has(id)) {
          out.push({
            role: 'tool',
            content: '[no result recorded — tool response missing from history]',
            toolCallId: id,
            name,
            timestamp: new Date(),
          });
        }
      }
      i = j - 1;
    }
    return out;
  }

  /**
   * Convert internal message format to OpenAI format.
   * Applies cross-model message transformation (ID normalization, thinking block
   * stripping) before sanitizing orphaned tool messages.
   */
  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    const transformed = transformMessagesForProvider(messages, 'litellm');
    const sanitized = this.sanitizeToolMessages(transformed);
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
   *
   * A model is BOUND to its registered provider. Resolution is strict:
   *   - provider=litellm      → goes to the LiteLLM proxy
   *   - any other provider    → goes to that provider's direct implementation
   * There is NO fallback. If the bound provider fails, the error propagates
   * with its real cause. We never re-route one provider's model name to a
   * different provider — that masks bugs (stale config, missing API key,
   * provider down) behind confusing "model not found" errors.
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const resolvedModel = options.model || this.defaultModel;

    const { getProviderRouter } = await import('@/models/providers');
    const router = getProviderRouter();
    const provider = await router.resolveProvider(resolvedModel);

    if (provider.name === 'litellm') {
      modelLogger.debug(
        { model: resolvedModel, provider: 'litellm' },
        'Routing completion through LiteLLM proxy',
      );
      return this.completeViaProxy({ ...options, model: resolvedModel });
    }

    modelLogger.debug(
      { model: resolvedModel, provider: provider.name },
      'Routing completion through direct provider',
    );
    return provider.complete({ ...options, model: resolvedModel });
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

    // Merge extra body parameters (e.g. { think: false } for Ollama/Qwen3/Gemma4)
    // Pass via both top-level merge and extra_body to ensure params reach LiteLLM proxy
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.info({ model: params.model, messageCount: options.messages.length }, 'LLM request');

    try {
      const response = await this.client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'litellm');
      }
      const choice = response.choices[0];

      // Strip thinking/reasoning blocks from models that include them as content
      let content = choice.message.content || '';
      // XML-style: <think>...</think>, <thinking>...</thinking>
      content = content.replace(/<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/g, '').trim();
      // JSON-style: {"thought":"..."} or {"thinking":"..."}  (gemma4, etc.)
      content = content.replace(/\{"(?:thought|thinking|reasoning)"\s*:\s*"[\s\S]*?"\s*\}/g, '').trim();
      // Partial/malformed thinking JSON at start of response (e.g. {"thought": "<channel|>{")
      if (/^\s*\{"(?:thought|thinking|reasoning)"\s*:/.test(content)) {
        content = '';
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
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          if (tc.type !== 'function') {
            throw new Error(`Unexpected tool call type from litellm: ${tc.type}`);
          }
          let args: Record<string, unknown> = {};
          const rawArgs = tc.function.arguments || '';
          try {
            args = JSON.parse(rawArgs);
          } catch {
            modelLogger.warn(
              { toolName: tc.function.name, rawLength: rawArgs.length, raw: rawArgs.slice(0, 300) },
              'Failed to parse tool call arguments — JSON may be truncated. Tool will receive empty args.',
            );
          }
          return { id: tc.id, name: tc.function.name, arguments: args };
        });
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
      throw classifyError(error, 'litellm');
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

    let stream;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (err) {
      throw classifyError(err, 'litellm');
    }

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
   * Generate embeddings. Model is BOUND to its registered provider — no
   * fallbacks. If the bound provider doesn't implement embeddings, or the
   * provider call fails, the error propagates with its real cause.
   */
  async embed(text: string | string[], model?: string): Promise<number[][]> {
    const input = Array.isArray(text) ? text : [text];

    // Model resolution:
    //   1. Explicit arg (caller knows what they want) — wins.
    //   2. Topic binding for 'embedding' — user-configured.
    //   3. Fail LOUD — no hardcoded default.
    let embeddingModel = model;
    if (!embeddingModel) {
      const { getModelRegistry } = await import('@/models/model-registry');
      const bound = await getModelRegistry().getModelForTopic('embedding');
      embeddingModel = bound?.modelId;
    }
    if (!embeddingModel) {
      throw classifyError(
        new Error(
          "No embedding model configured. Bind a model to the 'embedding' topic in the Models page.",
        ),
        'embedding',
      );
    }

    const { getProviderRouter } = await import('@/models/providers');
    const router = getProviderRouter();
    const provider = await router.resolveProvider(embeddingModel);

    if (provider.name === 'litellm') {
      modelLogger.debug(
        { model: embeddingModel, provider: 'litellm', inputCount: input.length },
        'Routing embed through LiteLLM proxy',
      );
      return this.embedViaProxy(input, embeddingModel);
    }

    if (!provider.embed) {
      throw classifyError(
        new Error(
          `Provider '${provider.name}' bound to model '${embeddingModel}' does not implement embeddings. ` +
            `Re-register the model under a provider with embed support (ollama, openai, voyage) or change the model.`,
        ),
        provider.name,
      );
    }

    modelLogger.debug(
      { model: embeddingModel, provider: provider.name, inputCount: input.length },
      'Routing embed through direct provider',
    );
    return provider.embed(input, embeddingModel);
  }

  /** Internal: call embeddings against the LiteLLM proxy. */
  private async embedViaProxy(input: string[], embeddingModel: string): Promise<number[][]> {
    modelLogger.debug({ model: embeddingModel, inputCount: input.length }, 'Generating embeddings via LiteLLM proxy');

    try {
      const response = await this.client.embeddings.create({
        model: embeddingModel,
        input,
        encoding_format: 'float',
      });
      return response.data.map((d) => d.embedding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      modelLogger.error(
        { err, message, model: embeddingModel, proxyUrl: getConfig().litellm.proxyUrl },
        'LiteLLM proxy embedding request failed',
      );
      throw classifyError(err, 'litellm');
    }
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
      const { getModelRegistry: getVisionRegistry } = await import('@/models/model-registry');
      const visionModelEntry = await getVisionRegistry().getModelByModelId(options.model);

      // Use the model's configured provider from DB, not the name-based heuristic
      // (e.g. "deepseek-ocr:latest" is an Ollama model, not DeepSeek cloud)
      const dbProvider = visionModelEntry?.provider;
      const provider = dbProvider
        ? (router.getAllProviders().find(p => p.name === dbProvider) || router.getProvider(options.model))
        : router.getProvider(options.model);

      if (provider.name !== 'litellm') {
        modelLogger.info({ model: options.model, provider: provider.name }, 'Routing vision request through direct provider');
        const startTime = Date.now();

        // Resolve endpoint + API key for the model (supports per-model overrides)
        const { getVault } = await import('@/security/vault');
        const vault = getVault();
        const modelEndpoint = visionModelEntry?.endpoint;
        const modelApiKeyRef = visionModelEntry?.apiKeyRef;

        // Build endpoint + API key for each provider type
        const providerEndpoints: Record<string, { baseURL: string; vaultName: string; envVar: string }> = {
          ollama: { baseURL: `${modelEndpoint || getConfig().ollama.url || 'http://localhost:11434'}/v1`, vaultName: '', envVar: '' },
          openai: { baseURL: 'https://api.openai.com/v1', vaultName: 'openai_api_key', envVar: 'OPENAI_API_KEY' },
          anthropic: { baseURL: 'https://api.anthropic.com/v1/', vaultName: 'anthropic_api_key', envVar: 'ANTHROPIC_API_KEY' },
          gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', vaultName: 'gemini_api_key', envVar: 'GEMINI_API_KEY' },
          deepseek: { baseURL: 'https://api.deepseek.com/v1', vaultName: 'deepseek_api_key', envVar: 'DEEPSEEK_API_KEY' },
        };

        const pe = providerEndpoints[provider.name];
        if (!pe) throw classifyError(new Error(`Unsupported provider for vision: ${provider.name}`), provider.name);

        let apiKey = 'ollama';
        if (provider.name !== 'ollama') {
          apiKey = (modelApiKeyRef ? await vault.getByName('system', modelApiKeyRef) : null)
            || await vault.getByName('system', pe.vaultName)
            || process.env[pe.envVar]
            || '';
          if (!apiKey) throw classifyError(new Error(`No API key for ${provider.name}`), provider.name);
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
        if (!response.choices?.length) {
          throw classifyError(new Error(`Provider returned empty response (no choices) for model ${options.model}`), provider.name);
        }
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

      // provider.name === 'litellm' — route through the proxy for LiteLLM-bound
      // vision models. Any other fall-through here is a programmer error.
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
    } catch (err) {
      // Don't swallow. The bound provider failed — surface the real cause.
      modelLogger.error(
        { err, message: (err as Error).message, model: options.model },
        'Vision request failed',
      );
      throw err;
    }
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
