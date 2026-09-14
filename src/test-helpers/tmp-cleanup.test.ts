import { afterEach, expect, inject, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import setup, { createTestTmpRoot } from './tmp-cleanup';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'cleanup-fixture-')); owned.push(path); return path;
}

test('worker setup routes tmpdir and subprocess scratch into the injected root', async () => {
  expect(tmpdir()).toBe(inject('testTmpRoot'));
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").tmpdir())'], { encoding: 'utf8' });
  expect(output).toBe(inject('testTmpRoot'));
});

test('overlapping run teardowns preserve other runs and live or old server scratch', () => {
  const parent = fixture();
  const live = mkdtempSync(join(parent, 'octipus-server-'));
  const old = mkdtempSync(join(parent, 'octipus-abandoned-'));
  utimesSync(old, new Date(0), new Date(0));
  const first = createTestTmpRoot(parent);
  const second = createTestTmpRoot(parent);
  expect(first.root).not.toBe(second.root);
  writeFileSync(join(second.root, 'database'), 'active');
  first.cleanup();
  expect(existsSync(first.root)).toBe(false);
  expect(readFileSync(join(second.root, 'database'), 'utf8')).toBe('active');
  first.cleanup(); // repeated teardown cannot claim another run's files
  writeFileSync(join(second.root, 'database'), 'still active');
  second.cleanup();
  expect(existsSync(second.root)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(old)).toBe(true);
});

test('global setup publishes only its owned root and removes it at teardown', () => {
  let provided: string | undefined;
  const cleanup = setup({ provide: (key, value) => { expect(key).toBe('testTmpRoot'); provided = value; } });
  expect(existsSync(provided!)).toBe(true);
  cleanup();
  expect(existsSync(provided!)).toBe(false);
});


test('one parallel worker can finish and clean up while another still uses its database', async () => {
  const parent = fixture();
  const runs = [createTestTmpRoot(parent), createTestTmpRoot(parent)];
  const children = runs.map(run => spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'octipus-db-'));
    const file = path.join(root, 'database'); fs.writeFileSync(file, 'active');
    process.stdout.write('ready');
    process.stdin.once('data', () => {
      if (fs.readFileSync(file, 'utf8') !== 'active') process.exit(1);
      process.exit(0);
    });
  `], { env: { ...process.env, TMPDIR: run.root, TMP: run.root, TEMP: run.root } }));
  try {
    await Promise.all(children.map(child => once(child.stdout, 'data')));
    const firstDone = once(children[0], 'exit');
    children[0].stdin.end('finish');
    expect((await firstDone)[0]).toBe(0);
    runs[0].cleanup();
    const secondDone = once(children[1], 'exit');
    children[1].stdin.end('finish');
    expect((await secondDone)[0]).toBe(0);
    runs[1].cleanup();
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
});
