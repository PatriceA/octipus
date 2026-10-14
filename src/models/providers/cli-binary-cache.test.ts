import { afterEach, expect, test, vi } from 'vitest';
import { CLI_BINARY_CHECK_TTL_MS, CLI_TOOLS, CLIProvider } from './cli-provider';

process.env.LOG_LEVEL ??= 'error';

afterEach(() => { vi.useRealTimers(); });

/** The lookup seam (`which`/`where`), counted instead of spawned. */
function counted(provider: CLIProvider): { lookups: () => number } {
  let n = 0;
  (provider as unknown as { checkToolAvailable: () => Promise<boolean> }).checkToolAvailable = async () => { n++; return true; };
  return { lookups: () => n };
}

test('CLI binaries are looked up once per TTL, not on every health check', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const provider = new CLIProvider();
  const { lookups } = counted(provider);

  expect((await provider.checkHealth()).healthy).toBe(true);
  expect(lookups()).toBe(CLI_TOOLS.length);
  await provider.checkHealth();
  await provider.getAvailableTools();
  expect(lookups()).toBe(CLI_TOOLS.length);

  vi.setSystemTime(Date.now() + CLI_BINARY_CHECK_TTL_MS + 1);
  await provider.checkHealth();
  expect(lookups()).toBe(2 * CLI_TOOLS.length);
});
