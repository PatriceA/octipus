import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listModels, registerModel, updateModel } from './model-service';
import { modelConfig } from '@/db/schema/models';

const registry = vi.hoisted(() => ({
  getModel: vi.fn(),
  registerModel: vi.fn(),
  updateModel: vi.fn(),
  getAllModelsIncludeDisabled: vi.fn(),
  getModelsForUser: vi.fn(),
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => registry }));
vi.mock('@/models/capabilities', () => ({ getCapabilitiesForModel: () => ({}) }));

beforeEach(() => {
  vi.resetAllMocks();
  registry.registerModel.mockImplementation(async (body) => body);
  registry.updateModel.mockImplementation(async (name, body) => ({ name, ...body }));
});
afterEach(() => vi.unstubAllEnvs());

describe('registerModel — OpenRouter slash validation', () => {
  it('rejects an OpenRouter modelId without a slash, naming the offending id', async () => {
    const result = await registerModel({
      provider: 'openrouter',
      modelId: 'minimax-01',
      name: 'minimax',
    });
    expect(result).toEqual({
      error:
        'OpenRouter models require "provider/model" format (e.g., "minimax/minimax-01"), got "minimax-01"',
    });
  });
});

describe('registerModel — output limits', () => {
  it('an explicit per-request default above the ceiling is still rejected', async () => {
    const result = await registerModel({ provider: 'typesafe', modelId: 'typesafe-ai/jev', name: 'jev', maxTokens: 1024, defaultMaxTokens: 2048 });
    expect(result).toEqual({ error: 'defaultMaxTokens must not exceed maxTokens.' });
  });
});

describe('managed CLI model configuration validation', () => {
  const createBody = { name: 'cli-test', provider: 'cli', modelId: 'cli/claude-code' };

  for (const operation of ['create', 'update'] as const) {
    describe(operation, () => {
      beforeEach(() => {
        registry.getModel.mockResolvedValue(operation === 'update' ? createBody : null);
      });

      async function save(metadata: unknown) {
        return operation === 'create'
          ? registerModel({ ...createBody, metadata })
          : updateModel(createBody.name, { metadata });
      }

      it.each([
        '--effort high', null, 1, {}, [true], [1], ['--effort', { toString: 'high' }],
      ])('rejects malformed extraArgs (%j) without persisting it', async (extraArgs) => {
        const result = await save({ cliAgent: { extraArgs } });
        expect(result).toMatchObject({ error: expect.stringContaining('array of strings') });
        if (operation === 'update') expect(result).toMatchObject({ status: 400 });
        expect(registry.registerModel).not.toHaveBeenCalled();
        expect(registry.updateModel).not.toHaveBeenCalled();
      });

      it.each([{ cliAgent: 'invalid' }, { cliAgent: [] }, { cliAgent: null }, []])(
        'rejects malformed metadata containers (%j)', async (metadata) => {
          expect(await save(metadata)).toMatchObject({ error: expect.stringContaining('Invalid CLI metadata') });
          expect(registry.registerModel).not.toHaveBeenCalled();
          expect(registry.updateModel).not.toHaveBeenCalled();
        },
      );

      it('rejects managed flags without exposing argument values', async () => {
        const result = await save({ cliAgent: { extraArgs: ['--mcp-config', 'secret-config-path'] } });
        expect(result).toMatchObject({ error: expect.stringContaining('Unsupported extraArgs') });
        expect(JSON.stringify(result)).not.toContain('secret-config-path');
        expect(registry.registerModel).not.toHaveBeenCalled();
        expect(registry.updateModel).not.toHaveBeenCalled();
      });

      it.each([undefined, [], ['--effort', 'high'], ['--effort=high', '--no-chrome']])(
        'accepts optional or allowlisted extraArgs (%j)', async (extraArgs) => {
          const metadata = { custom: 'preserved', cliAgent: { extraArgs, permissionMode: 'safe' } };
          const result = await save(metadata);
          expect(result).not.toHaveProperty('error');
          const write = operation === 'create' ? registry.registerModel : registry.updateModel;
          expect(write).toHaveBeenCalledOnce();
          expect(write.mock.calls[0][operation === 'create' ? 0 : 1]).toMatchObject({ metadata });
        },
      );
    });
  }

  it('validates retained arguments against the new adapter when changing model ID', async () => {
    registry.getModel.mockResolvedValue({
      ...createBody,
      metadata: { cliAgent: { extraArgs: ['--no-chrome'] } },
    });
    const result = await updateModel(createBody.name, { modelId: 'cli/codex' });
    expect(result).toMatchObject({ status: 400, error: expect.stringContaining('Codex CLI') });
    expect(registry.updateModel).not.toHaveBeenCalled();
  });

  it('allows clearing previous arguments while changing adapter', async () => {
    registry.getModel.mockResolvedValue({
      ...createBody,
      metadata: { cliAgent: { extraArgs: ['--no-chrome'] } },
    });
    expect(await updateModel(createBody.name, { modelId: 'cli/codex', metadata: null }))
      .toMatchObject({ ok: true });
    expect(registry.updateModel).toHaveBeenCalledOnce();
  });

  it('returns 404 when updating a missing model', async () => {
    registry.getModel.mockResolvedValue(null);
    expect(await updateModel('missing', { metadata: { cliAgent: { extraArgs: 'invalid' } } }))
      .toEqual({ status: 404, error: 'Model not found' });
    expect(registry.updateModel).not.toHaveBeenCalled();
  });
});

