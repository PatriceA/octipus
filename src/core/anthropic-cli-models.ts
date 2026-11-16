import type { CliModelOption } from '@/shared/cli-capabilities';

/** Catalog discovery must use the same vendor endpoint and credentials as the CLI. */
export function anthropicCliModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid vendor endpoint');
  }
  // Moonshot's Anthropic bridge does not expose a model endpoint; its catalog
  // is the same account's OpenAI-compatible endpoint on the same official host.
  if (['api.moonshot.ai', 'api.moonshot.cn'].includes(url.hostname) && url.pathname.replace(/\/$/, '') === '/anthropic') {
    url.pathname = '/v1/models';
  } else {
    url.pathname = url.pathname.replace(/\/$/, '') + (url.pathname.replace(/\/$/, '').endsWith('/v1') ? '/models' : '/v1/models');
  }
  return url.href;
}

export function parseAnthropicCliModels(raw: unknown): CliModelOption[] {
  const data = raw && typeof raw === 'object' && 'data' in raw ? raw.data : undefined;
  if (!Array.isArray(data) || !data.length) throw new Error('Vendor returned an empty or invalid model catalog');
  const models = data.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error('Vendor returned an invalid model catalog');
    }
    return { id: item.id, label: 'display_name' in item && typeof item.display_name === 'string' ? item.display_name : item.id };
  });
  return models.filter((m, i) => models.findIndex(candidate => candidate.id === m.id) === i);
}

/** One cached catalog per installed CLI adapter; no paid inference is performed. */
export function makeAnthropicCliModelCatalog(name: string, buildEnv: () => Promise<Record<string, string>>): () => Promise<CliModelOption[]> {
  let cached: { until: number; models?: CliModelOption[]; error?: Error } | undefined;
  let pending: Promise<CliModelOption[]> | undefined;
  return async () => {
    if (cached && Date.now() < cached.until) {
      if (cached.error) throw cached.error;
      return cached.models ?? [];
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        const env = await buildEnv();
        const token = env.ANTHROPIC_AUTH_TOKEN;
        if (!token) throw new Error('Missing CLI credential');
        const res = await fetch(anthropicCliModelsUrl(env.ANTHROPIC_BASE_URL), {
          headers: { Authorization: `Bearer ${token}`, 'x-api-key': token, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
        if (!res.ok) throw new Error('Vendor model request failed');
        const models = parseAnthropicCliModels(await res.json());
        cached = { until: Date.now() + 300_000, models };
        return models;
      } catch {
        const error = new Error(`${name} model catalog unavailable. Check this CLI's vendor API key and Anthropic endpoint; coding-plan and pay-as-you-go credentials may differ. Retry after 30 seconds.`);
        cached = { until: Date.now() + 30_000, error };
        throw error;
      }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
