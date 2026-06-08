import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Smoke tests for the compiled `octi` binary. We don't run the
 * compiled artifact here (the build target produces a 95MB binary
 * which we don't want to ship to CI runners); we just exercise the
 * TypeScript dispatcher under bun to validate command routing and
 * help output.
 */

const BIN = join(import.meta.dir, 'octi.ts');
const BIN_BASH = join(import.meta.dir, 'octi');

async function run(args: string[], opts: { env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

/**
 * Drive the bash dispatcher directly with an isolated $HOME so destructive
 * commands (uninstall) compute their footprint against a throwaway dir and
 * never touch the real ~/.octipus. We only exercise non-mutating paths
 * (--help, --dry-run, aborted confirm) so nothing is ever deleted.
 */
async function runBash(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'octi-test-home-'));
  const proc = Bun.spawn(['bash', BIN_BASH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : 'ignore',
    env: { ...process.env, HOME: home, ...opts.env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  // Strip ANSI so assertions match on plain text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI.
  const plain = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, '');
  return { stdout, stderr, plain, code };
}

describe('octi dispatcher', () => {
  test('help prints the banner and exits 0', async () => {
    const r = await run(['help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('one nervous system, many arms');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('setup');
    expect(r.stdout).toContain('tui');
    expect(r.stdout).toContain('persona');
  });

  test('--help is an alias', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: octi');
  });

  test('no args defaults to help', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: octi');
  });

  test('version prints semver + Bun version', async () => {
    const r = await run(['version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Octipus v\d+\.\d+\.\d+/);
    expect(r.stdout).toContain('Bun');
  });

  test('unknown command exits 1 with help text', async () => {
    const r = await run(['fhqwhgads']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command');
    expect(r.stderr).toContain('Usage: octi');
  });

  test('doctor --help passes through to the doctor script', async () => {
    const r = await run(['doctor', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: octi doctor');
  });

  test('persona help prints subcommand hints', async () => {
    const r = await run(['persona', 'help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('TUI:');
    expect(r.stdout).toContain('Web:');
  });

  test('help lists the uninstall command', async () => {
    const r = await run(['help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('uninstall');
    expect(r.stdout).toContain('--purge');
  });

  test('uninstall --help routes through to the bash dispatcher', async () => {
    // Full path: TS dispatcher -> delegateBash -> cmd_uninstall_help.
    const r = await run(['uninstall', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('octi uninstall [--purge]');
  });
});

describe('octi uninstall (bash dispatcher)', () => {
  test('--help explains data is kept by default', async () => {
    const r = await runBash(['uninstall', '--help']);
    expect(r.code).toBe(0);
    expect(r.plain).toContain('your data is kept');
    expect(r.plain).toContain('--purge to wipe it');
    expect(r.plain).toContain("Per-project '.octipus/' folders");
  });

  test('--dry-run keeps data and changes nothing', async () => {
    const r = await runBash(['uninstall', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.plain).toContain('Keep your data');
    expect(r.plain).toContain('Back up secrets');
    expect(r.plain).toContain('Dry run — nothing was changed.');
    // The keep path must never advertise destroying data.
    expect(r.plain).not.toContain('Remove EVERYTHING');
  });

  test('--purge --dry-run warns it will remove everything', async () => {
    const r = await runBash(['uninstall', '--purge', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.plain).toContain('Remove EVERYTHING');
    expect(r.plain).toContain('-v');
    expect(r.plain).toContain('Dry run — nothing was changed.');
  });

  test('aborts (exit 1) when the confirmation word does not match', async () => {
    const r = await runBash(['uninstall'], { stdin: 'nope\n' });
    expect(r.code).toBe(1);
    expect(r.plain).toContain('Aborted — nothing was changed.');
  });

  test('purge requires typing "purge", not "uninstall"', async () => {
    const r = await runBash(['uninstall', '--purge'], { stdin: 'uninstall\n' });
    expect(r.code).toBe(1);
    expect(r.plain).toContain('Aborted — nothing was changed.');
  });
});
