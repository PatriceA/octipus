/**
 * The git tool against the egress policy and against option injection, with
 * real git:
 *
 * - an scp-style remote is judged on the host git actually connects to
 *   (checked against what git hands ssh);
 * - no user-supplied value becomes a git option (`--upload-pack=<cmd>` runs
 *   a command on the server), with or without a policy;
 * - under a policy, a URL push is judged after `pushInsteadOf`, repository
 *   configuration that reroutes or runs commands is refused, and hooks do not
 *   run for network actions.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';

const state = vi.hoisted(() => ({ policy: undefined as unknown }));
vi.mock('@/config', async (orig) => {
  const real = await orig<typeof import('@/config')>();
  return {
    ...real,
    getConfig: () => {
      let base: Record<string, any> = {};
      try { base = real.getConfig() as unknown as Record<string, any>; } catch { /* not loaded in this lane */ }
      return { ...base, security: { ...(base.security ?? {}), egressPolicy: state.policy } };
    },
  };
});
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW', source: 'policy' }) }) }));
vi.mock('@/security/approval-route', () => ({ routeApprovalFor: async () => ({ route: 'execute', source: 'policy' }) }));
vi.mock('@/core/action-recovery', async (orig) => ({ ...(await orig<typeof import('@/core/action-recovery')>()), actionRecovery: { run: async (_c: unknown, _t: unknown, _n: unknown, _a: unknown, run: () => Promise<unknown>) => run() } }));

const { gitRemoteTarget } = await import('@/security/git-egress');
const { GitTool } = await import('./index');

