/**
 * `octi start` installs a package's locked dependencies when its lockfile
 * changed since the last install (scripts/needs-install.mjs): a pull that
 * added a dependency otherwise left the new build unable to boot, and the
 * supervisor served the previous one.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
// @ts-expect-error: a plain .mjs script, no declarations
import { needsInstall } from './needs-install.mjs';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pkg(): string {
  dir = mkdtempSync(join(tmpdir(), 'octipus-needs-install-'));
  return dir;
}

/** Write `path` with its modification time `secondsAgo` in the past. */
function file(path: string, secondsAgo: number): void {
  writeFileSync(path, '{}');
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, at, at);
}

describe('needs-install', () => {
  test('never installed: install', () => {
    const d = pkg();
    file(join(d, 'package-lock.json'), 10);
    expect(needsInstall(d)).toBe(true);
  });

  test('the lockfile changed since the last install (a pull added a dependency): install', () => {
    const d = pkg();
    mkdirSync(join(d, 'node_modules'));
    file(join(d, 'node_modules', '.package-lock.json'), 100);
    file(join(d, 'package-lock.json'), 10);
    expect(needsInstall(d)).toBe(true);
  });

  test('installed after the lockfile last changed: nothing to do', () => {
    const d = pkg();
    mkdirSync(join(d, 'node_modules'));
    file(join(d, 'package-lock.json'), 100);
    file(join(d, 'node_modules', '.package-lock.json'), 10);
    expect(needsInstall(d)).toBe(false);
  });

  test('no lockfile: nothing to install from', () => {
    expect(needsInstall(pkg())).toBe(false);
  });
});
