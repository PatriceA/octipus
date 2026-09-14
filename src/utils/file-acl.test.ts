/**
 * The one claim `restrictToOwner` makes — nobody but the owner can read it —
 * is checked against the platform's own reporting, because the previous
 * expression of it (`chmod 0600`) silently did nothing on Windows and no test
 * noticed for as long as the suite could not run there.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { restrictToOwner } from './file-acl';

const dir = mkdtempSync(join(tmpdir(), 'file-acl-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretAt(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, 'bearer-token');
  return path;
}

describe('restrictToOwner', () => {
  test('reports success on a file it can restrict', () => {
    expect(restrictToOwner(secretAt('ok.json'))).toBe(true);
  });

  test('does not throw on a path that is not there', () => {
    expect(restrictToOwner(join(dir, 'absent.json'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('POSIX: the file is 0600 and the directory 0700', () => {
    const path = secretAt('posix.json');
    restrictToOwner(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    restrictToOwner(dir, 'directory');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test.skipIf(process.platform !== 'win32')('Windows: the ACL names the owner and nobody else', () => {
    const path = secretAt('windows.json');
    expect(restrictToOwner(path)).toBe(true);
    // `icacls <file>` prints one line per ACE. After the call there must be
    // exactly one, for this account — inherited Users/SYSTEM/Administrators
    // entries are what `/inheritance:r` removes, and their survival is the
    // bug this test exists for.
    const out = execFileSync('icacls', [path], { encoding: 'utf8' });
    const aces = out
      .split('\n')
      .slice(0, -2) // trailing "Successfully processed …" summary + blank
      .map((line) => line.replace(path, '').trim())
      .filter(Boolean);
    expect(aces).toHaveLength(1);
    expect(aces[0]).toContain(process.env.USERNAME as string);
    expect(out).not.toMatch(/\bBUILTIN\\|\bNT-AUTORITÄT\\|\bNT AUTHORITY\\/);
  });
});
