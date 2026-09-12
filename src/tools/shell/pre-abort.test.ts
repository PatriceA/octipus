import { expect, test, vi } from 'vitest';
import { spawn } from 'child_process';
import { LocalShellOperations } from './local-operations';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(() => { throw new Error('A cancelled command must not spawn'); }),
}));

test('an already-cancelled shell call never starts a process', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await new LocalShellOperations().exec('true', process.cwd(), { signal: controller.signal });
  expect(result.aborted).toBe(true);
  expect(spawn).not.toHaveBeenCalled();
});
