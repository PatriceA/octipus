import { describe, expect, test } from 'bun:test';
import {
  ANONYMOUS_PRINCIPAL,
  canActOnUser,
  isAdmin,
  isAuthenticated,
  principalFromUser,
  SYSTEM_PRINCIPAL,
} from './principal';

describe('Principal', () => {
  test('principalFromUser preserves identity and admin flag', () => {
    const p = principalFromUser({ id: 'u1', username: 'alice', isAdmin: false }, 'tok-123');
    expect(p.kind).toBe('user');
    expect(p.userId).toBe('u1');
    expect(p.username).toBe('alice');
    expect(p.isAdmin).toBe(false);
    expect(p.sessionToken).toBe('tok-123');
    expect(p.roles).toEqual(['user']);
  });

  test('admin user gets system_admin role', () => {
    const p = principalFromUser({ id: 'u1', username: 'root', isAdmin: true });
    expect(p.isAdmin).toBe(true);
    expect(p.roles).toContain('system_admin');
  });

  test('SYSTEM_PRINCIPAL is admin and frozen', () => {
    expect(SYSTEM_PRINCIPAL.kind).toBe('system');
    expect(SYSTEM_PRINCIPAL.isAdmin).toBe(true);
    expect(Object.isFrozen(SYSTEM_PRINCIPAL)).toBe(true);
  });

  test('ANONYMOUS_PRINCIPAL is unauthenticated and not admin', () => {
    expect(ANONYMOUS_PRINCIPAL.kind).toBe('anonymous');
    expect(ANONYMOUS_PRINCIPAL.isAdmin).toBe(false);
    expect(isAuthenticated(ANONYMOUS_PRINCIPAL)).toBe(false);
  });

  test('isAuthenticated true for user/system, false for anonymous/null', () => {
    expect(isAuthenticated(SYSTEM_PRINCIPAL)).toBe(true);
    expect(isAuthenticated(principalFromUser({ id: 'u', username: 'x', isAdmin: false }))).toBe(true);
    expect(isAuthenticated(ANONYMOUS_PRINCIPAL)).toBe(false);
    expect(isAuthenticated(null)).toBe(false);
    expect(isAuthenticated(undefined)).toBe(false);
  });

  test('isAdmin reflects principal flag', () => {
    expect(isAdmin(principalFromUser({ id: 'u', username: 'x', isAdmin: true }))).toBe(true);
    expect(isAdmin(principalFromUser({ id: 'u', username: 'x', isAdmin: false }))).toBe(false);
    expect(isAdmin(ANONYMOUS_PRINCIPAL)).toBe(false);
  });

  test('canActOnUser: same user yes, admin yes, other user no, anonymous no', () => {
    const alice = principalFromUser({ id: 'alice', username: 'alice', isAdmin: false });
    const bob = principalFromUser({ id: 'bob', username: 'bob', isAdmin: false });
    const root = principalFromUser({ id: 'root', username: 'root', isAdmin: true });
    expect(canActOnUser(alice, 'alice')).toBe(true);
    expect(canActOnUser(alice, 'bob')).toBe(false);
    expect(canActOnUser(root, 'alice')).toBe(true);
    expect(canActOnUser(ANONYMOUS_PRINCIPAL, 'alice')).toBe(false);
  });
});
