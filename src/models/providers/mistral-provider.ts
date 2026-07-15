import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { classifyError } from '@/core/errors/classification';
import { transformMessagesForProvider } from '@/models/message-transform';
import { parseToolCallArguments } from '@/models/tool-call-args';
import type { AgentMessage } from '@/core/types';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, OcrDocument, OcrResult, ProviderHealthStatus } from './interface';
import { cacheAffinityKey, extractCachedTokens } from './usage';

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

// Magistral (Mistral's reasoning family) can think for a while. Mirror the
// DeepSeek/Grok pattern: long timeout for reasoning, shorter for chat.
const REASONING_TIMEOUT_MS = 1_800_000; // 30 min
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Model names / prefixes served by the Mistral API. `mistral-embed` is matched
 * by the `mistral-` prefix; the embedding topic routes to embed() below.
 */
const SUPPORTED_PREFIXES = [
  'mistral-',
  'magistral-',
  'codestral-',
  'ministral-',
  'devstral-',
  'pixtral-',
  'voxtral-',
  'open-mistral-',
  'open-mixtral-',
];

/**
 * Resolve the Mistral API key: environment first, then the vault. Exported so
 * the OCR / STT / TTS paths share one resolution rule with the chat provider.
 */
export async function getMistralApiKey(): Promise<string | null> {
  if (process.env.MISTRAL_API_KEY) {
    return process.env.MISTRAL_API_KEY;
  }

  // Fall back to vault — recoverable: null return triggers a classified AUTH_FAILED on createClient()
  try {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const value = await vault.getByName('system', 'mistral_api_key');
    return value || null;
  } catch (err) {
    modelLogger.warn({ err: (err as Error).message, provider: 'mistral' }, 'Mistral vault lookup failed; falling back to env var');
    return null;
  }
}

/** Detect Mistral reasoning variants (Magistral) by id. */
function isMistralReasoningModel(modelName: string): boolean {
  const lower = (modelName || '').toLowerCase();
  return /magistral|reasoning/.test(lower);
}

/** Mistral tool-call ids must be exactly 9 alphanumeric chars. Deterministic. */
function toMistralToolId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  return createHash('sha256').update(id).digest('hex').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9).padEnd(9, '0');
}

/**
 * Mistral direct provider — calls the Mistral API (OpenAI-compatible
 * `/v1/chat/completions`) without going through the LiteLLM proxy. API key is
 * resolved from the environment or the vault at runtime.
 */
