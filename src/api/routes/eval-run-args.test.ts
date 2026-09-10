/**
 * `POST /eval/run` puts `suite` and `model` from the request body into the
 * argv of a process that inherits the server's environment — provider keys
 * included. Spawning without a shell keeps metacharacters inert; it does not
 * stop a value from BEING an option (`--evalDir`, `--output=/etc/x`), which is
 * what CodeQL alert 15 (js/command-line-injection) is about.
 */
import { describe, expect, test } from 'vitest';
import { buildEvalRunArgv } from './eval';

describe('buildEvalRunArgv', () => {
  test('a suite name is passed as a value, not spliced into a command', () => {
    const built = buildEvalRunArgv({ suite: 'memory' });
    expect(built).toEqual({
      command: 'npx',
      args: ['tsx', '--import', './scripts/md-loader.mjs', 'src/eval/cli.ts', '--suite', 'memory'],
    });
  });

  test('a flag-shaped suite is refused rather than injected', () => {
    for (const suite of ['--evalDir', '-s', '--output=/etc/x']) {
      expect(buildEvalRunArgv({ suite })).toEqual({ error: expect.stringContaining('Invalid suite') });
    }
  });

  test('a flag-shaped model is refused too', () => {
    expect(buildEvalRunArgv({ model: '--baseline=/etc/shadow' }))
      .toEqual({ error: expect.stringContaining('Invalid model') });
  });

  test('shell metacharacters never reach argv', () => {
    for (const suite of ['a;rm -rf /', 'a$(id)', 'a`id`', 'a|b', 'a b']) {
      expect(buildEvalRunArgv({ suite })).toEqual({ error: expect.stringContaining('Invalid suite') });
    }
  });

  test('a real model id with : / . - is accepted', () => {
    const built = buildEvalRunArgv({ model: 'deepseek/deepseek-v4-flash-0731' });
    expect(built).toEqual({ command: 'npx', args: expect.arrayContaining(['--model', 'deepseek/deepseek-v4-flash-0731']) });
    const ollama = buildEvalRunArgv({ model: 'ornith:35b' });
    expect(ollama).toEqual({ command: 'npx', args: expect.arrayContaining(['--model', 'ornith:35b']) });
  });

  test('the red-team run takes no --suite, and runs on Node', () => {
    const built = buildEvalRunArgv({ type: 'red-team', suite: 'ignored', model: 'ornith:35b' });
    expect(built).toEqual({
      command: 'npx',
      args: ['tsx', '--import', './scripts/md-loader.mjs', 'src/eval/red-team/cli.ts', '--model', 'ornith:35b'],
    });
    // It used to spawn `bun`, which this repo no longer runs on.
    expect((built as { command: string }).command).not.toBe('bun');
  });
});
