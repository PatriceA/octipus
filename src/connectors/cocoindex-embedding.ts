import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getConfig } from '@/config';
import { getModelRegistry } from '@/models/model-registry';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getMcpTokenPath } from '@/security/mcp-token-bootstrap';

async function boundModel() {
  const model = await getModelRegistry().getModelForTopic('embedding');
  if (!model) throw new Error('Assign an embedding model on Topics before configuring CocoIndex.');
  const identity = createHash('sha256').update(JSON.stringify([
    model.name, model.provider, model.modelId, model.endpoint, model.metadata?.embedPrefixes,
  ])).digest('hex').slice(0, 24);
  return { model, identity: `octipus-${identity}` };
}

export async function cocoIndexEmbeddingSettings() {
  const { model, identity } = await boundModel();
  const token = (await readFile(getMcpTokenPath(), 'utf8')).trim();
  if (!token) throw new Error('Octipus API token unavailable. Restart Octipus before setting up CocoIndex.');
  const base = `http://127.0.0.1:${getConfig().api.port}/api/connectors/cocoindex`;
  return {
    model: identity,
    label: model.name,
    settings: {
      embedding: { provider: 'litellm', model: `openai/${identity}`, min_interval_ms: 500,
        indexing_params: { api_base: `${base}/document` }, query_params: { api_base: `${base}/query` } },
      envs: { OPENAI_API_BASE: `${base}/document`, OPENAI_API_KEY: token },
      daemon: { idle_timeout_minutes: 10, keep_alive_with_mcp: false },
    },
  };
}

let active = false;
/** Bounded batches and a single admitted request keep local providers from
 * loading parallel embedding jobs. Return 429 instead of an unbounded queue. */
export async function embedCocoIndex(input: string[], identity: string, side: 'document' | 'query', userId: string) {
  const { model, identity: current } = await boundModel();
  if (identity !== current) throw new Error('Embedding configuration changed. Apply CocoIndex settings again to rebuild its index.');
  if (active) return null;
  active = true;
  try {
    const prefix = model.metadata?.embedPrefixes?.[side] ?? '';
    const vectors: number[][] = [];
    for (let i = 0; i < input.length; i += 8) {
      const batch = input.slice(i, i + 8).map(text => prefix + text);
      const result = await getLiteLLMClient().embed(batch, model.modelId, {
        userId, modelConfigName: model.name,
      });
      if (result.length !== batch.length) throw new Error('Embedding provider returned an incomplete batch');
      const dimensions = vectors[0]?.length ?? result[0]?.length;
      if (!dimensions || result.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)))) {
        throw new Error('Embedding provider returned invalid vectors');
      }
      vectors.push(...result);
    }
    return { object: 'list', model: identity, data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })) };
  } finally { active = false; }
}
