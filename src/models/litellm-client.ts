import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { getConfig } from '@/config';
import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import type { AgentMessage, ToolCall } from '@/core/types';
import { coerceDeepseekToolChoice, DEEPSEEK_TEMPLATE_LEAK, parseDsmlToolCalls } from '@/models/deepseek-template-recovery';
import { transformMessagesForProvider } from '@/models/message-transform';
import { parseToolCallArguments } from '@/models/tool-call-args';
import { extractCachedTokens } from '@/models/providers/usage';
import { applyAnthropicCacheControl, isAnthropicFamily } from '@/models/providers/prompt-cache';
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
  /**
   * Tool-calling policy. Maps per provider: OpenAI-style `tool_choice`,
   * Anthropic `tool_choice.{type}`, native Gemini `functionCallingConfig.mode`.
   * 'required' forces at least one tool call (Gemini ANY); used by the
   * agent-worker's one-shot escalation after a recovered/shimmed turn.
   */
  toolChoice?: 'auto' | 'required' | 'none';
  /**
   * Caller abort signal. Threaded into every provider's fetch/SDK call so
   * AgentWorker.stop() cancels in-flight requests instead of letting a
   * 30-min DeepSeek / 60-min Grok timeout run to completion.
   */
  signal?: AbortSignal;
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
   * Calling session ID — used as a stable prompt-cache affinity key for
   * providers that route by one (Mistral `prompt_cache_key`, Grok
   * `x-grok-conv-id`). Same session ⇒ same static prefix, so this maximizes
   * cache-hit likelihood. Hashed before sending (no raw id / PII on the wire).
   */
  sessionId?: string;
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
  /**
   * Provider-specific opaque payload that must be echoed verbatim on the
   * next turn (e.g. Gemini `thought_signature` on tool-calling assistant
   * messages). Propagated onto the AgentMessage so it travels with the
   * conversation instead of living in a provider-side singleton.
   */
  providerRaw?: Record<string, unknown>;
}

export interface StreamChunk {
  content?: string;
  toolCallDelta?: {
    id: string;
    name?: string;
    arguments?: string;
  };
  finishReason?: string;
  /**
   * Provider-specific opaque payload (e.g. Gemini `thought_signature`) carried
   * on the terminal chunk so streamed tool calls can round-trip signatures.
   */
  providerRaw?: Record<string, unknown>;
  /** DeepSeek/Magistral reasoning chain surfaced on the final chunk. */
  reasoningContent?: string;
}

const THINKING_KEYS = new Set(['thought', 'thinking', 'reasoning']);

