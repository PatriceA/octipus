import type { CliPlanUsage } from '@/shared/cli-capabilities';

const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
const numeric = (raw: unknown): number | undefined => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
function reset(raw: unknown): string | undefined {
  const date = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function parseCliPlanUsage(provider: 'zai' | 'moonshot', raw: unknown): CliPlanUsage['windows'] {
  const body = record(raw);
  if (body.success === false || body.error) throw new Error('Provider refused quota request');
  if (provider === 'zai') {
    const limits = record(body.data).limits;
    if (!Array.isArray(limits)) throw new Error('Missing quota limits');
    const windows = limits.map(record).filter(v => numeric(v.percentage) !== undefined)
      .map(v => ({ label: v.type === 'TOKENS_LIMIT' ? 'Token allowance' : v.type === 'TIME_LIMIT' ? 'MCP allowance' : String(v.type ?? 'Plan allowance'),
        usedPercent: numeric(v.percentage)!, resetsAt: reset(v.nextResetTime) }));
    if (!windows.length) throw new Error('No reported quota windows');
    return windows;
  }
  const usages = record(body.usages);
  const labels: Record<string, string> = { limit_5h: '5 hours', limit_7d: '7 days', limit_month_total: 'Monthly total', limit_month_code: 'Monthly code' };
  const windows = Object.entries(labels).flatMap(([key, label]) => {
    const v = record(usages[key]); const ratio = numeric(v.used_ratio);
    return ratio !== undefined
      ? [{ label, usedPercent: ratio * 100, resetsAt: reset(v.reset_time) }] : [];
  });
  if (!windows.length) throw new Error('No reported quota windows');
  return windows;
}

/** Read-only endpoints used by the vendors' own usage clients, on the configured account host. */
export function cliPlanUsageUrl(provider: 'zai' | 'moonshot', base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Unsupported quota endpoint');
  if (provider === 'zai' && ['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'].includes(url.hostname)) url.pathname = '/api/monitor/usage/quota/limit';
  else if (provider === 'moonshot' && ['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) && /^\/coding(?:\/v1)?\/?$/.test(url.pathname)) url.pathname = '/coding/v1/usages';
  else throw new Error('No coding-plan quota endpoint for this service');
  return url.href;
}

export function makeCliPlanUsage(provider: 'zai' | 'moonshot', credentialEnv: () => Promise<Record<string, string>>): () => Promise<CliPlanUsage> {
  let cached: { until: number; value: CliPlanUsage } | undefined;
  let pending: Promise<CliPlanUsage> | undefined;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const checkedAt = new Date().toISOString();
      try {
        const env = await credentialEnv();
        const token = env.ANTHROPIC_AUTH_TOKEN;
        if (!token) throw new Error('Missing credential');
        const res = await fetch(cliPlanUsageUrl(provider, env.ANTHROPIC_BASE_URL), {
          headers: { Authorization: provider === 'zai' ? token : `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error('Quota request failed');
        const value = { checkedAt, windows: parseCliPlanUsage(provider, await res.json()) };
        cached = { until: Date.now() + 60_000, value }; return value;
      } catch {
        const value = { checkedAt, windows: [], error: 'Plan usage unavailable. Check this CLI’s coding-plan key and endpoint; no remaining allowance was inferred.' };
        cached = { until: Date.now() + 30_000, value }; return value;
      }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
