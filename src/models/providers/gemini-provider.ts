import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

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
   * Gemini rejects sequences where a function_call is not immediately followed
   * by its function_response, or where a function_response has no preceding
   * function_call. Compaction can break these pairs, so sanitize before send.
   *
   * Rules applied:
   * 1. If an assistant(tool_calls) message lacks ALL matching tool responses
   *    directly after it, strip the tool_calls (keep any text content, else drop).
   * 2. If any tool_call has no matching tool response, drop that specific call.
   * 3. Drop tool messages whose tool_call_id is not declared by the immediately
   *    preceding assistant message.
   */
  private sanitizeMessages(messages: AgentMessage[]): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Collect immediately following tool responses
        const responses = new Map<string, AgentMessage>();
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          const tid = messages[j].toolCallId;
          if (tid) responses.set(tid, messages[j]);
          j++;
        }
        const keptCalls = msg.toolCalls.filter(tc => responses.has(tc.id));
        if (keptCalls.length === 0) {
          // No valid calls — emit text-only assistant if there's content, else drop
          if (msg.content && String(msg.content).trim()) {
            out.push({ ...msg, toolCalls: undefined });
          }
        } else {
          // Gemini: function_call must follow a user or function_response turn.
          // If prev emitted message isn't one of those (e.g. system summary, or
          // another assistant), inject a synthetic user turn.
          const prev = out[out.length - 1];
          const prevOk = prev && (prev.role === 'user' || prev.role === 'tool');
          if (!prevOk) {
            out.push({ role: 'user', content: '(continuing)', timestamp: new Date() } as AgentMessage);
          }
          out.push({ ...msg, toolCalls: keptCalls });
          for (const tc of keptCalls) out.push(responses.get(tc.id)!);
        }
        i = j - 1;
        continue;
      }

      if (msg.role === 'tool') {
        // Orphan tool response (preceding assistant wasn't a tool_calls msg) — drop
        continue;
      }

      out.push(msg);
    }
    return out;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw classifyError(new Error('Gemini API key not available'), 'gemini');
    const startTime = Date.now();

    // Build request body — only include params that are set.
    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.formatMessagesRaw(this.sanitizeMessages(options.messages)),
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

    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE_URL}chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
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
      messages: this.formatMessagesRaw(this.sanitizeMessages(options.messages)) as ChatCompletionMessageParam[],
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

    let stream;
    try {
      stream = await client.chat.completions.create(params);
    } catch (err) {
      throw classifyError(err, 'gemini');
    }

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
