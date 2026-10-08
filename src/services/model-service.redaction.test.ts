import { beforeEach, describe, expect, test, vi } from 'vitest';

// GET /models and GET /models/:name for a non-admin: an install row comes back
// redacted (no endpoint, key reference, metadata, topics, priority or costs);
// the caller's own personal rows stay whole; an admin's view is unchanged.
const ADMIN = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';

const row = (over: Record<string, unknown>) => ({
  id: 'id-' + String(over.name),
  provider: 'openai',
  modelId: 'gpt-x',
  endpoint: 'https://internal.example/v1',
  apiKeyRef: 'vault:openai',
  maxTokens: 4096,
  defaultMaxTokens: 1024,
  contextWindow: 128000,
  supportsVision: true,
  supportsTools: true,
  supportsStreaming: true,
  topics: ['build'],
  topicRoles: { build: 'primary' },
  priority: 5,
  costPerInputToken: 1,
  costPerOutputToken: 2,
  isEnabled: true,
  isDefault: false,
  metadata: { secretish: 'x' },
  ownerUserId: null,
  orgId: null,
  ...over,
});
const install = row({ name: 'install-model', isDefault: true });
const mine = row({ name: 'my-model', ownerUserId: MEMBER, endpoint: 'https://mine.example' });

const registry = vi.hoisted(() => ({
  getAllModelsIncludeDisabled: vi.fn(),
  getPersonalModels: vi.fn(),
  getModelsForUser: vi.fn(),
  getModelAnyState: vi.fn(),
  getModelVisibleTo: vi.fn(),
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => registry }));
import { getModelByName, listModels } from './model-service';

const INSTALL_ONLY_FIELDS = ['endpoint', 'apiKeyRef', 'metadata', 'topics', 'priority', 'costPerInputToken', 'costPerOutputToken', 'maxTokens', 'defaultMaxTokens'];

beforeEach(() => {
  vi.clearAllMocks();
  registry.getAllModelsIncludeDisabled.mockResolvedValue([install]);
  registry.getPersonalModels.mockResolvedValue([]);
  registry.getModelsForUser.mockResolvedValue([install, mine]);
});

describe('listModels', () => {
  test('a non-admin gets install rows redacted and their own rows whole', async () => {
    const { models } = await listModels(MEMBER, false);
    const inst = models.find((m) => m.name === 'install-model')!;
    for (const f of INSTALL_ONLY_FIELDS) expect(inst).not.toHaveProperty(f);
    expect(inst).toMatchObject({
      name: 'install-model', provider: 'openai', modelId: 'gpt-x', isEnabled: true, isDefault: true,
      contextWindow: 128000, supportsVision: true, supportsTools: true, supportsStreaming: true,
    });
    expect(inst).toHaveProperty('providerControls');

    const own = models.find((m) => m.name === 'my-model')!;
    expect(own).toMatchObject({ endpoint: 'https://mine.example', apiKeyRef: 'vault:openai', priority: 5 });
  });

  test('an admin keeps the full shape', async () => {
    const { models } = await listModels(ADMIN, true);
    expect(models[0]).toMatchObject({
      endpoint: 'https://internal.example/v1', apiKeyRef: 'vault:openai', metadata: { secretish: 'x' },
      topics: ['build'], priority: 5, costPerInputToken: 1, costPerOutputToken: 2,
    });
  });
});

describe('getModelByName', () => {
  test('a non-admin reads an install row redacted', async () => {
    registry.getModelVisibleTo.mockResolvedValue(install);
    const r = await getModelByName('install-model', MEMBER, false);
    for (const f of [...INSTALL_ONLY_FIELDS, 'topicRoles']) expect(r).not.toHaveProperty(f);
    expect(r).toMatchObject({ name: 'install-model', modelId: 'gpt-x' });
    expect(r).toHaveProperty('capabilities');
  });

  test('a non-admin reads their own personal row whole', async () => {
    registry.getModelVisibleTo.mockResolvedValue(mine);
    expect(await getModelByName('my-model', MEMBER, false)).toMatchObject({ endpoint: 'https://mine.example' });
  });

  test('an admin reads an install row whole', async () => {
    registry.getModelAnyState.mockResolvedValue(install);
    expect(await getModelByName('install-model', ADMIN, true)).toMatchObject({
      endpoint: 'https://internal.example/v1', apiKeyRef: 'vault:openai', topicRoles: { build: 'primary' },
    });
  });
});
