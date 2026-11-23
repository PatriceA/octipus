import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createManagedTemporaryDirectory, sweepTemporaryDirectories } from './temporary-directory';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('allocates private roots and removes all test-created descendants idempotently', () => {
  const first = createManagedTemporaryDirectory();
  const second = createManagedTemporaryDirectory();
  dirs.push(dirname(first.dir), dirname(second.dir));
  expect(first.dir).not.toBe(second.dir);
  expect(first.env).toEqual({ TMPDIR: first.dir, TEMP: first.dir, TMP: first.dir });
  mkdirSync(join(first.dir, 'ctx-wiring-leak'));
  writeFileSync(join(first.dir, 'ctx-wiring-leak', 'database'), 'fixture');
  first.dispose(); first.dispose();
  expect(existsSync(dirname(first.dir))).toBe(false);
  expect(existsSync(second.dir)).toBe(true);
  second.dispose();
});

test('does not sweep a live owner or a released directory with a live child', () => {
  const temp = createManagedTemporaryDirectory();
  dirs.push(dirname(temp.dir));
  const base = dirname(dirname(temp.dir));
  sweepTemporaryDirectories(base);
  expect(existsSync(temp.dir)).toBe(true);
  temp.attach(process.pid);
  temp.dispose();
  sweepTemporaryDirectories(base);
  expect(existsSync(temp.dir)).toBe(true);
});

test('reaps proven orphaned work but retains incomplete and foreign entries', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit');
  expect(child.pid).toBeDefined();
  const temp = createManagedTemporaryDirectory();
  const unknown = createManagedTemporaryDirectory();
  dirs.push(dirname(temp.dir), dirname(unknown.dir));
  const marker = join(dirname(temp.dir), 'owner.json');
  const data = JSON.parse(readFileSync(marker, 'utf8'));
  data.ownerPid = child.pid; data.childPid = child.pid;
  writeFileSync(marker, JSON.stringify(data));
  const unknownMarker = join(dirname(unknown.dir), 'owner.json');
  const unconfirmed = JSON.parse(readFileSync(unknownMarker, 'utf8'));
  unconfirmed.ownerPid = child.pid;
  writeFileSync(unknownMarker, JSON.stringify(unconfirmed));
  const base = dirname(dirname(temp.dir));
  const foreign = join(base, 'run-foreign');
  mkdirSync(foreign); writeFileSync(join(foreign, 'keep'), 'not owned'); dirs.push(foreign);
  expect(sweepTemporaryDirectories(base)).toBeGreaterThanOrEqual(1);
  expect(existsSync(temp.dir)).toBe(false);
  expect(existsSync(unknown.dir)).toBe(true);
  expect(existsSync(join(foreign, 'keep'))).toBe(true);
});

test.skipIf(process.platform === 'win32')('does not follow symlinks in scratch or sweep a symlinked root', () => {
  const outside = mkdtempSync(join(tmpdir(), 'temp-outside-')); dirs.push(outside);
  writeFileSync(join(outside, 'keep'), 'project data');
  const temp = createManagedTemporaryDirectory();
  symlinkSync(outside, join(temp.dir, 'project'));
  temp.dispose();
  expect(existsSync(join(outside, 'keep'))).toBe(true);
  const base = dirname(dirname(temp.dir));
  const link = join(base, 'run-linked'); dirs.push(link);
  symlinkSync(outside, link);
  sweepTemporaryDirectories(base);
  expect(existsSync(join(outside, 'keep'))).toBe(true);
});

test('a missing child PID is not fabricated into ownership', () => {
  const temp = createManagedTemporaryDirectory();
  dirs.push(dirname(temp.dir));
  temp.attach(undefined);
  const marker = JSON.parse(readFileSync(join(dirname(temp.dir), 'owner.json'), 'utf8'));
  expect(marker.childPid).toBeUndefined();
  temp.dispose();
  expect(existsSync(temp.dir)).toBe(false);
});

test.skipIf(process.platform === 'win32')('orphan sweeps retain live native descendants after the root process exits', async () => {
  const temp = createManagedTemporaryDirectory(); dirs.push(dirname(temp.dir));
  const parent = spawn(process.execPath, ['-e', 'const {spawn}=require("node:child_process");const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(p.pid);p.unref();'], { detached: true, stdio: ['ignore','pipe','ignore'] });
  temp.attach(parent.pid, true);
  let output=''; parent.stdout.on('data', data=>{ output+=data; });
  let childPid: number | undefined;
  try {
    await once(parent,'close');
    childPid=Number(output.trim());
    expect(Number.isSafeInteger(childPid) && childPid>1).toBe(true);
    const marker=join(dirname(temp.dir),'owner.json');
    const owner=JSON.parse(readFileSync(marker,'utf8'));
    owner.ownerPid=parent.pid; // Emulate the owning backend having disappeared.
    writeFileSync(marker,JSON.stringify(owner));
    sweepTemporaryDirectories(dirname(dirname(temp.dir)));
    expect(existsSync(temp.dir)).toBe(true);
    process.kill(childPid,'SIGTERM');
    await vi.waitFor(()=>{
      sweepTemporaryDirectories(dirname(dirname(temp.dir)));
      expect(existsSync(temp.dir)).toBe(false);
    },{timeout:5000});
  } finally {
    try { if(parent.pid)process.kill(-parent.pid,'SIGKILL'); } catch { /* fixture group already exited */ }
  }
});
