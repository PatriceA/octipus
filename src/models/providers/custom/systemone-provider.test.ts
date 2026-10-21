import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';
import { CustomOpenAICompatProvider } from './openai-compat-provider';

const mocks = vi.hoisted(() => ({ getModel: vi.fn(), getModelByModelId: vi.fn(), getByName: vi.fn(), fetch: vi.fn() }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => mocks }));
vi.mock('@/security/vault', () => ({ getVault: () => mocks }));
vi.mock('../instrumented', () => ({ providerUsageUserId: () => undefined, recordProviderUsage: vi.fn() }));
let row: ModelConfigEntry;
beforeEach(() => {
  vi.clearAllMocks();
  row = { name: 'tower-decision', modelId: 'same-model-on-two-hosts', provider: 'custom-openai', endpoint: 'http://192.168.1.156:8080/v1', apiKeyRef: 'LLAMA_API_KEY', ownerUserId: null,
    metadata: { decisionProtocol: 'systemone', dataPolicy: { hosting: 'local', retention: 'none', trainsOnInput: false }, customProvider: { auth: { type: 'bearer' } } },
  } as ModelConfigEntry;
  mocks.getModel.mockImplementation(async () => row);
  mocks.getByName.mockResolvedValue('test-vault-key');
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ answers: { outage: 0.95 } })));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
const req = { model: 'same-model-on-two-hosts', modelConfigName: 'tower-decision', endpoint: 'http://192.168.1.156:8080/v1', zeroDataRetention: false, state: 'Checkout is down.', questions: { outage: { type: 'noul' as const, instructions: 'Is a service down?' } } };

describe('custom provider native decisions', () => {
  it('resolves the exact bound row and its vault reference without a duplicate /v1', async () => {
    expect(await new CustomOpenAICompatProvider().decide(req)).toEqual({ outage: { type: 'noul', p: 0.95, confidence: 0.95 } });
    expect(mocks.getModel).toHaveBeenCalledWith('tower-decision');
    expect(mocks.getModelByModelId).not.toHaveBeenCalled();
    expect(mocks.getByName).toHaveBeenCalledWith('system', 'LLAMA_API_KEY');
    expect(mocks.fetch).toHaveBeenCalledWith('http://192.168.1.156:8080/v1/systemone', expect.objectContaining({ headers: { Authorization: 'Bearer test-vault-key', 'Content-Type': 'application/json' }, redirect: 'error' }));
  });
  it('refuses unconfigured, remote, mismatched and retaining endpoints before inference', async () => {
    const provider = new CustomOpenAICompatProvider();
    await expect(provider.decide({ ...req, endpoint: 'http://other/v1' })).rejects.toThrow('does not match');
    row.endpoint = 'https://remote.example/v1';
    await expect(provider.decide(req)).rejects.toThrow('private endpoint');
    row.endpoint = req.endpoint;
    row.metadata!.dataPolicy!.retention = 'provider';
    await expect(provider.decide(req)).rejects.toThrow('no-retention');
    delete row.metadata!.decisionProtocol;
    await expect(provider.decide(req)).rejects.toThrow('decisionProtocol');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
