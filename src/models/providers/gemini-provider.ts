import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { sanitizeSchemaForGemini } from './custom/gemini-envelope';
import { sanitizeGeminiHistory } from './gemini-history';
import { fetchWithRetryAfter, withTimeoutSignal } from './http-retry';
import type { ModelProvider, ProviderHealthStatus } from './interface';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * The Gemini flash tier burns thinking tokens before emitting the tool call; a
 * 4096 cap lets thinking starve it. The OpenAI-compat endpoint does not expose
 * thinkingConfig, so raise the ceiling instead (documented tradeoff — item 7).
 */
const GEMINI_FLASH_MIN_MAX_TOKENS = 8192;

function isGeminiFlash(modelId: string): boolean {
  return /gemini-[\d.]*-?flash/i.test(modelId) || /flash/i.test(modelId);
}

/** Run every tool's parameters through the shared Gemini schema sanitizer (G2). */
export function sanitizeToolsForGemini(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return tools.map((t) => {
    if (t.type !== 'function') return t;
    return {
      ...t,
      function: {
        ...t.function,
        parameters: sanitizeSchemaForGemini(t.function.parameters) as Record<string, unknown>,
      },
    };
  });
}

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

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw classifyError(new Error('Gemini API key not available'), 'gemini');
    const startTime = Date.now();

    // Build request body — only include params that are set.
    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.formatMessagesRaw(sanitizeGeminiHistory(options.messages)),
      stream: false,
    };

    if (options.temperature != null) body.temperature = options.temperature;
    // Raise the flash-tier ceiling so thinking can't starve the tool call
    // (the compat endpoint doesn't accept thinkingConfig — item 7).
    if (options.maxTokens != null) {
      body.max_tokens = isGeminiFlash(options.model)
        ? Math.max(options.maxTokens, GEMINI_FLASH_MIN_MAX_TOKENS)
        : options.maxTokens;
    }
    if (options.topP != null) body.top_p = options.topP;
    if (options.stopSequences?.length) body.stop = options.stopSequences;

    if (options.tools?.length) {
      body.tools = sanitizeToolsForGemini(options.tools);
      body.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) {
      const { response_format, ...rest } = options.extraBody as Record<string, unknown>;
      Object.assign(body, rest);
    }

    modelLogger.debug(
      { model: options.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Gemini',
    );

    let res: Response;
    try {
      res = await fetchWithRetryAfter(`${GEMINI_BASE_URL}chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: withTimeoutSignal(120_000, options.signal),
      }, this.name);
    } catch (err) {
      throw classifyError(err, 'gemini');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `Gemini API error (${res.status})`;
      try {
        const errArr = JSON.parse(errText);
        const errObj = Array.isArray(errArr) ? errArr[0] : errArr;
        errMsg = errObj?.error?.message || errMsg;
      } catch { errMsg = errText.slice(0, 300) || errMsg; }
      modelLogger.error({ status: res.status, error: errMsg, model: options.model, provider: this.name }, 'Gemini completion failed');
      throw classifyError({ status: res.status, message: errMsg }, 'gemini');
    }

    const data = await res.json() as any;
    const latencyMs = Date.now() - startTime;
    const choice = data.choices?.[0];
    if (!choice) throw classifyError(new Error('Gemini returned no choices'), 'gemini');

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
      // Stash raw assistant message so thought_signature survives the next
      // turn. Travels on AgentMessage.providerRaw — no singleton, no eviction.
      ...(choice.message?.tool_calls?.length
        ? { providerRaw: choice.message as Record<string, unknown> }
        : {}),
    };

    if (choice.message?.tool_calls?.length) {
      result.toolCalls = choice.message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseToolCallArguments(tc.function.arguments, tc.function.name, this.name),
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
   * Format messages for raw fetch, preserving Gemini-specific fields like
   * thought_signature. For assistant messages with tool_calls, replay the
   * provider-raw payload captured on the prior turn (travels on the
   * AgentMessage itself — no provider-side singleton) instead of
   * reconstructing the message, which would lose thought_signature.
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
        if (msg.providerRaw) {
          result.push(msg.providerRaw);
        } else {
          // Fallback: reconstruct. Missing thought_signature — Gemini 3 may
          // degrade. Happens for assistant tool-call messages that weren't
          // produced by this provider on this conversation (e.g. session
          // restore from DB).
          modelLogger.warn(
            { toolCallIds: msg.toolCalls.map(tc => tc.id).join(',') },
            'No providerRaw on Gemini assistant message — thought_signature may be missing',
          );
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

    // Use the raw formatter (same as non-streaming complete()) so
    // thought_signature on cached assistant tool_calls and the `system`
    // role both survive. Without this, streaming sent a degraded
    // conversation while non-streaming sent the canonical one.
    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessagesRaw(sanitizeGeminiHistory(options.messages)) as ChatCompletionMessageParam[],
      stream: true,
    };

    if (options.temperature != null) params.temperature = options.temperature;
    if (options.maxTokens != null) {
      params.max_tokens = isGeminiFlash(options.model)
        ? Math.max(options.maxTokens, GEMINI_FLASH_MIN_MAX_TOKENS)
        : options.maxTokens;
    }
    if (options.topP != null) params.top_p = options.topP;
    if (options.stopSequences?.length) params.stop = options.stopSequences;

    if (options.tools?.length) {
      params.tools = sanitizeToolsForGemini(options.tools);
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) {
      const { response_format, ...rest } = options.extraBody as Record<string, unknown>;
      Object.assign(params, rest);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Gemini');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'gemini');
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    // G7: accumulate the raw streamed tool_calls so thought_signature can
    // round-trip on the terminal chunk (Gemini 3 degrades without it).
    const rawToolCalls: Array<Record<string, unknown>> = [];

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
          // Preserve any provider-side signature carried on the delta.
          const sig = (tc as unknown as Record<string, unknown>).thought_signature
            ?? (tc.function as unknown as Record<string, unknown> | undefined)?.thought_signature;
          if (sig != null) (buffer as unknown as Record<string, unknown>).thought_signature = sig;

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
        if (toolCallBuffers.size > 0) {
          for (const buf of toolCallBuffers.values()) {
            const bufSig = (buf as unknown as Record<string, unknown>).thought_signature;
            rawToolCalls.push({
              id: buf.id,
              type: 'function',
              function: { name: buf.name, arguments: buf.arguments },
              ...(bufSig != null ? { thought_signature: bufSig } : {}),
            });
          }
          yield {
            finishReason: chunk.choices[0].finish_reason,
            providerRaw: { role: 'assistant', tool_calls: rawToolCalls },
          };
        } else {
          yield { finishReason: chunk.choices[0].finish_reason };
        }
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

    // Fall back to vault — recoverable: null return triggers a classified AUTH_FAILED on createClient()
    try {
      const { getVault } = await import('@/security/vault');
      const vault = getVault();
      const value = await vault.getByName('system', 'gemini_api_key');
      return value || null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'Gemini vault lookup failed; falling back to env var');
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('Gemini API key not available. Set GEMINI_API_KEY or store it in the vault.'), 'gemini');
    }

    return new OpenAI({
      baseURL: GEMINI_BASE_URL,
      apiKey,
      timeout: 120_000,
      maxRetries: 2,
    });
  }

}
