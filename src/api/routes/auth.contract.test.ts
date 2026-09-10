import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';

const mocks = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    username: 'patrice',
    email: 'patrice@example.test',
    passwordHash: 'stored-hash',
    isAdmin: false,
    isActive: true,
    totpEnabled: false,
  },
  findByUsername: vi.fn(),
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
  verifyTotp: vi.fn(),
  clearLoginAttempts: vi.fn(),
}));

vi.mock('@/db/repositories/user-repository', () => ({
  userRepository: {
    findByUsername: mocks.findByUsername,
  },
}));

vi.mock('@/utils/crypto', () => ({
  hashPassword: vi.fn(),
  verifyPassword: mocks.verifyPassword,
}));

vi.mock('@/security/auth/session', () => ({
  getSessionManager: () => ({ create: mocks.createSession, revoke: vi.fn() }),
}));

vi.mock('@/security/auth/totp', () => ({
  getTOTPAuth: () => ({ verify: mocks.verifyTotp }),
}));

vi.mock('@/security/rate-limiter', () => ({
  getRateLimiter: () => ({
    checkLoginAttempts: vi.fn().mockResolvedValue({ allowed: true }),
    clearLoginAttempts: mocks.clearLoginAttempts,
    recordFailedLogin: vi.fn(),
    check: vi.fn().mockResolvedValue({ allowed: true }),
  }),
}));

vi.mock('@/security/auth/passkey', () => ({ getPasskeyAuth: vi.fn() }));
vi.mock('@/channels/linking', () => ({ redeemLinkCode: vi.fn() }));
vi.mock('@/core/briefing', () => ({ ensureDailyBriefingHook: vi.fn() }));

import { authRoutes } from './auth';

const app = new Elysia().use(authRoutes);

async function login(path: '/auth/login' | '/auth/login-mobile', body: Record<string, unknown>) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'contract-test' },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

describe('authentication login contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.totpEnabled = false;
    mocks.findByUsername.mockResolvedValue(mocks.user);
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue({
      token: 'session-secret',
      session: { expiresAt: new Date('2026-09-11T12:00:00.000Z') },
    });
    mocks.verifyTotp.mockResolvedValue(true);
  });

  test('web login puts the token only in an HttpOnly cookie', async () => {
    const { response, body } = await login('/auth/login', {
      username: 'patrice',
      password: 'correct-password',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('session_token=session-secret');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(body).not.toHaveProperty('token');
    expect(body.expiresAt).toBe('2026-09-11T12:00:00.000Z');
  });

  test('mobile login returns a bearer token and expiry without setting a cookie', async () => {
    const { response, body } = await login('/auth/login-mobile', {
      username: 'patrice',
      password: 'correct-password',
      deviceName: 'MCP bridge',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(body.token).toBe('session-secret');
    expect(body.expiresAt).toBe('2026-09-11T12:00:00.000Z');
    expect(mocks.createSession).toHaveBeenCalledWith('user-1', expect.objectContaining({
      userAgent: 'Mobile: MCP bridge',
    }));
  });

  test.each(['/auth/login', '/auth/login-mobile'] as const)(
    '%s rejects a TOTP-enabled account before creating a session',
    async (path) => {
      mocks.user.totpEnabled = true;

      const { response, body } = await login(path, {
        username: 'patrice',
        password: 'correct-password',
      });

      expect(response.status).toBe(401);
      expect(body).toEqual({ error: 'TOTP code required', requiresTOTP: true });
      expect(mocks.createSession).not.toHaveBeenCalled();
    },
  );
});