export class MistralProvider implements ModelProvider {
  readonly name = 'mistral';
  readonly type = 'direct' as const;

  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || MISTRAL_BASE_URL;
  }

  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return SUPPORTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient(options.model);
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages, isMistralReasoningModel(options.model)),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      response_format: options.responseFormat,
      stream: false,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    // Merge extra body parameters
    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    // Mistral prompt caching is explicit opt-in: a stable per-session key lets
    // requests sharing the cached static prefix hit it (Phase 2c).
    const cacheKey = cacheAffinityKey(options.sessionId);
    if (cacheKey) (params as unknown as Record<string, unknown>).prompt_cache_key = cacheKey;

    modelLogger.debug(
      { model: params.model, messageCount: options.messages.length, provider: this.name },
      'Sending completion request to Mistral'
    );

    try {
      const response = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${params.model || options.model}`), 'mistral');
      }
      const choice = response.choices[0];

      // Magistral returns reasoning_content alongside content. Capture it so the
      // next turn can echo it back (parity with the DeepSeek reasoning path).
      const reasoningContent = (choice.message as { reasoning_content?: string }).reasoning_content;

      const result: CompletionResult = {
        content: choice.message.content || '',
        finishReason: choice.finish_reason || 'stop',
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
          ...extractCachedTokens(response.usage),
        },
        model: response.model,
        latencyMs,
        ...(reasoningContent ? { reasoningContent } : {}),
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          if (tc.type !== 'function') {
            throw new Error(`Unexpected tool call type from ${this.name}: ${tc.type}`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: parseToolCallArguments(tc.function.arguments, tc.function.name, this.name),
          };
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
        'Mistral completion successful'
      );

      return result;
    } catch (error) {
      modelLogger.error({ error, model: params.model, provider: this.name }, 'Mistral completion failed');
      throw classifyError(error, 'mistral');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient(options.model);

    const params: ChatCompletionCreateParams = {
      model: options.model,
      messages: this.formatMessages(options.messages, isMistralReasoningModel(options.model)),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    };

    if (options.tools?.length) {
      params.tools = options.tools;
      params.tool_choice = options.toolChoice ?? 'auto';
    }

    if (options.extraBody) {
      Object.assign(params, options.extraBody);
    }

    modelLogger.debug({ model: params.model, provider: this.name }, 'Starting streaming completion via Mistral');

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : undefined);
    } catch (err) {
      throw classifyError(err, 'mistral');
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

  /** Generate embeddings via `mistral-embed` (OpenAI-compatible embeddings API). */
  async embed(texts: string[], model: string): Promise<number[][]> {
    const client = await this.createClient();

    modelLogger.debug(
      { model, inputCount: texts.length, provider: this.name },
      'Generating embeddings via Mistral'
    );

    try {
      const response = await client.embeddings.create({
        model,
        input: texts,
        encoding_format: 'float',
      });
      return response.data.map((d) => d.embedding);
    } catch (error) {
      modelLogger.error({ error, model, provider: this.name }, 'Mistral embed failed');
      throw classifyError(error, 'mistral');
    }
  }

  /**
   * Native OCR via `POST /v1/ocr` (`mistral-ocr-latest`). Handles multi-page
   * PDFs in a single call — no rasterization, no per-page vision prompting.
   */
  async ocr(document: OcrDocument, model: string): Promise<OcrResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('Mistral API key not available. Set MISTRAL_API_KEY or store it in the vault.'), 'mistral');
    }

    // Mistral accepts a `data:` URI in the *_url fields, so local files never
    // need the Files API.
    const url = document.kind === 'url' ? document.url : `data:${document.mimeType};base64,${document.data}`;
    const isImage = document.kind === 'base64' && document.mimeType.startsWith('image/');
    const docChunk = isImage
      ? { type: 'image_url', image_url: url }
      : { type: 'document_url', document_url: url };

    modelLogger.debug({ model, kind: document.kind, provider: this.name }, 'Sending OCR request to Mistral');

    try {
      const response = await fetch(`${this.baseUrl}/ocr`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, document: docChunk, table_format: 'markdown' }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Mistral OCR failed (${response.status}): ${detail.slice(0, 500)}`);
      }

      const raw = (await response.json()) as {
        pages?: Array<{ index: number; markdown: string }>;
        model?: string;
      };

      const pages = (raw.pages || []).map((p) => ({ index: p.index, markdown: p.markdown || '' }));
      modelLogger.debug({ model, pageCount: pages.length, provider: this.name }, 'Mistral OCR successful');

      return { pages, model: raw.model || model };
    } catch (error) {
      modelLogger.error({ error, model, provider: this.name }, 'Mistral OCR failed');
      throw classifyError(error, 'mistral');
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const startTime = Date.now();

    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        return { healthy: false, error: 'Mistral API key not configured' };
      }

      const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
      await client.models.list();

      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  /**
   * Live-list models from the Mistral API. Throws if no API key is configured
   * or the upstream call fails — callers fall back to the static catalog.
   */
  async listModels(): Promise<string[]> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Mistral API key not configured');
    }
    const client = new OpenAI({ baseURL: this.baseUrl, apiKey });
    const res = await client.models.list();
    return res.data.map((m) => m.id);
  }

  // -- Private helpers --

  private async getApiKey(): Promise<string | null> {
    return getMistralApiKey();
  }

  private async createClient(modelName?: string): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw classifyError(new Error('Mistral API key not available. Set MISTRAL_API_KEY or store it in the vault.'), 'mistral');
    }

    const timeout = modelName && isMistralReasoningModel(modelName)
      ? REASONING_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS;

    return new OpenAI({
      baseURL: this.baseUrl,
      apiKey,
      timeout,
      maxRetries: 2,
    });
  }

  private formatMessages(messages: AgentMessage[], isReasoning: boolean): ChatCompletionMessageParam[] {
    const src = transformMessagesForProvider(messages, this.name);

    // Mistral rejects tool-call ids that aren't exactly 9 alphanumeric chars.
    // Remap deterministically, keeping assistant tool_calls and their tool
    // replies in sync via a shared old→new id map.
    const idMap = new Map<string, string>();
    for (const m of src) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) idMap.set(tc.id, toMistralToolId(tc.id));
      }
    }

    return src.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.toolCallId != null ? (idMap.get(msg.toolCallId) ?? toMistralToolId(msg.toolCallId)) : '',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const out: ChatCompletionMessageParam & { reasoning_content?: string } = {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: idMap.get(tc.id) ?? toMistralToolId(tc.id),
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
        if (isReasoning && msg.reasoningContent) out.reasoning_content = msg.reasoningContent;
        return out;
      }

      const base: ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
      if (isReasoning && msg.role === 'assistant' && msg.reasoningContent) {
        base.reasoning_content = msg.reasoningContent;
      }
      return base;
    });
  }
}
