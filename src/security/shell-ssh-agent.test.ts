import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '@/config';
import { shellSshAgent } from './shell-ssh-agent';
import { LocalShellOperations } from '@/tools/shell/local-operations';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe.skipIf(process.platform === 'win32')('SSH agent forwarding', () => {
  let root: string;
  let server: Server;
  const received: string[] = [];
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'octi-ssh-'));
    vi.mocked(homedir).mockReturnValue(root);
    const socket = join(root, 'agent.sock');
    received.length = 0;
    server = createServer(connection => { connection.on('data', data => { received.push(data.toString()); connection.end('agent-ok'); }); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    vi.stubEnv('SSH_AUTH_SOCK', socket);
    getConfig().security.shellSshAgent = false;
  });
  afterEach(async () => {
    getConfig().security.shellSshAgent = false;
    getConfig().security.shellSandbox = 'off';
    vi.unstubAllEnvs();
    vi.mocked(homedir).mockImplementation(() => require('node:os').userInfo().homedir);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  test('opt-in and server authorization are both required; private keys are never selected', () => {
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh', 'known_hosts'), 'example.test ssh-ed25519 public-host-key');
    writeFileSync(join(root, '.ssh', 'id_ed25519'), 'TEST-PRIVATE-KEY-MUST-STAY-HIDDEN');
    expect(shellSshAgent(false)).toBeUndefined();
    getConfig().security.shellSshAgent = true;
    expect(shellSshAgent(true)).toBeUndefined();
    expect(shellSshAgent(false)).toEqual({ socket: process.env.SSH_AUTH_SOCK, knownHosts: join(root, '.ssh', 'known_hosts') });
  });

  test('a missing or invalid agent produces an actionable error only when enabled', () => {
    getConfig().security.shellSshAgent = true;
    vi.stubEnv('SSH_AUTH_SOCK', 'relative.sock');
    expect(() => shellSshAgent(false)).toThrow(/SSH_AUTH_SOCK.*absolute/);
    vi.stubEnv('SSH_AUTH_SOCK', join(root, 'missing.sock'));
    expect(() => shellSshAgent(false)).toThrow(/SSH_AUTH_SOCK/);
    writeFileSync(join(root, 'regular-file'), 'not a socket');
    vi.stubEnv('SSH_AUTH_SOCK', join(root, 'regular-file'));
    expect(() => shellSshAgent(false)).toThrow(/not a Unix socket/);
    expect(shellSshAgent(true)).toBeUndefined();
  });

  test('space identity removal wins over caller-supplied environment and forwarding configuration', async () => {
    getConfig().security.shellSshAgent = true;
    for (const options of [{ allowHostSshAgent: false }, { allowHostSshAgent: true, unsetEnv: ['SSH_AUTH_SOCK'] }]) {
      const result = await new LocalShellOperations().exec('node -p "Boolean(process.env.SSH_AUTH_SOCK)"', root,
        { ...options, env: { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK! } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('false');
    }
  });

  describe.skipIf(!existsSync('/usr/bin/bwrap'))('live bubblewrap agent forwarding', () => {
    test('a sandbox can use the socket and read known_hosts while private keys stay hidden', async () => {
      getConfig().security.shellSshAgent = true;
      getConfig().security.shellSandbox = 'required';
      const project = join(root, 'project');
      mkdirSync(project);
      mkdirSync(join(root, '.ssh'));
      writeFileSync(join(root, '.ssh', 'known_hosts'), 'PUBLIC-HOST-MARKER');
      writeFileSync(join(root, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-MARKER');
      const probe = `const fs=require('node:fs'); const net=require('node:net'); const assert=require('node:assert/strict');
        assert.equal(fs.existsSync(${JSON.stringify(join(root, '.ssh', 'id_ed25519'))}), false);
        assert.equal(fs.readFileSync(${JSON.stringify(join(root, '.ssh', 'known_hosts'))}, 'utf8'), 'PUBLIC-HOST-MARKER');
        assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(root, '.ssh', 'known_hosts'))}, 'overwrite'));
        const c=net.connect(process.env.SSH_AUTH_SOCK, ()=>c.write('sign-probe'));
        c.on('data', d=>process.argv[2] ? fs.writeFileSync(process.argv[2], d) : process.stdout.write(d)); c.on('error', e=>{console.error(e.message);process.exitCode=1;});`;
      writeFileSync(join(project, 'probe.cjs'), probe);
      const result = await new LocalShellOperations().exec('node probe.cjs', project, { allowHostSshAgent: true, timeout: 5000, env: { SSH_AUTH_SOCK: join(root, '.ssh', 'id_ed25519') } });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe('agent-ok');
      expect(received).toEqual(['sign-probe']);
      let exited!: () => void;
      const backgroundDone = new Promise<void>(resolve => { exited = resolve; });
      await new LocalShellOperations().spawnBackground('node probe.cjs background-marker', project, { allowHostSshAgent: true, onExit: exited });
      await backgroundDone;
      expect(readFileSync(join(project, 'background-marker'), 'utf8')).toBe('agent-ok');
      expect(received).toEqual(['sign-probe', 'sign-probe']);
      const denied = await new LocalShellOperations().exec('node probe.cjs', project, { allowHostSshAgent: false, timeout: 5000 });
      expect(denied.exitCode).not.toBe(0);
      expect(received).toEqual(['sign-probe', 'sign-probe']);
    });
  });
});