let dir: string;
let home: string;
const saved: Record<string, string | undefined> = {};
/** The environment every git here runs in: a private HOME, no system or inherited config. */
const isolate = { HOME: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'octi-git-egress-'));
  home = join(dir, 'home');
  mkdirSync(home);
  isolate.HOME = home;
  for (const [k, v] of Object.entries(isolate)) { saved[k] = process.env[k]; process.env[k] = v; }
  for (const k of Object.keys(process.env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$|^GIT_CONFIG_PARAMETERS$/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { state.policy = egressPolicySchema.parse({}); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A bare origin with one commit on main, and a clone of it. */
function repoPair(name: string): { bare: string; work: string } {
  const bare = join(dir, `${name}.git`);
  const work = join(dir, name);
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dir, 'clone', '-q', bare, work);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  return { bare, work };
}

async function handler(name: string) {
  const tool = new GitTool();
  await tool.initialize();
  return tool.getToolHandlers().find((h) => h.name.endsWith(`__${name}`) || h.name === name)!;
}
const context = { id: 'agent-1', userId: 'u1', sessionId: 's1', role: 'coding', status: 'running' } as never;

describe('scp-style remotes are judged on the host git connects to', () => {
  /** The host and port git hands ssh for `remote` (a recording fake ssh; nothing connects). */
  function sshTarget(remote: string): { host: string; port: number } | null {
    const log = join(dir, `ssh-${Math.random().toString(36).slice(2)}.log`);
    const fake = join(dir, 'fake-ssh');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\necho END >> "${log}"\nexit 1\n`);
    chmodSync(fake, 0o755);
    spawnSync('git', ['ls-remote', '--', remote], { cwd: dir, env: { ...process.env, GIT_SSH: fake, GIT_SSH_VARIANT: 'ssh', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', timeout: 15_000 });
    if (!existsSync(log)) return null;
    const runs = readFileSync(log, 'utf8').split('END\n').map((r) => r.split('\n').filter(Boolean)).filter((r) => r.some((a) => a.startsWith('git-upload-pack')));
    const args = runs.at(-1);
    if (!args) return null;
    const cmd = args.findIndex((a) => a.startsWith('git-upload-pack'));
    const dest = args[cmd - 1];
    const p = args.indexOf('-p');
    return { host: dest.slice(dest.lastIndexOf('@') + 1), port: p >= 0 && p < cmd ? Number(args[p + 1]) : 22 };
  }

  test.each([
    'denied.example:x@allowed.example:repo.git',
    '[denied.example]:x@allowed.example:r',
    'user@allowed.example:repo',
    'a@b@allowed.example:r',
    'allowed.example:22/r',
    '[user@allowed.example:2222]:r',
    'git@[2001:db8::1]:r',
    'ssh://allowed.example@denied.example/r',
    'ssh://u@allowed.example:2200/r',
  ])('%s', (remote) => {
    const ours = gitRemoteTarget(remote);
    const real = sshTarget(remote);
    if (ours === 'unjudgeable') return; // refused: fine whatever git would do
    expect(ours, `git sent ssh to ${JSON.stringify(real)}`).not.toBeNull();
    expect(real).not.toBeNull();
    expect({ host: (ours as { host: string }).host.toLowerCase(), port: (ours as { port: number }).port }).toEqual({ host: real!.host.toLowerCase().replace(/^\[|\]$/g, ''), port: real!.port });
  }, 20_000);

  test('the reviewer vectors are not judged as allowed.example', () => {
    for (const remote of ['denied.example:x@allowed.example:repo.git', '[denied.example]:x@allowed.example:r']) {
      const target = gitRemoteTarget(remote);
      expect(target === 'unjudgeable' || (target as { host: string }).host === 'denied.example', remote).toBe(true);
    }
    // Spellings another parser (curl, ssh) could split differently are refused.
    expect(gitRemoteTarget('https://allowed.example\\@denied.example/r')).toBe('unjudgeable');
    expect(gitRemoteTarget('https://a@b@denied.example/r')).toBe('unjudgeable');
  });
});

describe('no user value becomes a git option (with or without a policy)', () => {
  const PWN = () => join(dir, 'pwned');
  const vector = () => `--upload-pack=touch ${PWN()}; git-upload-pack`;

  test.each([
    ['pull', (work: string, bare: string) => ({ path: work, remote: 'origin', branch: vector(), _bare: bare })],
    ['pull', (work: string) => ({ path: work, remote: vector() })],
    ['push', (work: string) => ({ path: work, remote: 'origin', branch: '--receive-pack=touch ' + PWN() })],
    ['push', (work: string) => ({ path: work, remote: '--receive-pack=touch ' + PWN() })],
    ['clone', (_work: string, bare: string) => ({ url: vector(), path: bare })],
    ['clone', (_work: string, bare: string) => ({ url: bare, path: '--upload-pack=touch ' + PWN() })],
    ['checkout', (work: string) => ({ path: work, target: '--orphan=x' })],
    ['branch', (work: string) => ({ path: work, name: '--help' })],
    ['reset', (work: string) => ({ path: work, mode: 'hard --upload-pack=x', target: 'HEAD' })],
  ])('%s refuses a leading-dash value', async (action, args) => {
    const { bare, work } = repoPair(`inject-${Math.random().toString(36).slice(2)}`);
    rmSync(PWN(), { force: true });
    const run = await handler(action);
    await expect(run.execute(args(work, bare) as Record<string, unknown>, context)).rejects.toThrow(/must not start with "-"|Not a valid|Unknown reset mode/);
    expect(existsSync(PWN())).toBe(false);
  }, 30_000);

  test('ordinary values still work', async () => {
    const { work } = repoPair('ordinary');
    await expect((await handler('pull')).execute({ path: work, remote: 'origin', branch: 'main' }, context)).resolves.toMatchObject({ success: true });
    await expect((await handler('push')).execute({ path: work, remote: 'origin', branch: 'main' }, context)).resolves.toMatchObject({ success: true });
  }, 30_000);
});

describe('under an egress policy', () => {
  test('a push to a URL is judged after pushInsteadOf', async () => {
    const { work } = repoPair('pushinsteadof');
    git(work, 'config', '--global', 'url.https://evil.example/.pushInsteadOf', 'https://allowed.example/');
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'allowed.example' }] });
    try {
      const { withEgressSubject } = await import('@/security/egress-policy');
      const push = await handler('push');
      await expect(withEgressSubject({ tool: 'git' }, () => push.execute({ path: work, remote: 'https://allowed.example/o/r.git', branch: 'main' }, context))).rejects.toThrow(/evil\.example:443 \(https\) is denied/);
    } finally {
      git(work, 'config', '--global', '--unset', 'url.https://evil.example/.pushInsteadOf');
    }
  }, 30_000);

  test('repository config that runs a command or reroutes is refused; it never runs', async () => {
    const { work } = repoPair('rerouting');
    const marker = join(dir, 'uploadpack-ran');
    git(work, 'config', 'remote.origin.uploadpack', `touch ${marker}; git-upload-pack`);
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'deny', host: 'denied.example' }] });
    await expect((await handler('pull')).execute({ path: work, remote: 'origin', branch: 'main' }, context)).rejects.toThrow(/remote\.origin\.uploadpack/);
    expect(existsSync(marker)).toBe(false);
    git(work, 'config', '--unset', 'remote.origin.uploadpack');
    git(work, 'config', 'http.proxy', 'http://attacker.example:8080');
    await expect((await handler('pull')).execute({ path: work, remote: 'origin', branch: 'main' }, context)).rejects.toThrow(/http\.proxy/);
  }, 30_000);

  test('hooks do not run for a push', async () => {
    const { work } = repoPair('hooks');
    const marker = join(dir, 'hook-ran');
    writeFileSync(join(work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(work, '.git', 'hooks', 'pre-push'), 0o755);
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'deny', host: 'denied.example' }] });
    await expect((await handler('push')).execute({ path: work, remote: 'origin', branch: 'main' }, context)).resolves.toMatchObject({ success: true });
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
