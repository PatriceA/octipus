/**
 * Custom-endpoint model discovery: the auth headers actually sent.
 *
 * A correct Anthropic key was reported as "Endpoint returned 401: Invalid API
 * key" by the Fetch Models button while the same key worked elsewhere —
 * discovery sent only `Authorization: Bearer`, which an Anthropic-compatible
 * gateway rejects.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchGuarded = vi.fn();
vi.mock('@/utils/sanitize', () => ({ fetchGuarded: (...a: unknown[]) => fetchGuarded(...a) }));
vi.mock('@/security/vault', () => ({
  getVault: () => ({ getByName: async () => 'secret-key' }),
}));

const { discoverCustomModels } = await import('./provider-service');

function okModels() {
  return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-4' }] }) };
}

function headersOf(): Record<string, string> {
  return fetchGuarded.mock.calls[0]?.[1]?.headers as Record<string, string>;
}

beforeEach(() => {
  fetchGuarded.mockReset();
  fetchGuarded.mockResolvedValue(okModels());
});

describe('custom-anthropic discovery', () => {
  test('sends x-api-key and the API version alongside the bearer token', async () => {
    const r = await discoverCustomModels({
      provider: 'custom-anthropic',
      endpoint: 'https://gateway.example',
      apiKeyRef: 'my_key',
      userId: 'u1',
    });
    expect(r.models).toEqual([{ id: 'claude-sonnet-4', label: 'claude-sonnet-4', ownedBy: undefined }]);

    const h = headersOf();
    expect(h['x-api-key']).toBe('secret-key');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h.Authorization).toBe('Bearer secret-key');
  });

  test('an explicit x-api-key auth header is not overwritten', async () => {
    await discoverCustomModels({
      provider: 'custom-anthropic',
      endpoint: 'https://gateway.example',
      apiKeyRef: 'my_key',
      authType: 'header',
      headerName: 'x-api-key',
      userId: 'u1',
    });
    const h = headersOf();
    expect(h['x-api-key']).toBe('secret-key');
    expect(h.Authorization).toBeUndefined();
  });

  test('other flavors are untouched', async () => {
    await discoverCustomModels({
      provider: 'custom-openai',
      endpoint: 'https://gateway.example',
      apiKeyRef: 'my_key',
      userId: 'u1',
    });
    const h = headersOf();
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-version']).toBeUndefined();
    expect(h.Authorization).toBe('Bearer secret-key');
  });
});
