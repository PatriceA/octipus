import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { LocalShellOperations } from './local-operations';

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

function script(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'temp-cmd-test-')); dirs.push(dir);
  const path = join(dir, 'command.cjs'); writeFileSync(path, source);
  return { dir, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}` };
}

test.each([0, 7])('host commands clean inherited temp files after exit %s while project files survive', async exit => {
  const fixture = script(`const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const root=os.tmpdir();const db=fs.mkdtempSync(path.join(root,'ctx-wiring-'));fs.writeFileSync(path.join(db,'data'),'database');
    fs.writeFileSync('project-output','keep');console.log(root);process.exit(${exit});`);
  const result = await new LocalShellOperations().exec(fixture.command, fixture.dir, { timeout: 5000, sandboxMode: 'off' });
  expect(result.exitCode).toBe(exit);
  const temp = result.stdout.trim();
  expect(temp).toContain('octipus-owned-temp-');
  expect(existsSync(dirname(temp))).toBe(false);
  expect(readFileSync(join(fixture.dir, 'project-output'), 'utf8')).toBe('keep');
});

test('timeout waits for process exit and removes temporary data', async () => {
  const fixture = script('console.log(require("node:os").tmpdir());setInterval(()=>{},1000);');
  const result = await new LocalShellOperations().exec(fixture.command, fixture.dir, { timeout: 1500, sandboxMode: 'off' });
  expect(result.timedOut).toBe(true);
  expect(result.stdout.trim()).toContain('octipus-owned-temp-');
  expect(existsSync(result.stdout.trim())).toBe(false);
});

test('explicit cancellation removes the private directory after the child closes', async () => {
  const fixture = script('console.log(require("node:os").tmpdir());setInterval(()=>{},1000);');
  const controller = new AbortController();
  const result = await new LocalShellOperations().exec(fixture.command, fixture.dir, { timeout: 5000, sandboxMode: 'off', signal: controller.signal,
    onData: () => controller.abort() });
  expect(result.aborted).toBe(true);
  expect(existsSync(result.stdout.trim())).toBe(false);
});

test('background jobs keep their scratch until they exit', async () => {
  const fixture = script('require("node:fs").writeFileSync("ready",require("node:os").tmpdir());setInterval(()=>{},1000);');
  let ended!: () => void;
  const done = new Promise<void>(resolve => { ended = resolve; });
  const onExit = vi.fn(ended);
  const result = await new LocalShellOperations().spawnBackground(fixture.command, fixture.dir, { sandboxMode: 'off', onExit });
  try {
    await vi.waitFor(() => expect(existsSync(join(fixture.dir, 'ready'))).toBe(true));
    const temp = readFileSync(join(fixture.dir, 'ready'), 'utf8');
    expect(existsSync(temp)).toBe(true);
    process.kill(result.pid!, 'SIGTERM');
    await done;
    expect(existsSync(temp)).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
  } finally { try { if (result.pid) process.kill(result.pid, 'SIGKILL'); } catch { /* test child already exited */ } }
});
