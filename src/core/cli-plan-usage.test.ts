import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliPlanUsageUrl, makeCliPlanUsage, parseCliPlanUsage } from './cli-plan-usage';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const zai = { success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 25, nextResetTime: 1893456000000 }, { type: 'TIME_LIMIT', percentage: 100 }] } };
const kimi = { usages: { limit_5h: { used_ratio: 0.25, reset_time: '2030-01-01T00:00:00Z' }, limit_7d: { used_ratio: 1 } } };
describe('coding-plan allowance', () => {
  it('parses z.ai percentages and Kimi ratios without inventing missing windows', () => {
    expect(parseCliPlanUsage('zai', zai)).toEqual([
      { label: 'Token allowance', usedPercent: 25, resetsAt: '2030-01-01T00:00:00.000Z' },
      { label: 'MCP allowance', usedPercent: 100, resetsAt: undefined },
    ]);
    expect(parseCliPlanUsage('moonshot', kimi)).toEqual([
      { label: '5 hours', usedPercent: 25, resetsAt: '2030-01-01T00:00:00.000Z' },
      { label: '7 days', usedPercent: 100, resetsAt: undefined },
    ]);
    expect(() => parseCliPlanUsage('zai', { success: false, data: zai.data })).toThrow();
    expect(() => parseCliPlanUsage('moonshot', { usages: {} })).toThrow();
    expect(parseCliPlanUsage('moonshot', { usages: { limit_5h: { used_ratio: '0.25' }, limit_7d: { used_ratio: 1.2 } } }).map(w => w.usedPercent)).toEqual([25, 120]);
    expect(() => parseCliPlanUsage('moonshot', { usages: { limit_5h: { used_ratio: '' } } })).toThrow();
  });
  it('keeps credentials on the configured official coding host', () => {
    expect(cliPlanUsageUrl('zai', 'https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(cliPlanUsageUrl('moonshot', 'https://api.kimi.ai/coding')).toBe('https://api.kimi.ai/coding/v1/usages');
    for (const url of ['https://api.moonshot.ai/anthropic', 'https://api.kimi.ai.evil.example/coding', 'http://api.kimi.ai/coding']) {
      expect(() => cliPlanUsageUrl('moonshot', url)).toThrow();
    }
  });
  it.each(['zai', 'moonshot'] as const)('queries the same CLI key, coalesces/cache requests and reports unknown honestly: %s', async provider => {
    const response = provider === 'zai' ? zai : kimi;
    const request = vi.fn(async () => Response.json(response));
    vi.stubGlobal('fetch', request);
    const env = async () => ({ ANTHROPIC_AUTH_TOKEN: 'coding-key-fixture', ANTHROPIC_BASE_URL: provider === 'zai' ? 'https://api.z.ai/api/anthropic' : 'https://api.kimi.ai/coding' });
    const usage = makeCliPlanUsage(provider, env);
    const [a, b] = await Promise.all([usage(), usage()]);
    expect(a).toEqual(b); expect(a.windows).toHaveLength(2); expect(a.error).toBeUndefined();
    await usage(); expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error', headers: {
      Authorization: provider === 'zai' ? 'coding-key-fixture' : 'Bearer coding-key-fixture', Accept: 'application/json',
    } }));
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    request.mockImplementation(async () => new Response('private failure', { status: 403 }));
    const unknown = await usage(); expect(unknown.windows).toEqual([]); expect(unknown.error).toContain('unavailable');
    expect(unknown.error).not.toContain('private failure'); await usage(); expect(request).toHaveBeenCalledTimes(2);
  });
});
