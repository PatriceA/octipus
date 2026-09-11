/** Optional organization billing export. Never substitutes organization spend
 * for an Octipus session's cost or mutates the local usage ledger. */
export class ProviderBillingError extends Error {
  constructor(message: string, readonly status: 400 | 502 | 504) {
    super(message);
    this.name = 'ProviderBillingError';
  }
}

export function providerBillingErrorStatus(error: unknown): 400 | 502 | 504 {
  return error instanceof ProviderBillingError ? error.status : 502;
}

export async function getProviderBillingReport(provider: 'openai' | 'anthropic', start: string, end: string) {
  const from = new Date(start); const to = new Date(end);
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from || +to - +from > 31 * 86400000) {
    throw new ProviderBillingError('Choose a valid billing interval of at most 31 days.', 400);
  }
  const env = provider === 'openai' ? 'OPENAI_ADMIN_KEY' : 'ANTHROPIC_ADMIN_KEY';
  const { getVault } = await import('@/security/vault');
  const key = process.env[env] || await getVault().getByName('system', env.toLowerCase());
  if (!key) throw new ProviderBillingError(`Configure ${env} or the ${env.toLowerCase()} system vault entry to read organization billing.`, 400);
  const url = new URL(provider === 'openai' ? 'https://api.openai.com/v1/organization/costs' : 'https://api.anthropic.com/v1/organizations/cost_report');
  if (provider === 'openai') {
    url.searchParams.set('start_time', String(Math.floor(+from / 1000)));
    url.searchParams.set('end_time', String(Math.floor(+to / 1000)));
    url.searchParams.set('bucket_width', '1d');
  } else {
    url.searchParams.set('starting_at', from.toISOString());
    url.searchParams.set('ending_at', to.toISOString());
  }
  const headers: Record<string, string> = provider === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const buckets: unknown[] = [];
  const pages = new Set<string>();
  for (let i = 0; i < 50; i++) {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch (error) {
      const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderBillingError('Provider billing API request timed out.', 504);
      }
      throw new ProviderBillingError('Provider billing API request failed.', 502);
    }
    if (!response.ok) {
      throw new ProviderBillingError(
        `Provider billing API returned HTTP ${response.status}`,
        response.status === 504 ? 504 : 502,
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new ProviderBillingError('Provider billing API returned invalid JSON.', 502);
    }
    if (!Array.isArray(data.data)) throw new ProviderBillingError('Unexpected provider billing response.', 502);
    buckets.push(...data.data);
    if (!data.has_more) return {
      provider, start: from.toISOString(), end: to.toISOString(), scope: 'organization',
      amountUnit: provider === 'anthropic' ? 'USD cents (decimal strings)' : 'amount.value in amount.currency',
      note: 'Organization billing may include other applications and may be delayed. Compare matching scopes; do not assign this total to a session. Anthropic Priority Tier costs are excluded by its cost API.',
      buckets,
    };
    if (typeof data.next_page !== 'string' || pages.has(data.next_page)) throw new ProviderBillingError('Invalid billing pagination; no partial report returned.', 502);
    pages.add(data.next_page); url.searchParams.set('page', data.next_page);
  }
  throw new ProviderBillingError('Billing report exceeded the page limit; narrow the interval.', 502);
}
