import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicCliModelsUrl, makeAnthropicCliModelCatalog, parseAnthropicCliModels } from './anthropic-cli-models';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Claude-compatible vendor CLI catalogs', () => {
  it.each([
    ['https://api.z.ai/api/anthropic', 'https://api.z.ai/api/anthropic/v1/models'],
    ['https://api.moonshot.ai/anthropic', 'https://api.moonshot.ai/v1/models'],
    ['https://api.moonshot.cn/anthropic/', 'https://api.moonshot.cn/v1/models'],
    ['https://api.kimi.ai/coding/', 'https://api.kimi.ai/coding/v1/models'],
    ['https://proxy.example/custom/v1', 'https://proxy.example/custom/v1/models'],
  ])('keeps the configured vendor/account service: %s', (base, expected) => {
    expect(anthropicCliModelsUrl(base)).toBe(expected);
  });
  it.each(['file:///private', 'https://user:secret@api.example', 'https://api.example?token=private', 'https://api.example/#fragment'])('rejects unsafe endpoint forms: %s', endpoint => {
    expect(() => anthropicCliModelsUrl(endpoint)).toThrow();
  });
  it('accepts both Anthropic and OpenAI catalog labels and rejects errors or empty catalogs', () => {
    expect(parseAnthropicCliModels({ data: [{ id: 'account-model', display_name: 'Account model' }, { id: 'other' }] }))
      .toEqual([{ id: 'account-model', label: 'Account model' }, { id: 'other', label: 'other' }]);
    for (const bad of [{ success: false, code: 401 }, { data: [] }, { data: [{ name: 'missing-id' }] }]) expect(() => parseAnthropicCliModels(bad)).toThrow();
  });
  it.each([false, true])('uses CLI credentials, coalesces lookups, and caches success/failure (failure=%s)', async failure => {
    const env = vi.fn(async () => ({ ANTHROPIC_BASE_URL: 'https://vendor.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'cli-only-fixture' }));
    const request = vi.fn(async () => failure ? new Response('private diagnostic', { status: 403 }) : Response.json({ data: [{ id: 'account-model' }] }));
    vi.stubGlobal('fetch', request);
    const catalog = makeAnthropicCliModelCatalog('Vendor CLI', env);
    const results = await Promise.allSettled([catalog(), catalog()]);
    expect(results.every(r => r.status === (failure ? 'rejected' : 'fulfilled'))).toBe(true);
    if (failure) await expect(catalog()).rejects.toThrow('Vendor CLI model catalog unavailable');
    else await expect(catalog()).resolves.toEqual([{ id: 'account-model', label: 'account-model' }]);
    expect(request).toHaveBeenCalledTimes(1); expect(env).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('https://vendor.example/anthropic/v1/models', expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer cli-only-fixture', 'x-api-key': 'cli-only-fixture' }),
    }));
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + (failure ? 31_000 : 301_000));
    if (failure) await expect(catalog()).rejects.toThrow('catalog unavailable'); else await catalog();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
