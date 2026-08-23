import { describe, expect, test } from 'vitest';
import { ModelRegistry } from './model-registry';

/**
 * A7: invalidateCache must also clear the `model:mid:${modelId}` key that feeds
 * resolveProvider(), or a changed provider/apiKeyRef keeps routing to the old
 * target for up to 5 min. invalidateCache is DB-independent, so we stub the
 * cache and call it directly.
 */
describe('ModelRegistry.invalidateCache', () => {
  test('clears model:mid:<id> when a modelId is provided', async () => {
    const deleted: string[] = [];
    const registry = new ModelRegistry();
    (registry as unknown as { cache: { delete: (k: string) => Promise<void> } }).cache = {
      delete: async (k: string) => { deleted.push(k); },
    };

    await (registry as unknown as { invalidateCache: (n: string, m?: string | null) => Promise<void> })
      .invalidateCache('my-model', 'gemini-3.1-flash-lite');

    expect(deleted).toContain('model:my-model');
    expect(deleted).toContain('model:mid:gemini-3.1-flash-lite');
    expect(deleted).toContain('model:default');
  });

  test('omits the mid key when no modelId is provided', async () => {
    const deleted: string[] = [];
    const registry = new ModelRegistry();
    (registry as unknown as { cache: { delete: (k: string) => Promise<void> } }).cache = {
      delete: async (k: string) => { deleted.push(k); },
    };

    await (registry as unknown as { invalidateCache: (n: string, m?: string | null) => Promise<void> })
      .invalidateCache('my-model');

    expect(deleted).toContain('model:my-model');
    expect(deleted.some((k) => k.startsWith('model:mid:'))).toBe(false);
  });
});
