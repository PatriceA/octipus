/**
 * macOS: sandbox-exec with a generated Seatbelt (SBPL) profile. Everything
 * here is platform-independent: the profile is a string, and wrapCommand's
 * darwin branch runs with `process.platform` faked and `/usr/bin/sandbox-exec`
 * made to "exist" for detection only. Nothing is executed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let fakeRunner: string | null = null;
let sandboxMode: 'auto' | 'required' = 'required';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const KNOWN = ['/usr/bin/sandbox-exec', '/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap', '/usr/bin/firejail', '/usr/local/bin/firejail', '/bin/firejail'];
  const existsSync = (p: import('node:fs').PathLike) => (KNOWN.includes(String(p)) ? String(p) === fakeRunner : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});
vi.mock('@/config', async (original) => ({
  ...(await original<typeof import('@/config')>()),
  getConfig: () => ({ security: { shellSandbox: sandboxMode } }),
}));

import { _resetSandboxDetectionForTests, activeSandboxRunner, buildSeatbeltProfile, detectRunner, sbplString, wrapCommand } from '@/security/shell-sandbox';

const pkg = '/srv/octipus/plugin-packages/demo-pkg';
const data = '/srv/octipus/plugin-data/demo-pkg';
const inputs = { scratch: '/private/var/folders/xy/T/octipus-shell-abc', runtimeDirs: [], cliPaths: [] };

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

afterEach(() => { fakeRunner = null; sandboxMode = 'required'; setPlatform(realPlatform); _resetSandboxDetectionForTests(); });

/** The rules of a profile, one per line. */
const rules = (profile: string) => profile.trim().split('\n');
const networkRules = (profile: string) => rules(profile).filter((r) => r.includes('network'));

describe('SBPL string literals', () => {
  test('plain paths are quoted as they are', () => {
    expect(sbplString('/usr/lib')).toBe('"/usr/lib"');
    expect(sbplString('/Users/a b/ü')).toBe('"/Users/a b/ü"');
  });

  test('quotes and backslashes are escaped, so a path cannot close the literal', () => {
    expect(sbplString('/tmp/a"b')).toBe('"/tmp/a\\"b"');
    expect(sbplString('/tmp/a\\b')).toBe('"/tmp/a\\\\b"');
    // A backslash right before a quote: both escaped, the literal still ends where it should.
    expect(sbplString('/x\\"))(allow default)(";')).toBe('"/x\\\\\\"))(allow default)(\\";"');
    expect(sbplString('/a\nb\tc\rd')).toBe('"/a\\nb\\tc\\rd"');
  });

  test('other control characters are refused', () => {
    expect(() => sbplString('/a\u0000b')).toThrow(/control character/);
    expect(() => sbplString('/a\u001bb')).toThrow(/control character/);
    expect(() => sbplString('/a\u007fb')).toThrow(/control character/);
  });

  test('an unescaped quote never appears inside a generated rule', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: '/tmp/ws"(allow network*)"', extraReadWrite: ['/d\\"x'] }, inputs);
    expect(profile).not.toMatch(/^\(allow network\*\)$/m);
    expect(profile).toContain('(subpath "/tmp/ws\\"(allow network*)\\"")');
    expect(profile).toContain('(subpath "/d\\\\\\"x")');
    // Every line still has balanced parentheses outside string literals.
    for (const line of rules(profile)) {
      const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      expect(bare.split('(').length).toBe(bare.split(')').length);
    }
  });
});

