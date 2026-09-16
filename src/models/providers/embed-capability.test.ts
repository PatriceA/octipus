import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';

// Pure unit test: proves the "can this provider embed" notion topics.ts (Guard 1)
// and litellm-client.ts:792 both rely on — provider.embed is optional on the
// provider interface, litellm is a special-cased proxy. No DB needed:
// ProviderRouter's constructor does no I/O.
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.LOG_LEVEL ??= 'error';
process.env.NODE_ENV ??= 'test';
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

const { ProviderRouter } = await import('./index');

describe('ProviderRouter embed capability', () => {
  test('CLIProvider does not implement embed', () => {
    const router = new ProviderRouter();
    const cli = router.getProviderByName('cli');
    expect(cli).toBeDefined();
    expect(cli!.embed).toBeUndefined();
  });

  test('OllamaProvider implements embed', () => {
    const router = new ProviderRouter();
    const ollama = router.getProviderByName('ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.embed).toBeTypeOf('function');
  });

  test('getEmbedCapableProviderNames lists embed-capable providers, excludes cli', () => {
    const router = new ProviderRouter();
    const names = router.getEmbedCapableProviderNames();
    expect(names).toContain('ollama');
    expect(names).toContain('openai');
    expect(names).toContain('voyage');
    expect(names).not.toContain('cli');
  });
});
