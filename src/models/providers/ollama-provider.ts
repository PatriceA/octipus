import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { getConfig } from '@/config';
import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage } from '@/core/types';
import { repairTruncatedJson } from '@/utils/json-repair';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

/**
 * Known cloud provider model prefixes. If a model name starts with any of these,
 * it is NOT an Ollama model.
 */
const CLOUD_PREFIXES = [
  'gpt-',
  'o1-',
  'o3-',
  'claude-',
  'gemini-',
  'deepseek-',
  'dall-e-',
  'chatgpt-',
  'cli/',
  'text-embedding-',
  'whisper-',
  'tts-',
  'voyage-',
];

/** Reject model names that look like OpenRouter slugs (contain `/` but aren't `cli/`) */
function looksLikeOpenRouterSlug(name: string): boolean {
  return name.includes('/') && !name.startsWith('cli/');
}

/** A single progress update from a streamed `ollama pull`. */
export interface PullProgress {
  /** Ollama status string, e.g. 'pulling manifest', 'downloading …', 'success'. */
  status: string;
  /** Total bytes for the current layer, when reported. */
  total?: number;
  /** Bytes downloaded so far for the current layer, when reported. */
  completed?: number;
  /** Derived 0–100 percentage for the current layer (total & completed present). */
  percent?: number;
}

/**
 * Parse one NDJSON line from `POST /api/pull`. Returns a PullProgress, an
 * `{ error }` object when Ollama reports a failure, or null for blank/unparsable
 * lines. Pure + exported for unit testing against captured stream output.
 */
export function parsePullLine(line: string): PullProgress | { error: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: { status?: string; error?: string; total?: number; completed?: number };
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // A non-object JSON value (null, number, string) has no fields to read.
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.error === 'string') return { error: obj.error };
  if (typeof obj.status !== 'string') return null;
  const progress: PullProgress = { status: obj.status };
  if (typeof obj.total === 'number') progress.total = obj.total;
  if (typeof obj.completed === 'number') progress.completed = obj.completed;
  if (progress.total && progress.total > 0 && typeof progress.completed === 'number') {
    progress.percent = Math.min(100, Math.round((progress.completed / progress.total) * 100));
  }
  return progress;
}

/** Apply a parsed pull line: throw on error (fail loud), else report progress. */
function handlePullLine(line: string, model: string, onProgress?: (p: PullProgress) => void): void {
  const parsed = parsePullLine(line);
  if (!parsed) return;
  if ('error' in parsed) {
    throw new Error(`Ollama pull failed for "${model}": ${parsed.error}`);
  }
  onProgress?.(parsed);
}

/**
 * Ollama provider -- connects directly to a local Ollama server via its
 * OpenAI-compatible API at {endpoint}/v1.
 */
