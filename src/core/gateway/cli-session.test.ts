/**
 * The stored terminal login. Isolated to a temp HOME because the module
 * resolves ~/.octipus at import time — a test that skipped this would read and
 * delete the developer's own session file.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let home: string;
let mod: typeof import('./cli-session');
const realHome = process.env.HOME;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'octipus-session-'));
  process.env.HOME = home;
  mod = await import('./cli-session');
});
afterAll(() => { process.env.HOME = realHome; });

const session = {
  token: 'sess_abc', userId: '11111111-1111-4111-8111-111111111111',
  username: 'patrice', isAdmin: true,
};

/**
 * The file must not be group- or world-readable: it holds a bearer token.
 *
 * Windows has no POSIX mode bits — `chmod` there only toggles the read-only
 * flag and `stat().mode` always reads 0o666 — so the assertion would be a
 * guaranteed failure rather than a check. The protection on that platform is
 * the ACL on `%USERPROFILE%`, which the process cannot tighten further, so
 * what is verified there is that the file was written where that ACL applies.
 */
function expectUserOnly(path: string): void {
  if (process.platform === 'win32') {
    expect(path.startsWith(homedir())).toBe(true);
    return;
  }
  expect(statSync(path).mode & 0o077).toBe(0);
}

describe('cli session', () => {
  test('absent until written', () => {
    expect(mod.readCliSession()).toBeNull();
  });

  test('round-trips and is written user-only (it is a bearer token)', () => {
    mod.writeCliSession(session);
    expect(mod.readCliSession()).toMatchObject(session);
    expectUserOnly(mod.CLI_SESSION_PATH);
  });

  test('an expired session reads as absent instead of being sent to the gateway', () => {
    mod.writeCliSession({ ...session, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(mod.readCliSession()).toBeNull();
    mod.writeCliSession({ ...session, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(mod.readCliSession()?.username).toBe('patrice');
  });

  test('a truncated or half-written file reads as absent, never as a partial identity', () => {
    mod.writeCliSession({ ...session, token: '' } as never);
    expect(mod.readCliSession()).toBeNull();
    expect(readFileSync(mod.CLI_SESSION_PATH, 'utf-8')).toContain('"username"');
  });

  test('re-login over a loosened file restores 0600', () => {
    mod.writeCliSession(session);
    chmodSync(mod.CLI_SESSION_PATH, 0o644);
    mod.writeCliSession({ ...session, token: 'sess_new' });
    expectUserOnly(mod.CLI_SESSION_PATH);
  });

  test('clear removes it and is safe to repeat', () => {
    mod.writeCliSession(session);
    mod.clearCliSession();
    mod.clearCliSession();
    expect(mod.readCliSession()).toBeNull();
  });
});
