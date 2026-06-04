import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { clearSessionCookie, sessionCookie } from '@/api/session-cookie';
import { redeemLinkCode } from '@/channels/linking';
import { userRepository } from '@/db/repositories/user-repository';
import { getPasskeyAuth } from '@/security/auth/passkey';
import { getSessionManager } from '@/security/auth/session';
import { getTOTPAuth } from '@/security/auth/totp';
import { isAuthenticated } from '@/security/principal';
import { getRateLimiter } from '@/security/rate-limiter';
import { hashPassword, verifyPassword } from '@/utils/crypto';
import { apiLogger, securityLogger } from '@/utils/logger';

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(apiContext)
  // Login with username/password
  .post(
    '/login',
    async ({ body, request, set }) => {
      const { username, password, totpCode } = body;
      const rateLimiter = getRateLimiter();
      const clientIp = request.headers.get('x-forwarded-for') || undefined;

      // Check account lockout before anything else
      const lockoutCheck = await rateLimiter.checkLoginAttempts(username);
      if (!lockoutCheck.allowed) {
        securityLogger.warn(
          { username, clientIp, channel: 'web' },
          'Login blocked — account locked out',
        );
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
        securityLogger.warn(
          { username, clientIp, channel: 'web', reason: 'unknown_user' },
          'Login failed',
        );
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      if (!user.isActive) {
        securityLogger.warn(
          { userId: user.id, username, clientIp, channel: 'web', reason: 'account_disabled' },
          'Login failed',
        );
        set.status = 401;
        return { error: 'Account is disabled' };
      }

      const validPassword = await verifyPassword(password, user.passwordHash);
      if (!validPassword) {
        await rateLimiter.recordFailedLogin(username);
        securityLogger.warn(
          { userId: user.id, username, clientIp, channel: 'web', reason: 'bad_password' },
          'Login failed',
        );
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
          securityLogger.warn(
            { userId: user.id, username, clientIp, channel: 'web', reason: 'bad_totp' },
            'Login failed',
          );
          set.status = 401;
          return { error: 'Invalid TOTP code' };
        }
      }

      // Successful login — clear failed attempts
      await rateLimiter.clearLoginAttempts(username);

      const sessionManager = getSessionManager();
      const ipAddress = clientIp;
      const userAgent = request.headers.get('user-agent') || undefined;

      const { token, session } = await sessionManager.create(user.id, {
        ipAddress,
        userAgent,
      });

      set.headers['Set-Cookie'] = sessionCookie(token, request);

      securityLogger.info(
        { userId: user.id, username, clientIp, channel: 'web' },
        'Login successful',
      );

      // Token lives only in the HttpOnly cookie — do not echo it in the
      // response body where same-origin scripts could read it.
      return {
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

  // Mobile / API client login — same credentials as /login, but returns the
  // bearer token in the body instead of an HttpOnly cookie. Cookie clients
  // (the web UI) should keep using /login; native clients can't read the
  // HttpOnly cookie and need the token directly.
  .post(
    '/login-mobile',
    async ({ body, request, set }) => {
      const { username, password, totpCode, deviceName } = body;
      const rateLimiter = getRateLimiter();
      const clientIp = request.headers.get('x-forwarded-for') || undefined;

      const lockoutCheck = await rateLimiter.checkLoginAttempts(username);
      if (!lockoutCheck.allowed) {
        securityLogger.warn(
          { username, clientIp, channel: 'mobile' },
          'Login blocked — account locked out',
        );
        set.status = 423;
        return {
          error: 'Account temporarily locked due to too many failed login attempts.',
          retryAfter: lockoutCheck.retryAfter,
        };
      }

      const user = await userRepository.findByUsername(username);
      if (!user || !user.passwordHash) {
        await rateLimiter.recordFailedLogin(username);
        securityLogger.warn(
          { username, clientIp, channel: 'mobile', reason: 'unknown_user' },
          'Login failed',
        );
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      if (!user.isActive) {
        securityLogger.warn(
          { userId: user.id, username, clientIp, channel: 'mobile', reason: 'account_disabled' },
          'Login failed',
        );
        set.status = 401;
        return { error: 'Account is disabled' };
      }

      const validPassword = await verifyPassword(password, user.passwordHash);
      if (!validPassword) {
        await rateLimiter.recordFailedLogin(username);
        securityLogger.warn(
          { userId: user.id, username, clientIp, channel: 'mobile', reason: 'bad_password' },
          'Login failed',
        );
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      if (user.totpEnabled) {
        if (!totpCode) {
          set.status = 401;
          return { error: 'TOTP code required', requiresTOTP: true };
        }
        const totpAuth = getTOTPAuth();
        const validTOTP = await totpAuth.verify(user.id, totpCode);
        if (!validTOTP) {
          await rateLimiter.recordFailedLogin(username);
          securityLogger.warn(
            { userId: user.id, username, clientIp, channel: 'mobile', reason: 'bad_totp' },
            'Login failed',
          );
          set.status = 401;
          return { error: 'Invalid TOTP code' };
        }
      }

      await rateLimiter.clearLoginAttempts(username);

      const sessionManager = getSessionManager();
      const ipAddress = clientIp;
      const ua = deviceName || request.headers.get('user-agent') || 'Mobile App';

      const { token, session } = await sessionManager.create(user.id, {
        ipAddress,
        userAgent: `Mobile: ${ua}`,
      });

      securityLogger.info(
        { userId: user.id, username, clientIp, deviceName, channel: 'mobile' },
        'Login successful',
      );

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
        deviceName: t.Optional(t.String()),
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
        set.headers['Set-Cookie'] = clearSessionCookie(request);
        return { success: true };
      }

      const token = authHeader.substring(7);
      const sessionManager = getSessionManager();
      await sessionManager.revoke(token);

      set.headers['Set-Cookie'] = clearSessionCookie(request);

      return { success: true };
    },
    { detail: { tags: ['auth'] } }
  )

  // Get current user
  .get(
    '/me',
    async (ctx: any) => {
      const { user, set } = ctx;
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      // Phase 3d — when an admin is impersonating, the principal
      // carries actorUserId/actorUsername. Surface them so the
      // banner can show "<admin> is acting as <user>".
      const principal = ctx.principal as { actorUserId?: string | null; actorUsername?: string | null } | undefined;
      const actorUserId = principal?.actorUserId ?? null;
      const actorUsername = principal?.actorUsername ?? null;

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
          actorUserId,
          actorUsername,
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
        actorUserId,
        actorUsername,
      };
    },
    { detail: { tags: ['auth'] } }
  )

  // WebSocket auth ticket — exchange the HttpOnly session cookie for a
  // short-lived (60s) bearer token usable in the WS handshake URL
  // (`ws://.../ws?token=<ticket>`). The web client can't read the
  // HttpOnly session cookie, and SameSite=Strict prevents the cookie from
  // travelling on cross-origin WS handshakes (web at :3007, backend WS at
  // :3005). Without this endpoint the WS never authenticates and chat
  // silently falls back to REST.
  //
  // Security trade-off vs echoing the long-lived token: the ticket is
  // ephemeral, scoped to the same userId, and burns down within a minute
  // even if an XSS exfiltrates it.
  .get(
    '/ws-ticket',
    async (ctx: any) => {
      const { user, principal, request, set } = ctx;
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const sessionManager = getSessionManager();
      const { token, session } = await sessionManager.create(user.id, {
        channelType: 'web',
        channelId: 'ws-ticket',
        ipAddress: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        ttlMs: 60_000,
      });
      return { token, expiresAt: session.expiresAt };
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

      set.headers['Set-Cookie'] = sessionCookie(token, request);

      // Token sits in the HttpOnly cookie only.
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
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

      set.headers['Set-Cookie'] = sessionCookie(token, request);

      // Token sits in the HttpOnly cookie only.
      return {
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
      const { qrCodeUrl, backupCodes } = await totpAuth.generateSecret(user.id);

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