export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  readonly type = 'direct' as const;

  private fixedEndpoint?: string;

  constructor(endpoint?: string) {
    this.fixedEndpoint = endpoint;
  }

  private get endpoint(): string {
    const url = this.fixedEndpoint || getConfig().ollama.url;
    if (!url) throw new Error('Ollama URL not configured');
    return url;
  }

  /**
   * Returns true when the model name does not match any known cloud provider prefix.
   * This is a heuristic: Ollama hosts open-weight models whose names typically
   * do not overlap with cloud API model identifiers.
   */
  supportsModel(modelName: string): boolean {
    // If Ollama is not configured, don't claim to support any model
    if (!this.fixedEndpoint && !getConfig().ollama.url) return false;
    const lower = modelName.toLowerCase();
    if (CLOUD_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
    if (looksLikeOpenRouterSlug(lower)) return false;
    return true;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    // Ollama's /v1 endpoint doesn't properly honor think:false OR
    // response_format:json_object — both are reliable only on the native
    // /api/chat endpoint (think:false flag, format:'json' field). Route there
    // when either is requested so small local models actually return parseable
    // JSON instead of prose the caller has to repair.
    if (options.extraBody?.think === false || options.responseFormat?.type === 'json_object') {
      return this.completeNative(options);
    }

    const client = this.createClient(options.endpoint, options.apiKey);
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      response_format: options.responseFormat,
      stream: false,
    };
    this.applyKeepAlive(params);

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (but NOT think:false — that goes to native endpoint)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Ollama'
    );

    try {
      const response = await client.chat.completions.create(params);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`);
      }
      const choice = response.choices[0];

      // Qwen3/thinking models may put output in 'reasoning' instead of 'content'
      const msg = choice.message as unknown as Record<string, unknown>;
      const content = (choice.message.content || msg.reasoning || '') as string;

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
            throw new Error(`Unexpected tool call type from ${this.name}: ${tc.type}`);
          }
          const rawArgs = tc.function.arguments || '';
          try {
            return { id: tc.id, name: tc.function.name, arguments: JSON.parse(rawArgs) as Record<string, unknown> };
          } catch (parseErr) {
            const repaired = repairTruncatedJson(rawArgs);
            if (repaired) {
              try {
                const parsed = JSON.parse(repaired) as Record<string, unknown>;
                modelLogger.warn(
                  { toolName: tc.function.name, rawLength: rawArgs.length, provider: this.name },
                  'Recovered truncated tool-call JSON via repairTruncatedJson',
                );
                return { id: tc.id, name: tc.function.name, arguments: parsed };
              } catch { /* fall through */ }
            }
            throw new ClassifiedError({
              reason: FailoverReason.TOOL_CALL_INVALID,
              recovery: RecoveryAction.RETRY_NOW,
              message: `Malformed tool call JSON from ${this.name} for tool "${tc.function.name}": ${(parseErr as Error).message}`,
              providerHint: this.name,
              metadata: { toolName: tc.function.name, raw: rawArgs.slice(0, 300) },
              cause: parseErr,
            });
          }
        });
      }

      modelLogger.debug(
        {
          model: response.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs,
          hasToolCalls: !!result.toolCalls?.length,
          provider: this.name,
        },
        'Ollama completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStatus: (error as { status?: unknown })?.status,
          errorCode: (error as { code?: unknown })?.code,
          model: params.model,
          provider: this.name,
        },
        'Ollama completion failed'
      );
      throw classifyError(error, this.name);
    }
  }

  /**
   * Use Ollama's native /api/chat endpoint which properly supports think:false.
   * The OpenAI-compatible /v1 endpoint ignores this parameter.
   * Supports tools via Ollama's native tool calling format.
   */
  private async completeNative(options: CompletionOptions): Promise<CompletionResult> {
    const resolvedEndpoint = options.endpoint || this.endpoint;
    const startTime = Date.now();

    // Native /api/chat shape (per https://docs.ollama.com/capabilities/tool-calling):
    //   - tool messages keyed by `tool_name` (not `tool_call_id`)
    //   - assistant.tool_calls[].function.arguments is an OBJECT (not stringified)
    // The OpenAI /v1 formatter does the opposite — don't reuse it here.
    const messages = this.formatMessagesNative(options.messages);

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: false,
      think: false,
      // Keep the model resident in VRAM between calls so we don't pay the
      // (slow on iGPU) cold-load every request — the root cause of timeout loops.
      keep_alive: getConfig().ollama.keepAlive,
      // Native JSON mode: constrains decoding to valid JSON. This is Ollama's
      // real structured-output lever (the /v1 response_format is unreliable).
      ...(options.responseFormat?.type === 'json_object' ? { format: 'json' } : {}),
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        ...(options.topP != null ? { top_p: options.topP } : {}),
        ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
      },
    };

    // Add tools in Ollama's native format
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => {
        if (t.type !== 'function') {
          throw new Error(`Unsupported tool type for ${this.name}: ${t.type}`);
        }
        return {
          type: 'function',
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        };
      });
    }

    modelLogger.debug(
      { model: options.model, messageCount: messages.length, provider: this.name, native: true, hasTools: !!options.tools?.length },
      'Sending native completion request to Ollama (think:false)'
    );

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

    const response = await fetch(`${resolvedEndpoint}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(getConfig().ollama.requestTimeout),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw classifyError({ status: response.status, message: err || 'Ollama native API error' }, 'ollama');
    }

    const data = await response.json() as {
      message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
      done: boolean;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const latencyMs = Date.now() - startTime;

    const result: CompletionResult = {
      content: data.message.content || '',
      finishReason: data.done_reason || 'stop',
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      model: options.model,
      latencyMs,
    };

    // Parse tool calls from native response
    if (data.message.tool_calls?.length) {
      result.toolCalls = data.message.tool_calls.map((tc, i) => ({
        id: `call_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }

    modelLogger.debug(
      {
        model: options.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs,
        hasToolCalls: !!result.toolCalls?.length,
        provider: this.name,
        native: true,
      },
      'Ollama native completion successful'
    );

    return result;
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    // think:false must go through native /api/chat (the /v1 endpoint
    // ignores the flag). Implement as non-streamed native completion
    // yielded as a single chunk — matches complete()'s branch on line 76.
    if (options.extraBody?.think === false) {
      const result = await this.completeNative(options);
      if (result.content) yield { content: result.content };
      if (result.toolCalls?.length) {
        for (const tc of result.toolCalls) {
          yield {
            toolCallDelta: {
              id: tc.id,
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            },
          };
        }
      }
      yield { finishReason: result.finishReason };
      return;
    }

    const client = this.createClient(options.endpoint, options.apiKey);

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    };
    this.applyKeepAlive(params);

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Ollama');

    const stream = await client.chat.completions.create(params);

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // Qwen3/thinking models may stream output in 'reasoning' instead of 'content'
      const deltaAny = delta as Record<string, unknown> | undefined;
      const text = delta?.content || (deltaAny?.reasoning as string | undefined);
      if (text) {
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

  async embed(texts: string[], model: string, endpoint?: string): Promise<number[][]> {
    const client = this.createClient(endpoint);

    modelLogger.debug(
      { model, inputCount: texts.length, provider: this.name },
      'Generating embeddings via Ollama'
    );

    const response = await client.embeddings.create({
      model,
      input: texts,
      encoding_format: 'float',
    });

    return response.data.map((d) => d.embedding);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const url = this.fixedEndpoint || getConfig().ollama.url;
    if (!url) {
      return { healthy: false, error: 'Ollama URL not configured' };
    }

    const startTime = Date.now();

    try {
      const response = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { healthy: false, error: `Ollama HTTP ${response.status}` };
      }

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  /**
   * Pull (download) a model into the local Ollama server via POST /api/pull.
   * Streams NDJSON progress; invokes onProgress per line. Fails loud — throws
   * on transport errors or any error line from Ollama (DESIGN.md rule #1).
   */
  async pull(model: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    const url = `${this.endpoint}/api/pull`;
    // A model pull can legitimately take many minutes, but a hung server must
    // not block the job forever — bound it.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama pull failed for "${model}": HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const drain = (chunk: string, flush: boolean) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handlePullLine(line, model, onProgress);
        nl = buffer.indexOf('\n');
      }
      if (flush && buffer.trim()) handlePullLine(buffer, model, onProgress);
    };

    // Always release the stream lock — handlePullLine throws on an Ollama error
    // line, which must not leak the reader/connection.
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        drain(decoder.decode(value, { stream: true }), false);
      }
      drain(decoder.decode(), true);
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  // -- Private helpers --

  /**
   * Attach Ollama's `keep_alive` to an OpenAI-shaped /v1 params object so the
   * model stays warm in VRAM between calls. Best-effort on /v1 (Ollama honors it
   * reliably on native /api/chat); the server-side OLLAMA_KEEP_ALIVE is the
   * robust backstop. Centralized so the one unavoidable cast lives in one place.
   */
  private applyKeepAlive(params: ChatCompletionCreateParams): void {
    (params as unknown as Record<string, unknown>).keep_alive = getConfig().ollama.keepAlive;
  }

  private createClient(endpointOverride?: string, apiKeyOverride?: string): OpenAI {
    const base = endpointOverride || this.endpoint;
    return new OpenAI({
      baseURL: `${base}/v1`,
      apiKey: apiKeyOverride || 'ollama',
      timeout: getConfig().ollama.requestTimeout,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        // Ollama's OpenAI-compat endpoint requires tool_call_id to match the
        // assistant's tool_calls[].id exactly, and content must be a string.
        // Ensure content is always a plain string (not undefined/null).
        return {
          role: 'tool' as const,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId || 'call_0',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Ollama requires content to be null (not empty string) when tool_calls are present.
        // Some Ollama versions reject the message if content is '' alongside tool_calls.
        return {
          role: 'assistant' as const,
          content: msg.content?.trim() || null,
          tool_calls: msg.toolCalls.map((tc, i) => ({
            id: tc.id || `call_${i}`,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
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
   * Format messages for Ollama's NATIVE /api/chat endpoint.
   * Differs from the /v1 (OpenAI-compat) shape:
   *   - tool messages use `tool_name` (not `tool_call_id`)
   *   - assistant.tool_calls[].function.arguments is an OBJECT (not string)
   *   - no `type: 'function'` wrapper on tool_calls
   * Per https://docs.ollama.com/capabilities/tool-calling
   */
  private formatMessagesNative(messages: AgentMessage[]): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        const native: Record<string, unknown> = {
          role: 'tool',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
        if (msg.name) native.tool_name = msg.name;
        return native;
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string'
                ? (() => { try { return JSON.parse(tc.arguments); } catch { return {}; } })()
                : tc.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
    });
  }
}