describe('the Seatbelt profile', () => {
  test('denies everything by default and starts with the version', () => {
    const r = rules(buildSeatbeltProfile({ workspaceRoot: pkg }, inputs));
    expect(r.slice(0, 2)).toEqual(['(version 1)', '(deny default)']);
  });

  test('no hosts: no network rule at all, not even loopback', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data] }, inputs);
    expect(networkRules(profile)).toEqual([]);
    expect(profile).not.toMatch(/\(allow network/);
    // No DNS either: the resolver's mach service stays out.
    expect(profile).not.toContain('com.apple.dnssd.service');
  });

  test('hosts: outbound TCP only to the proxy port on localhost', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data], loopbackPorts: [43123] }, inputs);
    expect(networkRules(profile)).toEqual(['(allow network-outbound (remote ip "localhost:43123"))']);
    expect(profile).not.toContain('(allow network*)');
    expect(profile).not.toContain('com.apple.dnssd.service');
  });

  test('an invalid port is refused rather than written into a rule', () => {
    expect(() => buildSeatbeltProfile({ workspaceRoot: pkg, loopbackPorts: [0] }, inputs)).toThrow(/port/);
    expect(() => buildSeatbeltProfile({ workspaceRoot: pkg, loopbackPorts: [1.5] }, inputs)).toThrow(/port/);
    expect(() => buildSeatbeltProfile({ workspaceRoot: pkg, loopbackPorts: [70000] }, inputs)).toThrow(/port/);
  });

  test('allowNetwork opens the network (and DNS); loopbackPorts is then moot', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: pkg, allowNetwork: true, loopbackPorts: [43123] }, inputs);
    expect(networkRules(profile)).toEqual(['(allow network*)']);
    expect(profile).toContain('(global-name "com.apple.dnssd.service")');
  });

  test('read-only package dir: readable, never writable, and the deny is the last rule', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data] }, inputs);
    const r = rules(profile);
    const writes = r.filter((l) => l.includes('file-write*') && l.startsWith('(allow'));
    expect(writes.some((l) => l.includes(`(subpath "${pkg}")`))).toBe(false);
    expect(r).toContain(`(allow file-read* file-map-executable (subpath "${pkg}"))`);
    expect(r.at(-1)).toBe(`(deny file-write* (subpath "${pkg}"))`);
    // The data directory and the scratch are the writable ones.
    const writable = writes.find((l) => l.includes(inputs.scratch));
    expect(writable).toContain(`(subpath "${data}")`);
  });

  test('a writable workspace is read-write and has no deny', () => {
    const r = rules(buildSeatbeltProfile({ workspaceRoot: pkg }, inputs));
    expect(r).toContain(`(allow file-read* file-write* file-map-executable (subpath "${pkg}"))`);
    expect(r.some((l) => l.startsWith('(deny file-write*'))).toBe(false);
  });

  test('reads only the system and runtime paths, not the home directory', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: pkg, extraReadOnly: ['/opt/node/bin/node'] }, { ...inputs, runtimeDirs: ['/Users/me/.local/bin'] });
    const read = rules(profile).find((l) => l.startsWith('(allow file-read* file-map-executable (subpath "/System")'));
    expect(read).toBeDefined();
    for (const p of ['/System', '/usr', '/bin', '/private/etc', '/private/var/db/timezone', '/Users/me/.local/bin', '/opt/node/bin/node']) {
      expect(read).toContain(`(subpath "${p}")`);
    }
    expect(profile).not.toMatch(/\(subpath "\/Users"\)|\(subpath "\/Users\/me"\)/);
    // File contents are listed; only metadata is global.
    expect(rules(profile)).toContain('(allow file-read-metadata)');
    expect(rules(profile).filter((l) => /^\(allow file-read\*\)$/.test(l))).toEqual([]);
  });

  test('macOS top-level links get their /private spelling too', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: '/tmp/octipus-test-nonexistent/ws' }, inputs);
    expect(profile).toContain('(subpath "/tmp/octipus-test-nonexistent/ws")');
    expect(profile).toContain('(subpath "/private/tmp/octipus-test-nonexistent/ws")');
  });

  test('the SSH agent socket is the one Unix socket it may connect to', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: pkg, sshAgent: { socket: '/Users/me/.octipus/agent.sock' } as never }, inputs);
    expect(networkRules(profile)).toEqual(['(allow network-outbound (remote unix-socket (path-literal "/Users/me/.octipus/agent.sock")))']);
  });
});

