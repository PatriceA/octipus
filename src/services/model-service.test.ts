import { describe, expect, it } from 'vitest';
import { registerModel } from './model-service';

// Focused on the pure, pre-DB validation branch in registerModel: OpenRouter
// model IDs must be "provider/model". This guard returns before any registry/DB
// call, so it needs no mocks — and it's exactly the kind of check a refactor
// (like the routes→service extraction) can silently drop. No DB-touching paths
// are exercised here on purpose (bun's mock.module is process-global and leaks).
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
