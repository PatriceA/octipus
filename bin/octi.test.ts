import { describe, expect, test } from 'bun:test';
import { join } from 'path';

/**
 * Smoke tests for the compiled `octi` binary. We don't run the
 * compiled artifact here (the build target produces a 95MB binary
 * which we don't want to ship to CI runners); we just exercise the
 * TypeScript dispatcher under bun to validate command routing and
 * help output.
 */

const BIN = join(import.meta.dir, 'octi.ts');

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

describe('octi dispatcher', () => {
  test('help prints the banner and exits 0', async () => {
    const r = await run(['help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('one nervous system, eight arms');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('init');
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
});
