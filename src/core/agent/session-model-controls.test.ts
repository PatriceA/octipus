import { beforeEach, expect, test, vi } from 'vitest';
const f = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  context: {} as {
    cliOverrides?: Array<{ modelName: string; topic: string; model?: string }>;
    cliOverridesRevision?: number;
  },
  resolve: vi.fn(),
  catalog: vi.fn(),
  codexInfo: vi.fn(),
}));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { findSessionRuns: async () => f.rows } }));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: async () => ({ context: f.context }) },
}));
vi.mock('@/models/resolve-model', () => ({ resolveModel: f.resolve }));
vi.mock('@/core/cli-runtime-info', () => ({ codexRuntimeInfo: f.codexInfo }));
vi.mock('@/core/cli-agent-factory', () => ({
  getCLIToolConfig: (id: string) =>
    id === 'cli/codex'
      ? { name: 'Codex CLI' }
      : id === 'cli/claude'
        ? { name: 'Claude Code', listModels: f.catalog }
        : id === 'cli/vibe'
          ? { name: 'Mistral Vibe' }
          : null,
}));
import { readSessionModelControls, readSessionCliCatalog, validateSessionCliOverrides } from './session-model-controls';
const row = {
  name: 'codex-row',
  provider: 'cli',
  modelId: 'cli/codex',
  metadata: { cliAgent: { model: 'configured' } },
};
beforeEach(() => {
  vi.clearAllMocks();
  f.rows = [];
  f.context = {};
  f.resolve.mockResolvedValue(null);
  f.catalog.mockResolvedValue([{ id: 'account-model', label: 'Account model' }]);
  f.codexInfo.mockResolvedValue({ models: [{ id: 'codex-account-model', label: 'Codex account model' }] });
});

test('topic bindings, explicit stage rows and saved overrides are exposed without inventing historical models', async () => {
  f.context = {
    cliOverridesRevision: 3,
    cliOverrides: [{ modelName: 'codex-row', topic: 'verify', model: 'session-model' }],
  };
  f.resolve.mockImplementation(async (q: { topic?: string; name?: string; userId: string }) =>
    q.userId === 'owner' && (q.topic === 'build' || q.name === 'codex-row') ? row : null,
  );
  f.rows = [
    {
      id: 'new',
      role: 'review',
      topic: 'verify',
      model: 'cli/codex',
      metadata: { modelName: 'codex-row', cliRun: { model: 'observed-model', adapter: 'Codex CLI', effort: 'high' } },
      status: 'running',
      createdAt: new Date('2026-11-19T10:00:00Z'),
    },
    {
      id: 'old',
      role: 'general',
      topic: 'everyday',
      model: 'cli/codex',
      metadata: {},
      status: 'completed',
      createdAt: new Date('2026-11-18T10:00:00Z'),
    },
  ];
  const data = await readSessionModelControls('s', 'owner');
  expect(data.revision).toBe(3);
  expect(data.bindings.map((b) => [b.topic, b.modelName])).toEqual([
    ['build', 'codex-row'],
    ['verify', 'codex-row'],
  ]);
  expect(data.runs[0]).toMatchObject({ model: 'observed-model', adapter: 'Codex CLI', effort: 'high' });
  expect(data.runs[1].model).toBeNull();
});
test('explicit model choices are validated against this owner and adapter capabilities', async () => {
  f.resolve.mockResolvedValue(row);
  const entry = { modelName: 'codex-row', topic: 'build', model: 'account/model', effort: 'high' };
  await expect(validateSessionCliOverrides([entry], 'owner')).resolves.toBeUndefined();
  expect(f.resolve).toHaveBeenCalledWith({ userId: 'owner', name: 'codex-row' });
  await expect(validateSessionCliOverrides([entry, entry], 'owner')).rejects.toThrow(/Duplicate/);
  await expect(validateSessionCliOverrides([{ ...entry, model: 'x"\n-argument' }], 'owner')).rejects.toThrow(
    /identifier/,
  );
  await expect(validateSessionCliOverrides([{ ...entry, effort: 'invented' }], 'owner')).rejects.toThrow(/unsupported/);
  f.resolve.mockResolvedValue(null);
  await expect(validateSessionCliOverrides([entry], 'other')).rejects.toThrow(/unavailable/);
  f.resolve.mockResolvedValue({ ...row, modelId: 'cli/vibe' });
  await expect(validateSessionCliOverrides([entry], 'owner')).rejects.toThrow(/runtime profile/);
});
test('catalog discovery never borrows an install account for a personal row and reports unavailable catalogs', async () => {
  f.resolve.mockResolvedValue({ ...row, modelId: 'cli/claude', ownerUserId: 'owner' });
  expect(await readSessionCliCatalog('personal', 'owner')).toMatchObject({
    models: [],
    error: expect.stringContaining('personal'),
  });
  expect(f.catalog).not.toHaveBeenCalled();
  f.resolve.mockResolvedValue({ ...row, modelId: 'cli/claude' });
  expect(await readSessionCliCatalog('install', 'owner')).toEqual({
    models: [{ id: 'account-model', label: 'Account model' }],
  });
  f.catalog.mockRejectedValueOnce(new Error('private authentication diagnostic'));
  expect(await readSessionCliCatalog('install', 'owner')).toEqual({
    models: [],
    error: 'CLI model catalog unavailable; verify its login in Models.',
  });
  f.resolve.mockResolvedValue(row);
  expect(await readSessionCliCatalog('install', 'owner')).toEqual({
    models: [{ id: 'codex-account-model', label: 'Codex account model' }],
  });
});
