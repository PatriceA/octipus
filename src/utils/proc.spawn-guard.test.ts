/**
 * argv[0] decides which binary runs, and every spawn in the process goes
 * through `spawnProcess`. CodeQL alert 15 (js/command-line-injection) tracks
 * remote data — a chat attachment, through the voice transcriber — into the
 * array whose first element becomes that command. Whatever the real
 * reachability, a command name is a fixed thing: nothing legitimate needs a
 * metacharacter or a leading dash there.
 */
import { describe, expect, test } from 'vitest';
import { spawnProcess } from './proc';

describe('spawnProcess argv[0] guard', () => {
  test('a flag-shaped command is refused', () => {
    expect(() => spawnProcess({ command: '-rf', args: ['/'] })).toThrow(/starts with "-"/);
  });

  test('shell metacharacters in the command are refused', () => {
    for (const cmd of ['sh -c "id"', 'ls;id', 'ls|id', 'ls$(id)', 'ls`id`', 'ls&', 'ls>out']) {
      expect(() => spawnProcess({ command: cmd })).toThrow(/unexpected characters/);
    }
  });

  test('a command line with a space is refused', () => {
    // A space alone must not turn a command line into a command — the positive
    // case (an absolute path that has one) is covered below by
    // `process.execPath`, which on Windows is `C:\Program Files\nodejs\node.exe`.
    expect(() => spawnProcess({ command: 'sh -c id' })).toThrow(/unexpected characters/);
  });

  test('an empty command is still refused', () => {
    expect(() => spawnProcess({ command: '' })).toThrow(/no command given/);
  });

  test('ordinary commands and absolute paths still run', async () => {
    const plain = spawnProcess({ command: 'echo', args: ['hi'], stdout: 'ignore', stderr: 'ignore' });
    expect(await plain.exited).toBe(0);
    // `process.execPath` is the absolute path that exists on every platform;
    // `/bin/echo` is not one of them.
    const absolute = spawnProcess({ command: process.execPath, args: ['-e', ''], stdout: 'ignore', stderr: 'ignore' });
    expect(await absolute.exited).toBe(0);
  });

  test('arguments are untouched — they never reach a shell', async () => {
    // `;id` is inert as an argument; only argv[0] is restricted.
    const proc = spawnProcess({ command: 'echo', args: [';id', '$(id)'], stdout: 'ignore', stderr: 'ignore' });
    expect(await proc.exited).toBe(0);
  });
});
