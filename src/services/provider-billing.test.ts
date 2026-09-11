import { afterEach, expect, test, vi } from 'vitest';
vi.mock('@/security/vault', () => ({ getVault: () => ({ getByName: async () => 'test-admin-key' }) }));
import { getProviderBillingReport, providerBillingErrorStatus } from './provider-billing';
afterEach(() => vi.unstubAllGlobals());
test('rejects invalid windows before making any request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const error = await getProviderBillingReport('openai', 'invalid', '2026-09-01').catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('interval');
  expect(providerBillingErrorStatus(error)).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
test('follows pagination and preserves Anthropic decimal cents without currency guessing', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ results: [{ amount: '12.345' }] }], has_more: true, next_page: 'two' }))
    .mockResolvedValueOnce(Response.json({ data: [], has_more: false }));
  vi.stubGlobal('fetch', fetcher);
  const report = await getProviderBillingReport('anthropic', '2026-09-01', '2026-09-02');
  expect(report.scope).toBe('organization');
  expect(report.amountUnit).toContain('cents');
  expect(report.buckets).toEqual([{ results: [{ amount: '12.345' }] }]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('rejects repeating cursors instead of presenting a partial bill', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [], has_more: true, next_page: 'same' })));
  await expect(getProviderBillingReport('openai', '2026-09-01', '2026-09-02')).rejects.toThrow('pagination');
});

test('classifies provider rejection as a bad gateway', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));
  const error = await getProviderBillingReport('openai', '2026-09-01', '2026-09-02').catch((reason: unknown) => reason);
  expect(providerBillingErrorStatus(error)).toBe(502);
});

test('classifies provider timeouts as gateway timeouts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
  const error = await getProviderBillingReport('anthropic', '2026-09-01', '2026-09-02').catch((reason: unknown) => reason);
  expect(providerBillingErrorStatus(error)).toBe(504);
});