describe('direct provider settings validation', () => {
  const row = { name: 'claude', modelId: 'claude-sonnet-4-6', provider: 'anthropic', maxTokens: 16384, defaultMaxTokens: 4096 };
  it('rejects a saved manual budget above the actual default output limit', async () => {
    registry.getModel.mockResolvedValue(row);
    expect(await updateModel(row.name, { metadata: { providerSettings: { thinkingBudget: 8192 } } })).toMatchObject({ status: 400, error: expect.stringContaining('default output limit') });
    expect(registry.updateModel).not.toHaveBeenCalled();
  });
  it('allows raising the default output limit together with the manual budget', async () => {
    registry.getModel.mockResolvedValue(row);
    expect(await updateModel(row.name, { defaultMaxTokens: 16384, metadata: { providerSettings: { thinkingBudget: 8192 } } })).toHaveProperty('ok', true);
  });
  it('rejects reasoning effort on a non-reasoning OpenAI model', async () => {
    registry.getModel.mockResolvedValue(null);
    expect(await registerModel({ name: 'plain', modelId: 'gpt-4o', provider: 'openai', metadata: { providerSettings: { reasoningEffort: 'high' } } })).toHaveProperty('error');
    expect(registry.registerModel).not.toHaveBeenCalled();
  });
  it('rejects negative model rates', async () => {
    expect(await registerModel({ name: 'bad', modelId: 'gpt-5', provider: 'openai', costPerInputToken: -1 })).toHaveProperty('error');
  });
  it.each([
    [{ defaultMaxTokens: 0 }, 'positive integer'],
    [{ defaultMaxTokens: null }, 'positive integer'],
    [{ defaultMaxTokens: 1.5 }, 'positive integer'],
    [{ maxTokens: 1024, defaultMaxTokens: 2048 }, 'must not exceed'],
  ])('rejects invalid output limits on create (%j)', async (limits, message) => {
    expect(await registerModel({ name: 'bad-limits', modelId: 'gpt-5', provider: 'openai', ...limits })).toMatchObject({ error: expect.stringContaining(message) });
    expect(registry.registerModel).not.toHaveBeenCalled();
  });
  it('an omitted create default below the column default is stored as the ceiling, not rejected', async () => {
    // Storing the column default (16384) would give a row its own validator
    // rejects; rejecting the create instead broke every small-ceiling model the
    // UI adds (it never sends defaultMaxTokens). The row must be coherent either way.
    expect(await registerModel({ name: 'small-max', modelId: 'gpt-5', provider: 'openai', maxTokens: 2048 })).toMatchObject({ maxTokens: 2048, defaultMaxTokens: 2048 });
  });
  it('stores column defaults that satisfy the limits validator', async () => {
    // The two limits are validated against each other, so a migration that
    // raises one and leaves the other makes every row it creates fail its own
    // validator — the next PATCH is rejected over fields the caller never sent.
    // CI caught exactly that on the acceptance fixture; the guard is that the
    // defaults themselves are checked, not that today's two numbers are equal.
    const ceiling = modelConfig.maxTokens.default as number;
    const perRequest = modelConfig.defaultMaxTokens.default as number;
    expect(perRequest).toBeLessThanOrEqual(ceiling);
    registry.getModel.mockResolvedValue({
      name: 'defaults', modelId: 'gpt-5', provider: 'openai',
      maxTokens: ceiling, defaultMaxTokens: perRequest,
    });
    registry.updateModel.mockResolvedValue({ name: 'defaults' });
    expect(await updateModel('defaults', { supportsTools: true })).not.toMatchObject({ status: 400 });
  });
  it('validates output limits against the effective update', async () => {
    registry.getModel.mockResolvedValue(row);
    expect(await updateModel(row.name, { defaultMaxTokens: 20000 })).toMatchObject({ status: 400, error: expect.stringContaining('must not exceed') });
    expect(registry.updateModel).not.toHaveBeenCalled();
  });
  it('rejects native-only Anthropic settings while compatibility rollback is active', async () => {
    vi.stubEnv('ANTHROPIC_NATIVE_MESSAGES', '0');
    expect(await registerModel({ name: 'rollback', modelId: 'claude-sonnet-4-6', provider: 'anthropic', metadata: { providerSettings: { strictTools: true } } })).toMatchObject({ error: expect.stringContaining('Strict tools') });
  });
  it('returns effective provider controls with each listed model', async () => {
    vi.stubEnv('ANTHROPIC_NATIVE_MESSAGES', '0');
    registry.getAllModelsIncludeDisabled.mockResolvedValue([row]);
    const result = await listModels('admin', true);
    expect(result.models[0].providerControls).toMatchObject({ reasoning: true, thinkingBudget: true, strictTools: false, cachePolicy: false, cachedContent: false });
  });
});
