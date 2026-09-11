import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerModel, updateModel } from './model-service';

const registry = vi.hoisted(() => ({
  getModel: vi.fn(),
  registerModel: vi.fn(),
  updateModel: vi.fn(),
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => registry }));
vi.mock('@/models/capabilities', () => ({ getCapabilitiesForModel: () => ({}) }));

beforeEach(() => {
  vi.resetAllMocks();
  registry.registerModel.mockImplementation(async (body) => body);
  registry.updateModel.mockImplementation(async (name, body) => ({ name, ...body }));
});

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
