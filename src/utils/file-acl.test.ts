/**
 * The one claim `restrictToOwner` makes — nobody but the owner can read it —
 * is checked against the platform's own reporting, because the previous
 * expression of it (`chmod 0600`) silently did nothing on Windows and no test
 * noticed for as long as the suite could not run there.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    // That entry is OWNER RIGHTS — whatever the console code page renders it
    // as — and not an account name resolved out of the environment.
    expect(aces[0]).toMatch(/:\(F\)$/);
    expect(out).not.toMatch(/\bBUILTIN\\|\bNT-AUTORITÄT\\|\bNT AUTHORITY\\/);
    // …and the owner can still use the file it just locked down. Granting to
    // the wrong principal would lock the process out of its own token.
    expect(readFileSync(path, 'utf8')).toBe('bearer-token');
    writeFileSync(path, 'rotated');
    expect(readFileSync(path, 'utf8')).toBe('rotated');
  });

  test.skipIf(process.platform !== 'win32')('Windows: the grantee does not come from the environment', () => {
    const path = secretAt('spoof.json');
    const previous = { user: process.env.USERNAME, domain: process.env.USERDOMAIN };
    process.env.USERNAME = 'Guest';
    process.env.USERDOMAIN = 'ELSEWHERE';
    try {
      expect(restrictToOwner(path)).toBe(true);
      const out = execFileSync('icacls', [path], { encoding: 'utf8' });
      expect(out).not.toMatch(/Guest|ELSEWHERE/i);
      expect(readFileSync(path, 'utf8')).toBe('bearer-token');
    } finally {
      process.env.USERNAME = previous.user;
      process.env.USERDOMAIN = previous.domain;
    }
  });
});