/** Extract the leading balanced JSON object from a string, or null. */
function leadingJsonObject(s: string): string | null {
  const start = s.search(/\{/);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function isPureThinkingObject(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => THINKING_KEYS.has(k));
}

/**
 * Strip a leaked JSON thinking wrapper ({"thought":"…"}) from content WITHOUT
 * corrupting real structured output (A1).
 *   - Whole content is valid JSON: strip only if it's a pure thinking object
 *     (all keys ∈ {thought,thinking,reasoning}); otherwise keep — it's a real
 *     JSON/ReAct response.
 *   - Otherwise, if content starts with a thinking wrapper: peel the leading
 *     balanced object off and keep the remainder; if that object is truncated/
 *     malformed (gemma4 preamble), blank the whole thing.
 */
export function stripJsonThinkingLeak(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    return isPureThinkingObject(parsed) ? '' : content;
  } catch { /* not whole-JSON — fall through */ }

  if (!/^\s*\{\s*"(?:thought|thinking|reasoning)"\s*:/.test(trimmed)) return content;
  const lead = leadingJsonObject(trimmed);
  if (!lead) return ''; // truncated/malformed thinking preamble
  try {
    if (isPureThinkingObject(JSON.parse(lead))) return trimmed.slice(lead.length).trim();
  } catch { /* malformed */ }
  return '';
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longest suffix of `s` that is a proper prefix of `tag` (for split-tag carry). */
function partialTagSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * Streaming `<think>…</think>` filter that survives tags split across chunk
 * boundaries (item 24). `push` returns emittable text; `flush` returns any
 * remainder at stream end — an unclosed think block is emitted as content
 * (never silently swallowed) with `discarded=false` so the caller can log.
 */
export function createThinkStreamFilter() {
  let carry = '';
  let inside = false;
  return {
    push(text: string): string {
      carry += text;
      let out = '';
      for (;;) {
        if (inside) {
          const close = carry.indexOf(THINK_CLOSE);
          if (close === -1) break; // retain buffered think content; wait for close
          carry = carry.slice(close + THINK_CLOSE.length);
          inside = false;
          continue;
        }
        const open = carry.indexOf(THINK_OPEN);
        if (open === -1) {
          // Hold back a possible partial open tag at the tail.
          const keep = partialTagSuffix(carry, THINK_OPEN);
          out += carry.slice(0, carry.length - keep);
          carry = carry.slice(carry.length - keep);
          break;
        }
        out += carry.slice(0, open);
        carry = carry.slice(open + THINK_OPEN.length);
        inside = true;
      }
      return out;
    },
    /**
     * @returns leftover text + whether a think block was left unclosed. When
     * unclosed, `text` is the buffered think content — emit it as content so an
     * unterminated <think> can never silently swallow the whole stream.
     */
    flush(): { text: string; unclosed: boolean } {
      const text = carry;
      const unclosed = inside;
      carry = '';
      inside = false;
      return { text, unclosed };
    },
  };
}

/**
 * Client for LiteLLM proxy - provides unified API for all LLM providers
 */
export class LiteLLMClient {
  private client: OpenAI;
  private defaultModel: string;

  constructor() {
    const config = getConfig();

    // 'sk-litellm' is a placeholder for keyless proxies (the OpenAI SDK requires
    // a non-empty apiKey). If the proxy DOES enforce a master key, this
    // placeholder 401s with a confusing "Invalid proxy server token" — so warn
    // loudly when we fall back, rather than fail silently. A configured key
    // lives in the vault (litellm_api_key) and is resolved into config by
    // loadRuntimeConfig(); if it's missing here, config wasn't fully loaded
    // before this client was built (see the reset in src/index.ts).
    if (!config.litellm.apiKey) {
      modelLogger.warn(
        { proxyUrl: config.litellm.proxyUrl },
        'LiteLLM apiKey not set in config — using placeholder "sk-litellm". ' +
          'Completions will 401 if the proxy enforces a master key. ' +
          'Check the litellm_api_key vault secret and config load order.',
      );
    }

    this.client = new OpenAI({
      baseURL: config.litellm.proxyUrl,
      apiKey: config.litellm.apiKey || 'sk-litellm',
      timeout: config.litellm.timeout,
      maxRetries: config.litellm.maxRetries,
    });

    this.defaultModel = 'gpt-oss'; // Fallback; actual default resolved from DB via ModelRegistry
  }

  /**
   * Convert internal message format to OpenAI format.
   * Cross-model transformation (ID normalization, thinking-block stripping,
   * tool-call/tool-message pairing) now lives in transformMessagesForProvider.
   */
  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    const sanitized = transformMessagesForProvider(messages, 'litellm');
    return sanitized.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId || '',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Echo back deepseek-reasoner's reasoning_content on assistant turns.
        // The proxy forwards this verbatim to DeepSeek; without it, DeepSeek
        // 400s with "reasoning_content in the thinking mode must be passed
        // back". Other upstreams ignore the field.
        const out: ChatCompletionMessageParam & { reasoning_content?: string } = {
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
        // DeepSeek thinking models 400 ("reasoning_content ... must be passed
        // back") if an assistant tool_calls turn omits reasoning_content — and
        // that happens whenever it wasn't captured: an empty/whitespace
        // reasoning from the model (dropped by the truthy guard on capture),
        // or a recovered/synthetic tool-call turn. Always emit the field;
        // fall back to a minimal placeholder. Non-DeepSeek upstreams ignore it.
        out.reasoning_content = msg.reasoningContent || ' ';
        return out;
      }

      const base: ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
      if (msg.role === 'assistant' && msg.reasoningContent) {
        base.reasoning_content = msg.reasoningContent;
      }
      return base;
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
      // completeViaProxy logs its own LLM request/completion — it also has
      // direct callers (evaluators, red-team) that never pass through here.
      return this.completeViaProxy({ ...options, model: resolvedModel });
    }

    // Per-model endpoint + apiKey overrides. Direct providers (e.g. Ollama
    // pointed at a second host) only see these if the caller passes them.
    // Most callers don't — they look up the model from the registry for
    // routing and forget that the endpoint travels with the row. Resolve
    // here so every caller benefits; explicit options still win.
    const enriched = await this.applyModelOverrides({ ...options, model: resolvedModel });

    // Log the direct-provider path here (Ollama, OpenAI, custom-openai/
    // anthropic/gemini). The proxy path is logged inside completeViaProxy, so
    // logging only the direct branch gives exactly-once coverage with no
    // double logging. Before this, the direct branch was silent, so a research
    // run on a custom-openai model produced no "LLM request" line at all.
    modelLogger.info(
      { model: resolvedModel, provider: provider.name, messageCount: options.messages.length },
      'LLM request',
    );
    const startTime = Date.now();
    const result = await provider.complete(enriched);
    modelLogger.info(
      {
        model: result.model || resolvedModel,
        provider: provider.name,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        latencyMs: result.latencyMs ?? Date.now() - startTime,
        hasToolCalls: !!result.toolCalls?.length,
        finishReason: result.finishReason,
      },
      'LLM completion',
    );
    return result;
  }

  /**
   * Merge per-model `endpoint` and `apiKey` from the registry into the
   * caller's options. Caller-supplied values win. Returns options unchanged
   * if the model isn't in the registry, or already has both fields set.
   */
  private async applyModelOverrides(options: CompletionOptions): Promise<CompletionOptions> {
    if (options.endpoint && options.apiKey) return options;
    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const entry = await getModelRegistry().getModelByModelId(options.model);
      if (!entry) return options;

      const next: CompletionOptions = { ...options };
      if (!next.endpoint && entry.endpoint) next.endpoint = entry.endpoint;

      if (!next.apiKey && entry.apiKeyRef) {
        const { getVault } = await import('@/security/vault');
        const vault = getVault();
        // Prefer the user's vault namespace when a userId is in scope, then
        // fall back to the system namespace. This matches the resolution
        // order used by the vision path.
        const key = (options.userId
          ? await vault.getByName(options.userId, entry.apiKeyRef).catch(() => null)
          : null)
          || await vault.getByName('system', entry.apiKeyRef).catch(() => null);
        if (key) next.apiKey = key;
      }
      return next;
    } catch (err) {
      modelLogger.warn({ err, model: options.model }, 'Failed to resolve per-model overrides; using caller options as-is');
      return options;
    }
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

    // Anthropic prompt caching (Phase A1): the proxy forwards `cache_control`
    // content blocks to Anthropic upstreams, so cache the static prefix.
    if (isAnthropicFamily(params.model || '')) applyAnthropicCacheControl(params.messages);

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = coerceDeepseekToolChoice(params.model || '', options.toolChoice) ?? 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Ollama/Qwen3/Gemma4)
    // Pass via both top-level merge and extra_body to ensure params reach LiteLLM proxy
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.info({ model: params.model, provider: 'litellm', messageCount: options.messages.length }, 'LLM request');

    try {
      const response = await this.client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'litellm');
      }
      const choice = response.choices[0];

      // Strip thinking/reasoning blocks from models that include them as content.
      // A1: skip JSON-style stripping under json_object — a JSON-mode/ReAct
      // orchestration legitimately produces {"thought":…}-shaped output. XML
      // stripping is always safe.
      let content = choice.message.content || '';
      content = content.replace(/<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/g, '').trim();
      if (options.responseFormat?.type !== 'json_object') {
        content = stripJsonThinkingLeak(content);
      }

      // Capture reasoning_content for deepseek-reasoner routed via LiteLLM
      // (the field travels outside the OpenAI SDK's typed shape). Round-tripped
      // back into the next assistant message by formatMessages above.
      const reasoningContent = (choice.message as { reasoning_content?: string }).reasoning_content;

      const result: CompletionResult = {
        content,
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
          // OpenAI/Anthropic/DeepSeek-via-proxy cached-read normalization.
          ...extractCachedTokens(response.usage),
        },
        model: response.model,
        latencyMs,
        ...(reasoningContent ? { reasoningContent } : {}),
      };

      // DeepSeek native-template leak recovery — fires for any DeepSeek
      // model routed through LiteLLM (e.g. `deepseek-v4-pro-litellm`) since
      // the direct DeepSeek provider doesn't see those. See the direct
      // provider's matching block for context.
      if (!choice.message.tool_calls?.length && DEEPSEEK_TEMPLATE_LEAK.test(content)) {
        const recovered = parseDsmlToolCalls(content);
        if (recovered.length) {
          modelLogger.warn(
            {
              model: response.model,
              recoveredCount: recovered.length,
              recoveredTools: recovered.map((tc) => tc.name),
              provider: 'litellm',
            },
            'DeepSeek-via-litellm emitted native DSML/template markup in content channel — recovered as structured tool_calls',
          );
          result.toolCalls = recovered;
          result.content = '';
          return result;
        }
        modelLogger.warn(
          { model: response.model, contentPreview: content.slice(0, 200), provider: 'litellm' },
          'DeepSeek-via-litellm emitted native tool-call template in content channel — recovery failed, forcing retry',
        );
        throw new ClassifiedError({
          reason: FailoverReason.TOOL_CALL_INVALID,
          recovery: RecoveryAction.RETRY_NOW,
          message: `DeepSeek chat-template leak via litellm: tool-call markup emitted as content, unrecoverable`,
          providerHint: 'litellm',
          metadata: { contentPreview: content.slice(0, 300) },
        });
      }

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          if (tc.type !== 'function') {
            throw new Error(`Unexpected tool call type from litellm: ${tc.type}`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: parseToolCallArguments(tc.function.arguments, tc.function.name, 'litellm'),
          };
        });
      }

      modelLogger.info(
        {
          model: response.model,
          provider: 'litellm',
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
    const resolvedModel = options.model || this.defaultModel;

    // A2: DB-first resolution (resolveProvider), not the name-based heuristic —
    // so a model like "deepseek-ocr" configured on Ollama streams from the
    // right provider. Only fall back to the proxy when the direct stream failed
    // BEFORE yielding anything; re-streaming mid-flight duplicates partial
    // output, so once a chunk is out we must propagate the error, not retry.
    let router: import('@/models/providers').ProviderRouter | undefined;
    let provider: import('@/models/providers').ModelProvider | undefined;
    try {
      const { getProviderRouter } = await import('@/models/providers');
      router = getProviderRouter();
      provider = await router.resolveProvider(resolvedModel);
    } catch {
      provider = undefined;
    }

    if (router && provider && provider.name !== 'litellm') {
      modelLogger.info(
        { model: resolvedModel, provider: provider.name, messageCount: options.messages.length, stream: true },
        'LLM request',
      );
      let yielded = false;
      try {
        for await (const chunk of router.stream({ ...options, model: resolvedModel })) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (yielded) throw classifyError(err, provider.name);
        modelLogger.warn(
          { model: resolvedModel, provider: provider.name, err: (err as Error).message },
          'Direct stream failed before first chunk — falling back to LiteLLM proxy',
        );
        // fall through to proxy
      }
    }

    modelLogger.info(
      { model: resolvedModel, provider: 'litellm', messageCount: options.messages.length, stream: true },
      'LLM request',
    );
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

    if (isAnthropicFamily(params.model || '')) applyAnthropicCacheControl(params.messages);

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = coerceDeepseekToolChoice(params.model || '', options.toolChoice) ?? 'auto';
    }

    // Merge extra body parameters (e.g. { think: false } for Ollama Qwen3)
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model }, 'Starting streaming completion via LiteLLM proxy');

    let stream;
    try {
      stream = await this.client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'litellm');
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    const think = createThinkStreamFilter();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        const emit = think.push(delta.content);
        if (emit) yield { content: emit };
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
        // Flush any held text (partial tag) / unclosed think buffer BEFORE the
        // terminal chunk so it's never swallowed silently.
        const { text, unclosed } = think.flush();
        if (unclosed) {
          modelLogger.warn(
            { model: params.model },
            'Stream ended inside an unclosed <think> block — emitting remaining buffer as content',
          );
        }
        if (text) yield { content: text };
        yield { finishReason: chunk.choices[0].finish_reason };
      }
    }

    // Stream ended without an explicit finish_reason — still flush.
    const tail = think.flush();
    if (tail.unclosed) {
      modelLogger.warn({ model: params.model }, 'Stream ended inside an unclosed <think> block (no finish_reason) — emitting buffer');
    }
    if (tail.text) yield { content: tail.text };
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

    // Resolve per-model endpoint from DB (e.g. Ollama on a custom URL)
    let modelEndpoint: string | undefined;
    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const dbModel = await getModelRegistry().getModelByModelId(embeddingModel);
      modelEndpoint = dbModel?.endpoint || undefined;
    } catch { /* non-fatal */ }

    modelLogger.debug(
      { model: embeddingModel, provider: provider.name, inputCount: input.length, endpoint: modelEndpoint },
      'Routing embed through direct provider',
    );
    return provider.embed(input, embeddingModel, modelEndpoint);
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
          openrouter: { baseURL: 'https://openrouter.ai/api/v1', vaultName: 'openrouter_api_key', envVar: 'OPENROUTER_API_KEY' },
          mistral: { baseURL: 'https://api.mistral.ai/v1', vaultName: 'mistral_api_key', envVar: 'MISTRAL_API_KEY' },
          // z.ai (GLM-4.xV) and Moonshot (moonshot-v1-*-vision / Kimi native) —
          // OpenAI-compatible multimodal. Only models flagged supportsVision route here.
          zai: { baseURL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4', vaultName: 'zai_api_key', envVar: 'ZAI_API_KEY' },
          moonshot: { baseURL: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1', vaultName: 'moonshot_api_key', envVar: 'MOONSHOT_API_KEY' },
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
          ...(provider.name === 'openrouter' && {
            defaultHeaders: { 'HTTP-Referer': 'https://octipus.cc', 'X-Title': 'Octipus' },
          }),
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
