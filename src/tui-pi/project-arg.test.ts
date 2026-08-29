import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseProjectArg } from './index';

/**
 * `octi tui` must open on the directory you ran it in.
 *
 * It did not. `bin/octi` ran `npm run tui --project "$PWD"` with no `--`
 * separator, so npm claimed `--project` as its own config flag and forwarded
 * only the bare path; the entry point accepted the flag form only, so the path
 * was dropped. The TUI opened with no project, the agent answered questions
 * about "this directory" out of the user's default workspace, and the banner
 * printed the directory you meant the whole time.
 *
 * It survived every prior QA pass because the live TUI check types into
 * whatever directory it starts in and never asks which files came back. So
 * this file guards both halves — the parser here, the launcher below.
 */

describe('parsing the project argument', () => {
  test('the flag form resolves to an absolute path', () => {
    expect(parseProjectArg(['--project', '/tmp/proj'])).toBe(resolve('/tmp/proj'));
    expect(parseProjectArg(['-p', '/tmp/proj'])).toBe(resolve('/tmp/proj'));
  });

  test('a BARE path is accepted — this is the regression', () => {
    expect(parseProjectArg(['/tmp/proj'])).toBe(resolve('/tmp/proj'));
  });

  test('a relative bare path is resolved, not passed through', () => {
    expect(parseProjectArg(['some/where'])).toBe(resolve('some/where'));
  });

  test('an explicit flag still overrides a positional the launcher added', () => {
    expect(parseProjectArg(['/tmp/from-launcher', '--project', '/tmp/explicit'])).toBe(
      resolve('/tmp/explicit'),
    );
    // …in either order. `bin/octi` puts the flag first and forwards "$@" after.
    expect(parseProjectArg(['--project', '/tmp/explicit', '/tmp/stray'])).toBe(
      resolve('/tmp/explicit'),
    );
  });

  test('a stray argument cannot hijack the project', () => {
    // `octi tui somefile.txt` used to silently repoint the session while the
    // launcher banner still printed the directory the user meant.
    expect(parseProjectArg(['--project', '/tmp/real', 'somefile.txt'])).toBe(resolve('/tmp/real'));
    // Only the first bare argument counts when there is no flag at all.
    expect(parseProjectArg(['/tmp/first', '/tmp/second'])).toBe(resolve('/tmp/first'));
  });

  test('an empty argument is not a path', () => {
    expect(parseProjectArg([''])).toBeUndefined();
    expect(parseProjectArg(['--project', '/tmp/real', ''])).toBe(resolve('/tmp/real'));
  });

  test('no path at all means no project, not a crash', () => {
    expect(parseProjectArg([])).toBeUndefined();
    expect(parseProjectArg(['--verbose'])).toBeUndefined();
  });

  test('a dangling flag does not swallow the next flag as a path', () => {
    expect(parseProjectArg(['--project'])).toBeUndefined();
  });
});

describe('the launcher forwards what it promises', () => {
  /**
   * `npm run <script> --flag value` does NOT reach the script: npm parses
   * `--flag` as its own config and drops it. Every `npm run` in `bin/octi`
   * that passes a flag MEANT FOR THE SCRIPT therefore needs a `--` separator
   * first. Checked as a shape rather than as one hard-coded line, so the next
   * launcher to grow a flag is caught too.
   *
   * npm's own flags are exempt: `npm run build --silent` is silencing npm, and
   * putting a `--` in front of it would forward it to the script instead —
   * turning a correct line into the very bug this guards against.
   */
  const NPM_OWN_FLAGS = new Set([
    '--silent', '-s', '--quiet', '--loglevel', '--if-present', '--workspace', '-w',
    '--workspaces', '--include-workspace-root', '--prefix', '--foreground-scripts',
    '--no-audit', '--no-fund', '--ignore-scripts',
  ]);

  test('every `npm run` that passes a script flag uses a `--` separator', () => {
    const octi = readFileSync(resolve(__dirname, '../../bin/octi'), 'utf8');
    const offenders = octi
      .split('\n')
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, line]) => /\bnpm run \S+/.test(line) && !line.startsWith('#'))
      .filter(([, line]) => {
        // Only what comes after `npm run <script>` and before any `--`.
        const after = line.slice(line.search(/\bnpm run \S+/)).replace(/\bnpm run \S+/, '');
        const beforeSeparator = after.split(/\s--(?=\s|$)/)[0] ?? '';
        return beforeSeparator
          .split(/\s+/)
          .filter((tok) => /^-{1,2}[a-zA-Z]/.test(tok))
          .some((tok) => !NPM_OWN_FLAGS.has(tok.split('=')[0] as string));
      });

    expect(
      offenders,
      `npm eats these flags instead of forwarding them — add a \`--\` before them:\n` +
        offenders.map(([n, l]) => `  bin/octi:${n}  ${l}`).join('\n'),
    ).toEqual([]);
  });

  test('bin/octi is a valid shell script', () => {
    expect(() => execFileSync('bash', ['-n', resolve(__dirname, '../../bin/octi')])).not.toThrow();
  });
});
