import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { installExitGuards } from './runtime';

function fakeProcess() {
  const events = new EventEmitter();
  const order: string[] = [];
  const proc = {
    on: (event: string, listener: (value: unknown) => void) => events.on(event, listener),
    exit: vi.fn((code: number) => { order.push(`exit ${code}`); }),
    stderr: { write: vi.fn((text: string) => { order.push(`stderr ${text.trim().split('\n')[0]}`); }) },
  };
  const restore = vi.fn(() => { order.push('restore'); });
  installExitGuards(restore, proc);
  return { events, order, restore };
}

test.each([
  ['uncaughtException', new Error('boom'), 'stderr Uncaught exception: Error: boom'],
  ['unhandledRejection', 'plain reason', 'stderr Unhandled rejection: plain reason'],
])('%s restores the terminal, then prints the error, then exits non-zero', (event, error, printed) => {
  const f = fakeProcess();
  f.events.emit(event, error);
  expect(f.order).toEqual(['restore', printed, 'exit 1']);
});

test('process exit and SIGHUP restore the terminal', () => {
  const f = fakeProcess();
  f.events.emit('exit', 0);
  expect(f.order).toEqual(['restore']);
  f.events.emit('SIGHUP');
  expect(f.order).toEqual(['restore', 'restore', 'exit 129']);
});