describe('wrapCommand on darwin', () => {
  beforeEach(() => { setPlatform('darwin'); _resetSandboxDetectionForTests(); });

  test('detects /usr/bin/sandbox-exec only when Seatbelt is allowed, and nothing when it is missing', () => {
    fakeRunner = '/usr/bin/sandbox-exec';
    expect(detectRunner({ allowSeatbelt: true })).toEqual({ runner: 'sandbox-exec', binary: '/usr/bin/sandbox-exec' });
    // Callers that do not ask (tests keyed off `detectRunner() !== null`,
    // scorers) see no runner on macOS, as before.
    expect(detectRunner()).toBeNull();
    // `required` allows it for everyone.
    expect(activeSandboxRunner()).toBe('sandbox-exec');
    _resetSandboxDetectionForTests();
    fakeRunner = null;
    expect(detectRunner({ allowSeatbelt: true })).toBeNull();
    expect(() => wrapCommand(['true'], { workspaceRoot: pkg })).toThrow(/sandbox-exec/);
  });

  test('auto: the shell tool stays unwrapped, a package server is wrapped', () => {
    sandboxMode = 'auto';
    fakeRunner = '/usr/bin/sandbox-exec';
    expect(activeSandboxRunner()).toBeNull();
    expect(activeSandboxRunner({ allowSeatbelt: true })).toBe('sandbox-exec');
    const shell = wrapCommand(['ls'], { workspaceRoot: pkg });
    expect(shell).toMatchObject({ wrapped: false, runner: null, argv: ['ls'] });
    const server = wrapCommand(['node', 'server.mjs'], { workspaceRoot: pkg, workspaceReadOnly: true, allowSeatbelt: true });
    try {
      expect(server.wrapped).toBe(true);
      expect(server.runner).toBe('sandbox-exec');
      expect(server.argv[0]).toBe('/usr/bin/sandbox-exec');
    } finally {
      server.cleanup();
    }
  });

  test('required: the shell tool is wrapped too (it would otherwise refuse to run)', () => {
    fakeRunner = '/usr/bin/sandbox-exec';
    const shell = wrapCommand(['ls'], { workspaceRoot: pkg });
    try {
      expect(shell.wrapped).toBe(true);
      expect(shell.runner).toBe('sandbox-exec');
    } finally {
      shell.cleanup();
    }
  });

  test('argv: sandbox-exec -p <profile> /usr/bin/env <vars> <command>', () => {
    fakeRunner = '/usr/bin/sandbox-exec';
    const out = wrapCommand(['node', 'server.mjs'], { workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data], loopbackPorts: [43123], path: '/usr/bin:/bin' });
    try {
      expect(out.wrapped).toBe(true);
      expect(out.runner).toBe('sandbox-exec');
      expect(out.argv.slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
      const profile = out.argv[2];
      expect(profile.startsWith('(version 1)\n(deny default)\n')).toBe(true);
      expect(networkRules(profile)).toEqual(['(allow network-outbound (remote ip "localhost:43123"))']);
      expect(rules(profile).at(-1)).toBe(`(deny file-write* (subpath "${pkg}"))`);
      expect(out.argv[3]).toBe('/usr/bin/env');
      const vars = out.argv.slice(4, -2);
      expect(vars.every((v) => /^[A-Z_]+=/.test(v))).toBe(true);
      expect(vars.find((v) => v.startsWith('PATH='))).toMatch(/^PATH=\/usr\/bin:\/bin/);
      // TMPDIR is the per-spawn scratch, which the profile makes writable.
      const tmp = vars.find((v) => v.startsWith('TMPDIR='))!.slice('TMPDIR='.length).replace(/\/$/, '');
      expect(profile).toContain(`(subpath "${tmp}")`);
      expect(out.argv.slice(-2)).toEqual(['node', 'server.mjs']);
    } finally {
      out.cleanup();
    }
  });

  test('bwrap/firejail-only flags never appear; no network unless asked', () => {
    fakeRunner = '/usr/bin/sandbox-exec';
    const out = wrapCommand(['ls'], { workspaceRoot: pkg });
    try {
      expect(out.argv.some((a) => a.startsWith('--'))).toBe(false);
      expect(networkRules(out.argv[2])).toEqual([]);
    } finally {
      out.cleanup();
    }
  });

  test('on Linux, sandbox-exec is never picked even if a file by that name exists', () => {
    setPlatform('linux');
    _resetSandboxDetectionForTests();
    fakeRunner = '/usr/bin/sandbox-exec';
    expect(detectRunner({ allowSeatbelt: true })).toBeNull();
  });
});
