import { beforeEach, expect, test, vi } from 'vitest';
import { spawn } from 'child_process';
import { LocalShellOperations } from './local-operations';
import { isToolNotExecutedResult, ToolNotExecutedError } from '@/core/tool-execution-error';
import { wrapCommand } from '@/security/shell-sandbox';

const cleanup = vi.hoisted(() => vi.fn());
vi.mock('@/security/shell-sandbox', () => ({ wrapCommand: vi.fn((argv: string[]) => ({ argv, wrapped: false, runner: null, cleanup })) }));
beforeEach(() => vi.clearAllMocks());

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(() => { throw new Error('A cancelled command must not spawn'); }),
}));

test('an already-cancelled shell call never starts a process', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await new LocalShellOperations().exec('true', process.cwd(), { signal: controller.signal });
  expect(result.aborted).toBe(true);
  expect(isToolNotExecutedResult('shell', result)).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(spawn).not.toHaveBeenCalled();
});


test('cancellation during sandbox setup is proven unexecuted and cleans the wrapper', async () => {
  const controller = new AbortController();
  vi.mocked(wrapCommand).mockImplementationOnce(argv => {
    controller.abort();
    return { argv, wrapped: false, runner: null, cleanup };
  });
  const result = await new LocalShellOperations().exec('true', process.cwd(), { signal: controller.signal });
  expect(isToolNotExecutedResult('shell', result)).toBe(true);
  expect(spawn).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
});

test('a synchronous spawn failure is proven unexecuted and cleans the wrapper', async () => {
  await expect(new LocalShellOperations().exec('true', process.cwd())).rejects.toBeInstanceOf(ToolNotExecutedError);
  expect(spawn).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});
