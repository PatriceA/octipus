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
    expect(() => spawnProcess(['-rf', '/'])).toThrow(/starts with "-"/);
  });

  test('shell metacharacters in the command are refused', () => {
    for (const cmd of ['sh -c "id"', 'ls;id', 'ls|id', 'ls$(id)', 'ls`id`', 'ls&', 'ls>out']) {
      expect(() => spawnProcess([cmd])).toThrow(/unexpected characters/);
    }
  });

  test('an empty command is still refused', () => {
    expect(() => spawnProcess([])).toThrow(/no command given/);
  });

  test('ordinary commands and absolute paths still run', async () => {
    const plain = spawnProcess(['echo', 'hi'], { stdout: 'ignore', stderr: 'ignore' });
    expect(await plain.exited).toBe(0);
    const absolute = spawnProcess(['/bin/echo', 'hi'], { stdout: 'ignore', stderr: 'ignore' });
    expect(await absolute.exited).toBe(0);
  });

  test('arguments are untouched — they never reach a shell', async () => {
    // `;id` is inert as an argument; only argv[0] is restricted.
    const proc = spawnProcess(['echo', ';id', '$(id)'], { stdout: 'ignore', stderr: 'ignore' });
    expect(await proc.exited).toBe(0);
  });
});
