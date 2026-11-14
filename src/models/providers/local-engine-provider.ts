import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import { recordProviderUsage } from './instrumented';

/**
 * The optional local embedding engine (llama-server, src/capabilities/
 * local-engine) as a provider. It has no stored endpoint: the supervisor
 * starts the engine on the first embedding, on a free port with a fresh key,
 * and hands both to this call. Local for protection levels: content at levels
 * 3–4 may be embedded here.
 */
export class LocalEngineProvider implements ModelProvider {
  readonly name = 'local-engine';
  readonly type = 'direct' as const;

  /** Routed by the row's `provider` column; never claimed by name. */
  supportsModel(_modelName: string): boolean {
    return false;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    throw new Error(`${options.model} is a local embedding model, not a chat model. Bind it to the embedding lane.`);
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    throw new Error(`${options.model} is a local embedding model, not a chat model.`);
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const { useLocalEngine } = await import('@/capabilities/local-engine/engine-process');
    const json = await useLocalEngine(model, async ({ port, apiKey }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`The local embedding engine answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as { data?: Array<{ index?: number; embedding: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } };
    });
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length) throw new Error(`The local embedding engine returned ${data.length} vectors for ${texts.length} texts.`);
    const tokens = json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0;
    await recordProviderUsage({ model, messages: [], requestType: 'embedding' }, this.name, {
      model, usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens, available: tokens > 0, reportedCost: 0 },
    }).catch(() => {});
    return data.map((d) => d.embedding);
  }

  /** Installed and probed; whether it is running is the supervisor's business (it starts on demand). */
  async checkHealth(): Promise<ProviderHealthStatus> {
    const { engineBinaryPath } = await import('@/capabilities/local-engine/engine-process');
    const { existsSync } = await import('node:fs');
    const bin = engineBinaryPath();
    return bin && existsSync(bin) ? { healthy: true } : { healthy: false, error: 'The local embedding engine is not installed.' };
  }
}
