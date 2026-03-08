import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { userRepository } from '@/db/repositories/user-repository';
import { getSessionManager } from '@/security/auth/session';
import { getPasskeyAuth } from '@/security/auth/passkey';
import { getTOTPAuth } from '@/security/auth/totp';
import { redeemLinkCode } from '@/channels/linking';
import { verifyPassword, hashPassword } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';
import { getRateLimiter } from '@/security/rate-limiter';

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(apiContext)
  // Login with username/password
  .post(
    '/login',
    async ({ body, request, set }) => {
      const { username, password, totpCode } = body;
      const rateLimiter = getRateLimiter();

      // Check account lockout before anything else
      const lockoutCheck = await rateLimiter.checkLoginAttempts(username);
      if (!lockoutCheck.allowed) {
        set.status = 423;
        return {
          error: 'Account temporarily locked due to too many failed login attempts.',
          retryAfter: lockoutCheck.retryAfter,
        };
      }

      const user = await userRepository.findByUsername(username);
      if (!user || !user.passwordHash) {
        // Record failed attempt even for non-existent users to prevent enumeration timing attacks
        await rateLimiter.recordFailedLogin(username);
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      if (!user.isActive) {
        set.status = 401;
        return { error: 'Account is disabled' };
      }

      const validPassword = await verifyPassword(password, user.passwordHash);
      if (!validPassword) {
        await rateLimiter.recordFailedLogin(username);
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      // Check TOTP if enabled
      if (user.totpEnabled) {
        if (!totpCode) {
          set.status = 401;
          return { error: 'TOTP code required', requiresTOTP: true };
        }

        const totpAuth = getTOTPAuth();
        const validTOTP = await totpAuth.verify(user.id, totpCode);
        if (!validTOTP) {
          await rateLimiter.recordFailedLogin(username);
          set.status = 401;
          return { error: 'Invalid TOTP code' };
        }
      }

      // Successful login — clear failed attempts
      await rateLimiter.clearLoginAttempts(username);

      const sessionManager = getSessionManager();
      const ipAddress = request.headers.get('x-forwarded-for') || undefined;
      const userAgent = request.headers.get('user-agent') || undefined;

      const { token, session } = await sessionManager.create(user.id, {
        ipAddress,
        userAgent,
      });

      set.headers['Set-Cookie'] = `session_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
        },
        expiresAt: session.expiresAt,
      };
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
        totpCode: t.Optional(t.String()),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // Logout
  .post(
    '/logout',
    async ({ request, set }) => {
      const authHeader = request.headers.get('authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        // Try cookie-based token
        const cookieHeader = request.headers.get('cookie') || '';
        const cookieToken = cookieHeader.match(/session_token=([^;]+)/)?.[1];
        if (cookieToken) {
          const sessionManager = getSessionManager();
          await sessionManager.revoke(cookieToken);
        }
        set.headers['Set-Cookie'] = 'session_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
        return { success: true };
      }

      const token = authHeader.substring(7);
      const sessionManager = getSessionManager();
      await sessionManager.revoke(token);

      set.headers['Set-Cookie'] = 'session_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';

      return { success: true };
    },
    { detail: { tags: ['auth'] } }
  )

  // Get current user
  .get(
    '/me',
    async ({ user, session, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      // MASTER_KEY system user — not in DB
      if (user.id === 'system') {
        return {
          id: 'system',
          username: 'system',
          email: null,
          isAdmin: true,
          totpEnabled: false,
          preferences: {},
          channelBindings: [],
          createdAt: new Date().toISOString(),
        };
      }

      const fullUser = await userRepository.findById(user.id);
      if (!fullUser) {
        return { error: 'User not found' };
      }

      return {
        id: fullUser.id,
        username: fullUser.username,
        email: fullUser.email,
        isAdmin: fullUser.isAdmin,
        totpEnabled: fullUser.totpEnabled,
        preferences: fullUser.preferences,
        channelBindings: fullUser.channelBindings || [],
        createdAt: fullUser.createdAt,
      };
    },
    { detail: { tags: ['auth'] } }
  )

  // Register new user
  .post(
    '/register',
    async ({ body, request, set }) => {
      const { username, email, password } = body;

      // Rate-limit registration attempts by IP
      const rateLimiter = getRateLimiter();
      const ip = request.headers.get('x-forwarded-for') || 'unknown';
      const regCheck = await rateLimiter.check(`register:${ip}`, 5, 300000); // 5 attempts per 5 min
      if (!regCheck.allowed) {
        set.status = 429;
        return { error: 'Too many registration attempts. Try again later.' };
      }

      // Enforce password complexity
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
      if (!passwordRegex.test(password)) {
        set.status = 400;
        return { error: 'Password must contain at least one uppercase letter, one lowercase letter, and one digit' };
      }

      // Check if username exists
      const existing = await userRepository.findByUsername(username);
      if (existing) {
        set.status = 409;
        return { error: 'Username already exists' };
      }

      if (email) {
        const existingEmail = await userRepository.findByEmail(email);
        if (existingEmail) {
          set.status = 409;
          return { error: 'Email already exists' };
        }
      }

      // First user becomes admin automatically
      const allUsers = await userRepository.listAll();
      const isFirstUser = allUsers.length === 0;

      const passwordHash = await hashPassword(password);

      const user = await userRepository.create({
        username,
        email,
        passwordHash,
        isAdmin: isFirstUser,
      });

      if (isFirstUser) {
        apiLogger.info({ username }, 'First user registered — granted admin privileges');
      }

      // Auto-login after registration
      const sessionManager = getSessionManager();
      const ipAddress = request.headers.get('x-forwarded-for') || undefined;
      const userAgent = request.headers.get('user-agent') || undefined;

      const { token, session } = await sessionManager.create(user.id, {
        ipAddress,
        userAgent,
      });

      set.headers['Set-Cookie'] = `session_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        token,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
        },
        expiresAt: session.expiresAt,
      };
    },
    {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 50 }),
        email: t.Optional(t.String({ format: 'email' })),
        password: t.String({ minLength: 8 }),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // Passkey registration options
  .post(
    '/passkey/register/options',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const passkeyAuth = getPasskeyAuth();
      const { options } = await passkeyAuth.generateRegistrationOptions(user.id, user.username);

      return options;
    },
    { detail: { tags: ['auth'] } }
  )

  // Passkey registration verification
  .post(
    '/passkey/register/verify',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const passkeyAuth = getPasskeyAuth();
      const verification = await passkeyAuth.verifyRegistration(user.id, body.response, body.deviceName);

      return { verified: verification.verified };
    },
    {
      body: t.Object({
        response: t.Any(),
        deviceName: t.Optional(t.String()),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // Passkey authentication options
  .post(
    '/passkey/auth/options',
    async ({ body }) => {
      const passkeyAuth = getPasskeyAuth();
      const { options } = await passkeyAuth.generateAuthenticationOptions(body.userId);

      return options;
    },
    {
      body: t.Object({
        userId: t.Optional(t.String()),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // Passkey authentication verification
  .post(
    '/passkey/auth/verify',
    async ({ body, request, set }) => {
      // Rate-limit passkey auth attempts by IP
      const rateLimiter = getRateLimiter();
      const ip = request.headers.get('x-forwarded-for') || 'unknown';
      const passkeyCheck = await rateLimiter.check(`passkey:${ip}`, 10, 300000); // 10 attempts per 5 min
      if (!passkeyCheck.allowed) {
        set.status = 429;
        return { error: 'Too many authentication attempts. Try again later.' };
      }

      const passkeyAuth = getPasskeyAuth();
      const ipAddress = request.headers.get('x-forwarded-for') || undefined;

      const verification = await passkeyAuth.verifyAuthentication(body.userId, body.response, ipAddress);

      if (!verification.verified) {
        return { error: 'Authentication failed' };
      }

      const sessionManager = getSessionManager();
      const { token, session } = await sessionManager.create(body.userId, {
        ipAddress,
        userAgent: request.headers.get('user-agent') || undefined,
      });

      const user = await userRepository.findById(body.userId);

      set.headers['Set-Cookie'] = `session_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;

      return {
        token,
        user: {
          id: user!.id,
          username: user!.username,
          isAdmin: user!.isAdmin,
        },
        expiresAt: session.expiresAt,
      };
    },
    {
      body: t.Object({
        userId: t.String(),
        response: t.Any(),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // Link channel account via code
  .post(
    '/link',
    async ({ user, body, request, set }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      // Rate-limit link code attempts
      const rateLimiter = getRateLimiter();
      const linkCheck = await rateLimiter.check(`link:${user.id}`, 10, 300000); // 10 attempts per 5 min
      if (!linkCheck.allowed) {
        set.status = 429;
        return { error: 'Too many link attempts. Try again later.' };
      }

      const result = await redeemLinkCode(body.code, user.id);

      if (!result.success) {
        return { error: result.error };
      }

      return { success: true };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 6, maxLength: 6 }),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // TOTP setup
  .post(
    '/totp/setup',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const totpAuth = getTOTPAuth();
      const { secret, qrCodeUrl, backupCodes } = await totpAuth.generateSecret(user.id);

      return { qrCodeUrl, backupCodes };
    },
    { detail: { tags: ['auth'] } }
  )

  // TOTP enable
  .post(
    '/totp/enable',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const totpAuth = getTOTPAuth();
      const success = await totpAuth.enable(user.id, body.code);

      return { success };
    },
    {
      body: t.Object({
        code: t.String(),
      }),
      detail: { tags: ['auth'] },
    }
  )

  // TOTP disable
  .post(
    '/totp/disable',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const totpAuth = getTOTPAuth();
      const success = await totpAuth.disable(user.id, body.code);

      return { success };
    },
    {
      body: t.Object({
        code: t.String(),
      }),
      detail: { tags: ['auth'] },
    }
  );
