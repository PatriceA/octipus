import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let missingBinaries = new Set<string>();
vi.mock('@/core/cli-executable', () => ({
  configuredCliBinary: (binary: string) => {
    if (missingBinaries.has(binary)) throw new Error(`CLI executable "${binary}" was not found or is not executable.`);
    return `/usr/bin/${binary}`;
  },
}));

const { getCircuitBreakerRegistry, resetCircuitBreakerRegistry } = await import('@/models/circuit-breaker');
const {
  __resetAvailabilityCacheForTests, checkModelAvailability, routeAroundUnavailable, routeMismatchMessage,
} = await import('./lane-availability');

function openBreaker(key: string): void {
  for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure(key);
}

beforeEach(() => {
  missingBinaries = new Set();
  resetCircuitBreakerRegistry();
  __resetAvailabilityCacheForTests();
});
afterEach(() => resetCircuitBreakerRegistry());

describe('checkModelAvailability', () => {
  test('a model whose provider has no breaker history is available', () => {
    expect(checkModelAvailability({ modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' })).toEqual({ available: true });
  });

  test('an open breaker on the provider makes it unavailable, with when it opened', () => {
    openBreaker('openai');
    const r = checkModelAvailability({ modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/circuit breaker for 'openai' open since \d{4}-/);
  });

  test("another provider's open breaker does not count", () => {
    openBreaker('anthropic');
    expect(checkModelAvailability({ modelId: 'gpt-x', provider: 'openai' }).available).toBe(true);
  });

  test("a CLI model reads its tool's breaker key, not the provider name", () => {
    openBreaker('cli-codex');
    const r = checkModelAvailability({ modelId: 'cli/codex', name: 'codex-cli', provider: 'cli' });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("'cli-codex'");
  });

  test('a CLI model whose executable is missing is unavailable', () => {
    missingBinaries.add('claude');
    const r = checkModelAvailability({ modelId: 'cli/claude-code', name: 'claude-code', provider: 'cli' });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/CLI 'claude' not installed/);
  });
});

describe('routeAroundUnavailable', () => {
  const primary = { modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' };
  const backup = { modelId: 'claude-y', name: 'claude-y', provider: 'anthropic' };

  test('available primary ⇒ primary, backup never looked up', async () => {
    const resolveBackup = vi.fn(async () => backup);
    expect(await routeAroundUnavailable({ lane: 'build', primary, allowBackup: true, resolveBackup })).toEqual({ route: 'primary' });
    expect(resolveBackup).not.toHaveBeenCalled();
  });

  test('open primary + usable backup ⇒ backup with the reason', async () => {
    openBreaker('openai');
    const r = await routeAroundUnavailable({ lane: 'build', primary, allowBackup: true, resolveBackup: async () => backup });
    expect(r).toMatchObject({ route: 'backup', modelId: 'claude-y', modelName: 'claude-y' });
    if (r.route === 'backup') expect(r.reason).toMatch(/^lane 'build' model gpt-x unavailable: circuit breaker/);
  });

  test('open primary + no backup ⇒ deny naming the lane, model and cause', async () => {
    openBreaker('openai');
    const r = await routeAroundUnavailable({ lane: 'build', primary, allowBackup: true, resolveBackup: async () => null });
    expect(r.route).toBe('deny');
    if (r.route === 'deny') expect(r.reason).toMatch(/^lane 'build' model gpt-x unavailable: circuit breaker for 'openai' open since .*; no backup bound$/);
  });

  test('open primary + allowBackup false ⇒ deny without consulting the backup', async () => {
    openBreaker('openai');
    const resolveBackup = vi.fn(async () => backup);
    const r = await routeAroundUnavailable({ lane: 'build', primary, allowBackup: false, resolveBackup });
    expect(r.route).toBe('deny');
    if (r.route === 'deny') expect(r.reason).toMatch(/backup disabled by routePolicy/);
    expect(resolveBackup).not.toHaveBeenCalled();
  });

  test('backup that is down too ⇒ deny naming both', async () => {
    openBreaker('openai');
    openBreaker('anthropic');
    const r = await routeAroundUnavailable({ lane: 'verify', primary, allowBackup: true, resolveBackup: async () => backup });
    expect(r.route).toBe('deny');
    if (r.route === 'deny') expect(r.reason).toMatch(/backup claude-y also unavailable/);
  });

  test('backup identical to the primary ⇒ treated as no backup', async () => {
    openBreaker('openai');
    const r = await routeAroundUnavailable({ lane: 'build', primary, allowBackup: true, resolveBackup: async () => primary });
    expect(r.route).toBe('deny');
  });
});

describe('routeMismatchMessage', () => {
  test('names the lane and its bound model, row name and id', () => {
    const msg = routeMismatchMessage('gpt-5', 'build', 'claude-sonnet-x', 'Sonnet (install)');
    expect(msg).toContain("Requested primaryModel 'gpt-5'");
    expect(msg).toContain("The 'build' lane is bound to 'Sonnet (install)' (model id 'claude-sonnet-x')");
    expect(msg).toMatch(/omit routePolicy\.primaryModel, or ask the user to change the binding/);
  });
});
