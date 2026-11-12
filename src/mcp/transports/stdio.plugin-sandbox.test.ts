/**
 * A plugin package's server and its sandbox (docs/PLUGIN-PACKAGES.md#the-sandbox).
 *
 * `sandbox.mode` (set from `plugins.sandbox`) decides, never
 * `security.shellSandbox`, which defaults to off: with the old coupling an
 * unwrapped plugin read the server's environment (`/proc/<ppid>/environ`:
 * DATABASE_URL, MASTER_KEY). And a sandboxed server always runs in a
 * session of its own, so it has no controlling terminal.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { getConfig } from '@/config';
import { _resetSandboxDetectionForTests, detectRunner, runnerProblem } from '@/security/shell-sandbox';
import { prepareSandboxedLaunch, StdioTransport } from './stdio';

const root = mkdtempSync(join(tmpdir(), 'plugin-sb-'));
const pkg = join(root, 'pkg');
const data = join(root, 'data');
mkdirSync(pkg, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => _resetSandboxDetectionForTests());

/** Run `script` with this Node binary as a sandboxed server would be, and collect its first stdout line. */
async function runServer(script: string, mode: 'required' | 'off'): Promise<string> {
  const t = new StdioTransport({
    command: process.execPath, args: ['-e', script], isolatedEnv: true, cwd: pkg,
    sandbox: { mode, root: pkg, readOnlyRoot: true, writable: [data], allowNetwork: false },
  });
  const lines: string[] = [];
  t.onMessage((m) => lines.push(m));
  await t.connect();
  const deadline = Date.now() + 15_000;
  while (lines.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await t.closeAndWait(1000);
  return lines[0] ?? '';
}

describe('the mode of a plugin server, not security.shellSandbox', () => {
  test('mode off launches it unwrapped, whatever security.shellSandbox says', async () => {
    const previous = getConfig().security.shellSandbox;
    getConfig().security.shellSandbox = 'auto';
    try {
      const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], { PATH: '/usr/bin' }, { mode: 'off', root: pkg, allowNetwork: false });
      expect(launch.argv).toEqual(['node', 'server.mjs']);
      expect(launch.networkEnforced).toBe(false);
      launch.cleanup();
    } finally {
      getConfig().security.shellSandbox = previous;
    }
  });

  test('a sandboxed server leads a session of its own: no controlling terminal', async () => {
    // /proc/self/stat: "pid (comm) state ppid pgrp session ..."
    const script = "const s=require('fs').readFileSync('/proc/self/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).split(' ');console.log(JSON.stringify({pid:process.pid,sid:Number(f[3])}))";
    const out = JSON.parse(await runServer(script, 'off')) as { pid: number; sid: number };
    expect(out.sid).toBe(out.pid);
  });
});

const detected = detectRunner();
const bwrapWorks = process.platform === 'linux' && detected?.runner === 'bwrap' && runnerProblem(detected) === null;
/** A variable of this test process's own start environment, which an unsandboxed child could read from /proc/<ppid>/environ. */
const marker = (() => {
  try {
    return readFileSync('/proc/self/environ', 'latin1').split('\0').map((l) => l.split('=')[0]).find((k) => k.startsWith('VITEST')) ?? null;
  } catch {
    return null;
  }
})();

describe.skipIf(!bwrapWorks || !marker)('mode required wraps it, with security.shellSandbox off (the default)', () => {
  test('the server cannot read the server process\'s environment through /proc', async () => {
    expect(getConfig().security.shellSandbox).toBe('off');
    const script = `const fs=require('fs');let found=[];
      for (const p of ['/proc/'+process.ppid+'/environ', ...fs.readdirSync('/proc').filter(d=>/^\\d+$/.test(d)).map(d=>'/proc/'+d+'/environ')]) {
        try { if (fs.readFileSync(p,'latin1').includes(${JSON.stringify(`${marker}=`)})) found.push(p); } catch {}
      }
      console.log(JSON.stringify({found}))`;
    const out = JSON.parse(await runServer(script, 'required')) as { found: string[] };
    expect(out.found).toEqual([]);
  });
});
