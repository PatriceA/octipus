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
import { extractCachedTokens } from './usage';
import { parseServiceAccount, type ServiceAccount, VertexTokenManager } from './vertex-token';

const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Google Vertex AI provider via its OpenAI-compatible endpoint. Unlike the
 * API-key Gemini provider, this authenticates with a short-lived OAuth2 access
 * token minted from a service account (no static keys) — see `vertex-token.ts`.
 *
 * Selected by a `vertex/` (or `vertex_ai/`) model prefix, or by the DB provider
 * column 'vertex'. The bare model name after the prefix is sent to Vertex as
 * `google/<model>` (Vertex's openapi publisher path) unless it already carries
 * a publisher segment.
 */
export class VertexProvider implements ModelProvider {
  readonly name = 'vertex';
  readonly type = 'direct' as const;

  private tokenManager: VertexTokenManager | null = null;

  supportsModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return lower.startsWith('vertex/') || lower.startsWith('vertex_ai/');
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const client = await this.createClient();
    const model = this.resolveModelId(options.model);
    const startTime = Date.now();

    const params: ChatCompletionCreateParams = {
      model,
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
    if (options.extraBody) Object.assign(params, options.extraBody);

    const reqOpts = options.signal ? { signal: options.signal } : {};

    try {
      const response = await client.chat.completions.create(params, reqOpts);
      const latencyMs = Date.now() - startTime;
      if (!response.choices?.length) {
        throw classifyError(new Error(`Provider returned empty response (no choices) for model ${model}`), 'vertex');
      }
      const choice = response.choices[0];

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
      };

      if (choice.message.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((tc) => {
          if (tc.type !== 'function') {
            throw new Error(`Unexpected tool call type from ${this.name}: ${tc.type}`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
          };
        });
      }
      return result;
    } catch (error) {
      modelLogger.error({ error, model, provider: this.name }, 'Vertex completion failed');
      throw classifyError(error, 'vertex');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    const client = await this.createClient();
    const model = this.resolveModelId(options.model);

    const params: ChatCompletionCreateParams = {
      model,
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
    if (options.extraBody) Object.assign(params, options.extraBody);

    let stream;
    try {
      stream = await client.chat.completions.create(params, options.signal ? { signal: options.signal } : {});
    } catch (err) {
      throw classifyError(err, 'vertex');
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) yield { content: delta.content };
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallBuffers.has(tc.index)) {
            toolCallBuffers.set(tc.index, { id: tc.id || '', name: '', arguments: '' });
          }
          const buffer = toolCallBuffers.get(tc.index)!;
          if (tc.id) buffer.id = tc.id;
          if (tc.function?.name) buffer.name = tc.function.name;
          if (tc.function?.arguments) buffer.arguments += tc.function.arguments;
          yield { toolCallDelta: { id: buffer.id, name: tc.function?.name, arguments: tc.function?.arguments } };
        }
      }
      if (chunk.choices[0]?.finish_reason) yield { finishReason: chunk.choices[0].finish_reason };
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    const startTime = Date.now();
    try {
      const sa = await this.loadServiceAccount();
      if (!sa) return { healthy: false, error: 'Vertex service account not configured' };
      // Minting a token exercises the full credential path without a model call.
      await this.getTokenManager(sa).getAccessToken();
      return { healthy: true, latencyMs: Date.now() - startTime };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  // -- Private helpers --

  /** `vertex/gemini-2.0-flash` -> `google/gemini-2.0-flash`; keeps an explicit publisher path as-is. */
  private resolveModelId(model: string): string {
    const stripped = model.replace(/^vertex(_ai)?\//i, '');
    return stripped.includes('/') ? stripped : `google/${stripped}`;
  }

  private getLocation(): string {
    return process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || DEFAULT_LOCATION;
  }

  private async getProject(sa: ServiceAccount): Promise<string> {
    const project = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || sa.project_id;
    if (!project) throw new Error('Vertex project not set (VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT or SA project_id)');
    return project;
  }

  private getTokenManager(sa: ServiceAccount): VertexTokenManager {
    if (!this.tokenManager) this.tokenManager = new VertexTokenManager(sa);
    return this.tokenManager;
  }

  /** Service account from env (VERTEX_SERVICE_ACCOUNT_JSON) or the vault. */
  private async loadServiceAccount(): Promise<ServiceAccount | null> {
    if (process.env.VERTEX_SERVICE_ACCOUNT_JSON) {
      return parseServiceAccount(process.env.VERTEX_SERVICE_ACCOUNT_JSON);
    }
    try {
      const { getVault } = await import('@/security/vault');
      const raw = await getVault().getByName('system', 'vertex_service_account');
      return raw ? parseServiceAccount(raw) : null;
    } catch (err) {
      modelLogger.warn({ err: (err as Error).message, provider: this.name }, 'Vertex vault lookup failed');
      return null;
    }
  }

  private async createClient(): Promise<OpenAI> {
    const sa = await this.loadServiceAccount();
    if (!sa) {
      throw classifyError(
        new Error('Vertex service account not available. Set VERTEX_SERVICE_ACCOUNT_JSON or store it in the vault.'),
        'vertex',
      );
    }
    const project = await this.getProject(sa);
    const location = this.getLocation();
    const accessToken = await this.getTokenManager(sa).getAccessToken();
    const baseURL = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;

    return new OpenAI({ baseURL, apiKey: accessToken, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 2 });
  }

  private formatMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return { role: 'tool' as const, content: msg.content, tool_call_id: msg.toolCallId || '' };
      }
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      return { role: msg.role as 'system' | 'user' | 'assistant', content: msg.content };
    });
  }
}
