import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let missingBinaries = new Set<string>();
vi.mock('@/core/cli-executable', () => ({
  configuredCliBinary: (binary: string) => {
    if (missingBinaries.has(binary)) throw new Error(`CLI executable "${binary}" was not found or is not executable. Searched PATH=/secret/bin:/usr/bin.`);
    return `/usr/bin/${binary}`;
  },
}));

const { getCircuitBreakerRegistry, resetCircuitBreakerRegistry } = await import('@/models/circuit-breaker');
const { __resetCliToolAvailabilityForTests } = await import('@/models/providers/cli-provider');
const {
  checkModelAvailability, routeAroundUnavailable, routeMismatchMessage, MAX_REASON_CHARS,
} = await import('./lane-availability');

function openBreaker(key: string): void {
  for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure(key);
}

beforeEach(() => {
  missingBinaries = new Set();
  resetCircuitBreakerRegistry();
  __resetCliToolAvailabilityForTests();
});
afterEach(() => resetCircuitBreakerRegistry());

describe('checkModelAvailability', () => {
  test('a model whose provider has no breaker history is available', async () => {
    expect(await checkModelAvailability({ modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' })).toEqual({ available: true });
  });

  test("an open breaker on a direct provider makes it unavailable, with when it opened", async () => {
    openBreaker('openai');
    const r = await checkModelAvailability({ modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/circuit breaker for 'openai' open since \d{4}-/);
  });

  test("another provider's open breaker does not count", async () => {
    openBreaker('anthropic');
    expect((await checkModelAvailability({ modelId: 'gpt-x', provider: 'openai' })).available).toBe(true);
  });

  test('a LiteLLM row ignores the litellm breaker — only the router fallback trips it, not the child route', async () => {
    openBreaker('litellm');
    expect((await checkModelAvailability({ modelId: 'deepseek/deepseek-chat', name: 'ds', provider: 'litellm' })).available).toBe(true);
  });

  test("a CLI child ignores the cli-* breakers — the CLI agent worker never consults them", async () => {
    openBreaker('cli-codex');
    openBreaker('cli-claude');
    expect((await checkModelAvailability({ modelId: 'cli/codex', name: 'codex-cli', provider: 'cli' })).available).toBe(true);
  });

  test('a CLI model whose executable is missing is unavailable, and the reason carries no PATH', async () => {
    missingBinaries.add('claude');
    const r = await checkModelAvailability({ modelId: 'cli/claude-code', name: 'claude-code', provider: 'cli' });
    expect(r).toEqual({ available: false, reason: "CLI 'claude' not installed" });
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

  test('reasons are capped', async () => {
    openBreaker('openai');
    const long = { modelId: 'm'.repeat(2000), name: 'n'.repeat(2000), provider: 'openai' };
    const r = await routeAroundUnavailable({ lane: 'build', primary: long, allowBackup: true, resolveBackup: async () => null });
    if (r.route !== 'deny') throw new Error('expected deny');
    expect(r.reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
  });
});

describe('routeMismatchMessage', () => {
  test('names the lane and its bound model, row name and id', () => {
    const msg = routeMismatchMessage({ requested: 'gpt-5', lane: 'build', resolved: { modelId: 'claude-sonnet-x', name: 'Sonnet (install)' } });
    expect(msg).toContain("Requested primaryModel 'gpt-5'");
    expect(msg).toContain("The 'build' lane is bound to 'Sonnet (install) (claude-sonnet-x)'");
    expect(msg).toMatch(/omit routePolicy\.primaryModel, or ask the user to change the binding/);
  });

  test('a planned child names the executor as the executor, and the primary beside it', () => {
    const msg = routeMismatchMessage({
      requested: 'gpt-5', lane: 'build', resolved: { modelId: 'qwen-small', name: 'qwen-small' },
      executorOf: { primary: { modelId: 'claude-sonnet-x', name: 'claude-sonnet-x' } },
    });
    expect(msg).toContain("Planned children of the 'build' lane run on its executor 'qwen-small' (primary 'claude-sonnet-x')");
    expect(msg).not.toMatch(/bound to 'qwen-small'/);
  });
});
