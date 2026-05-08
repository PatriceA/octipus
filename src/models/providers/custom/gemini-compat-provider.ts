import { classifyError } from '@/core/errors/classification';
import type { ToolCall } from '@/core/types';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from '../interface';
import { BaseCustomProvider, type ResolvedCustomConfig } from './base-custom-provider';
import {
  buildBlocksConfigEnvelope,
  buildStandardEnvelope,
  type GenericGeminiRequest,
} from './gemini-envelope';

/**
 * Custom Gemini-compatible provider.
 *
 * Speaks native Google Gemini wire format (`candidates[].content.parts[]`) on
 * the response side. Request side supports two envelopes via metadata.customProvider.requestEnvelope:
 *
 *   - 'standard' (default): native Gemini API. Path defaults to
 *     /v1beta/models/{model}:generateContent (or :streamGenerateContent for SSE).
 *
 *   - 'gemini-blocks-config': bespoke envelope with Anthropic-style content
 *     blocks + camelCase config:{} wrapper. Single path, defaults to '/generate'.
 */
export class CustomGeminiCompatProvider extends BaseCustomProvider implements ModelProvider {
  readonly name = 'custom-gemini';
  readonly type = 'direct' as const;
  protected readonly providerName = 'custom-gemini';

  supportsModel(_modelName: string): boolean {
    return false; // routed by DB provider column, not name heuristic
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const startTime = Date.now();

    const { url, body, headers } = this.buildRequest(cfg, options, false);

    modelLogger.debug(
      { model: (cfg.model?.modelId || options.model), url, envelope: cfg.custom.requestEnvelope || 'standard', provider: this.name },
      'Sending completion request to custom-gemini',
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw classifyError(err, this.name);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw classifyError(
        { status: res.status, message: extractErrorMessage(errText) || `HTTP ${res.status}` },
        this.name,
      );
    }

    const data = (await res.json()) as GeminiResponse;
    const latencyMs = Date.now() - startTime;
    return this.parseResponse(data, (cfg.model?.modelId || options.model), latencyMs);
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const cfg = await this.resolveModelConfig(options.model, options);
    const { url, body, headers } = this.buildRequest(cfg, options, true);

    modelLogger.debug(
      { model: (cfg.model?.modelId || options.model), url, provider: this.name },
      'Starting streaming completion via custom-gemini',
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      throw classifyError(err, this.name);
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw classifyError(
        { status: res.status, message: extractErrorMessage(errText) || `HTTP ${res.status}` },
        this.name,
      );
    }

    yield* parseGeminiSseStream(res.body);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return { healthy: true };
  }

  // ── Private ──

  private buildRequest(
    cfg: ResolvedCustomConfig,
    options: CompletionOptions,
    streaming: boolean,
  ): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
    const envelope = cfg.custom.requestEnvelope || 'standard';
    const generic: GenericGeminiRequest = {
      model: (cfg.model?.modelId || options.model),
      messages: options.messages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      stopSequences: options.stopSequences,
      tools: options.tools,
      stream: streaming,
      responseMimeType: (options.extraBody?.responseMimeType as string | undefined)
        || (options.extraBody?.response_mime_type as string | undefined),
      responseSchema: (options.extraBody?.responseSchema as Record<string, unknown> | undefined)
        || (options.extraBody?.response_schema as Record<string, unknown> | undefined),
    };

    const body = envelope === 'gemini-blocks-config'
      ? buildBlocksConfigEnvelope(generic)
      : buildStandardEnvelope(generic);

    if (options.extraBody && envelope === 'standard') {
      // Allow callers to inject native Gemini fields (safetySettings, etc.)
      const { responseSchema, response_schema, responseMimeType, response_mime_type, ...rest } = options.extraBody;
      Object.assign(body, rest);
    }

    const path = cfg.custom.pathOverride || this.defaultPath(envelope, (cfg.model?.modelId || options.model), streaming);
    const { headers, queryParams } = this.buildHeaders(cfg.custom, cfg.apiKey);
    const url = this.appendQuery(`${cfg.baseUrl}${path}`, queryParams);

    return { url, body, headers };
  }

  private defaultPath(envelope: string, modelId: string, streaming: boolean): string {
    if (envelope === 'gemini-blocks-config') return '/generate';
    const action = streaming ? 'streamGenerateContent' : 'generateContent';
    return `/v1beta/models/${encodeURIComponent(modelId)}:${action}`;
  }

  private parseResponse(data: GeminiResponse, modelId: string, latencyMs: number): CompletionResult {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw classifyError(new Error('custom-gemini returned no candidates'), this.name);
    }

    const parts = candidate.content?.parts || [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let toolCallIdx = 0;

    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        textParts.push(part.text);
      }
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id || `call_${toolCallIdx++}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        });
      }
    }

    const result: CompletionResult = {
      content: textParts.join(''),
      finishReason: mapFinishReason(candidate.finishReason),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: data.usageMetadata?.totalTokenCount || 0,
      },
      model: data.modelVersion || modelId,
      latencyMs,
    };

    if (toolCalls.length) result.toolCalls = toolCalls;
    return result;
  }
}

// ── Wire types ──

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
}

interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
  index?: number;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

function mapFinishReason(reason: string | undefined): string {
  if (!reason) return 'stop';
  const r = reason.toUpperCase();
  if (r === 'STOP') return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION') return 'content_filter';
  return reason.toLowerCase();
}

function extractErrorMessage(errText: string): string {
  try {
    const parsed = JSON.parse(errText);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    return obj?.error?.message || obj?.message || errText.slice(0, 300);
  } catch {
    return errText.slice(0, 300);
  }
}

/** Parse a Gemini SSE stream (`data: {...}\n\n` events with full chunk shape) */
async function* parseGeminiSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallBuffers = new Map<string, ToolCall>();
  let finishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (SSE event boundary)
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let data: GeminiResponse;
          try { data = JSON.parse(payload) as GeminiResponse; }
          catch { continue; }

          const candidate = data.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          let toolIdx = toolCallBuffers.size;

          for (const part of parts) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              yield { content: part.text };
            }
            if (part.functionCall) {
              const id = part.functionCall.id || `call_${toolIdx++}`;
              if (!toolCallBuffers.has(id)) {
                toolCallBuffers.set(id, {
                  id,
                  name: part.functionCall.name,
                  arguments: part.functionCall.args || {},
                });
                yield {
                  toolCallDelta: {
                    id,
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  },
                };
              }
            }
          }

          if (candidate?.finishReason) {
            finishReason = mapFinishReason(candidate.finishReason);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finishReason) yield { finishReason };
}
