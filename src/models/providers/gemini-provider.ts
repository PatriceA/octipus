import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { modelLogger } from '@/utils/logger';
import type { AgentMessage } from '@/core/types';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Gemini direct provider -- calls the Google Gemini API through its
 * OpenAI-compatible endpoint without going through the LiteLLM proxy.
 * API key is retrieved from the vault at runtime.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    return modelName.toLowerCase().startsWith('gemini-');
  }

  /**
   * Cache raw assistant messages from Gemini to preserve thought_signature.
   * Keyed by sorted tool_call IDs so we can match when replaying.
   */
  private rawAssistantMessages = new Map<string, Record<string, unknown>>();

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('Gemini API key not available');
    const startTime = Date.now();

    // Build request body — only include params that are set.
    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.formatMessagesRaw(options.messages),
      stream: false,
    };

    if (options.temperature != null) body.temperature = options.temperature;
    if (options.maxTokens != null) body.max_tokens = options.maxTokens;
    if (options.topP != null) body.top_p = options.topP;
    if (options.stopSequences?.length) body.stop = options.stopSequences;

    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }

    if (options.extraBody) {
      const { response_format, ...rest } = options.extraBody as Record<string, unknown>;
      Object.assign(body, rest);
    }

    modelLogger.debug(
      { model: options.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Gemini',
    );

    const res = await fetch(`${GEMINI_BASE_URL}chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `Gemini API error (${res.status})`;
      try {
        const errArr = JSON.parse(errText);
        const errObj = Array.isArray(errArr) ? errArr[0] : errArr;
        errMsg = errObj?.error?.message || errMsg;
      } catch { errMsg = errText.slice(0, 300) || errMsg; }
      modelLogger.error({ status: res.status, error: errMsg, model: options.model, provider: this.name }, 'Gemini completion failed');
      throw new Error(errMsg);
    }

    const data = await res.json() as any;
    const latencyMs = Date.now() - startTime;
    const choice = data.choices?.[0];
    if (!choice) throw new Error('Gemini returned no choices');

    // Cache the raw assistant message keyed by tool_call IDs (preserves thought_signature)
    if (choice.message?.tool_calls?.length) {
      const tcIds = choice.message.tool_calls.map((tc: any) => tc.id).sort().join(',');
      this.rawAssistantMessages.set(tcIds, choice.message);
      // Evict old entries to prevent unbounded growth
      if (this.rawAssistantMessages.size > 50) {
        const firstKey = this.rawAssistantMessages.keys().next().value;
        if (firstKey) this.rawAssistantMessages.delete(firstKey);
      }
    }

    const result: CompletionResult = {
      content: choice.message?.content || '',
      finishReason: choice.finish_reason || 'stop',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
      model: data.model || options.model,
      latencyMs,
    };

    if (choice.message?.tool_calls?.length) {
      result.toolCalls = choice.message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments) : tc.function.arguments,
      }));
    }

    modelLogger.debug(
      { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
        latencyMs, hasToolCalls: !!result.toolCalls?.length, provider: this.name },
      'Gemini completion successful',
    );

    return result;
  }

  /**
   * Format messages for raw fetch, preserving Gemini-specific fields like thought_signature.
   * For assistant messages with tool_calls, we replay the raw cached message from Gemini
   * instead of reconstructing it (which would lose thought_signature).
   */
  private formatMessagesRaw(messages: AgentMessage[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId || 'unknown',
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Look up cached raw message by tool_call IDs (preserves thought_signature)
        const tcIds = msg.toolCalls.map(tc => tc.id).sort().join(',');
        const cachedMsg = this.rawAssistantMessages.get(tcIds);

        if (cachedMsg) {
          result.push(cachedMsg);
        } else {
          // Fallback: reconstruct (may be missing thought_signature for Gemini 3)
          modelLogger.warn({ toolCallIds: tcIds }, 'No cached raw Gemini message — thought_signature may be missing');
          result.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
              },
            })),
          });
        }
      } else if (msg.role === 'system') {
        // Gemini 2.0+ supports system role via OpenAI-compat endpoint
        result.push({ role: 'system', content: msg.content });
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      stream: true,
    };

    if (options.temperature != null) params.temperature = options.temperature;
    if (options.maxTokens != null) params.max_tokens = options.maxTokens;
    if (options.topP != null) params.top_p = options.topP;
    if (options.stopSequences?.length) params.stop = options.stopSequences;

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    if (options.extraBody) {
      const { response_format, ...rest } = options.extraBody as Record<string, unknown>;
      Object.assign(params, rest);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Gemini');

    const stream = await client.chat.completions.create(params);

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { content: delta.content };
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

  async checkHealth(): Promise<ProviderHealthStatus> {
    const startTime = Date.now();

    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        return { healthy: false, error: 'Gemini API key not configured' };
      }

      const client = new OpenAI({ baseURL: GEMINI_BASE_URL, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const client = await this.createClient();
    modelLogger.debug({ model, inputCount: texts.length, provider: this.name }, 'Generating embeddings via Gemini');

    const response = await client.embeddings.create({
      model,
      input: texts,
      encoding_format: 'float',
    });

    return response.data.map((d) => d.embedding);
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    // Check environment variable first
    if (process.env.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY;
    }

    // Fall back to vault
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'gemini_api_key');
      return value || null;
    } catch {
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Gemini API key not available. Set GEMINI_API_KEY or store it in the vault.');
    }

    return new OpenAI({
      baseURL: GEMINI_BASE_URL,
      apiKey,
      timeout: 120_000,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        // Gemini requires non-empty tool_call_id and string content
        return {
          role: 'tool' as const,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId || 'unknown',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Gemini requires content to be a string (not null) when tool_calls are present
        return {
          role: 'assistant' as const,
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            },
          })),
        };
      }

      // Gemini doesn't support 'system' role — convert to user message
      if (msg.role === 'system') {
        return {
          role: 'user' as const,
          content: msg.content,
        };
      }

      return {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };
    });
  }
}
