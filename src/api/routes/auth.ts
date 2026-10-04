import { Elysia, t } from '@/api/http';
import { getConfig } from '@/config';
import { apiContext } from '@/api/context';
import { clearSessionCookie, sessionCookie } from '@/api/session-cookie';
import { redeemLinkCode } from '@/channels/linking';
import { ensureDailyBriefingHook } from '@/core/briefing';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { getPasskeyAuth } from '@/security/auth/passkey';
import { getSessionManager, InactiveUserError } from '@/security/auth/session';
import { getTOTPAuth } from '@/security/auth/totp';
import { isAuthenticated } from '@/security/principal';
import { clientIp, recordedClientIp } from '@/security/client-ip';
import { getRateLimiter } from '@/security/rate-limiter';
import { isSafeReturnTo, RETURN_TO_MAX_LENGTH } from '@/shared/return-to';
import { hashPassword, verifyPassword } from '@/utils/crypto';
import { apiLogger, securityLogger } from '@/utils/logger';

/**
 * The audit row for a password sign-in attempt. `userId` is null when the
 * username matched no account; the attempted username is kept in the details
 * either way.
 */
async function auditSignIn(args: {
  outcome: 'login' | 'login_failed';
  userId: string | null;
  username: string;
  channel: 'web' | 'mobile';
  request: Request;
  socketAddress: string | undefined;
  reason?: string;
}): Promise<void> {
  await auditRepository.log({
    userId: args.userId,
    action: args.outcome,
    resourceType: 'user',
    resourceId: args.userId,
    ipAddress: recordedClientIp(args.request, args.socketAddress),
    userAgent: args.request.headers.get('user-agent') || undefined,
    channelType: args.channel,
    details: { username: args.username, ...(args.reason ? { reason: args.reason } : {}) },
  });
}

/** `returnTo` as the sign-in and register bodies accept it; checked with `isSafeReturnTo`. */
const returnToField = t.Optional(t.String({ maxLength: RETURN_TO_MAX_LENGTH }));
const INVALID_RETURN_TO = { error: 'returnTo must be a same-origin path starting with a single "/"' };

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(apiContext)
  // Login with username/password
  .post(
    '/login',
    async ({ body, request, set, socketAddress }) => {
      const { username, password, totpCode, returnTo } = body;
      if (returnTo !== undefined && !isSafeReturnTo(returnTo)) {
        set.status = 400;
        return INVALID_RETURN_TO;
      }
      const rateLimiter = getRateLimiter();
      const ip = clientIp(request, socketAddress);
      const audit = (outcome: 'login' | 'login_failed', userId: string | null, reason?: string) =>
        auditSignIn({ outcome, userId, username, channel: 'web', request, socketAddress, reason });

      // Check account lockout before anything else
      const lockoutCheck = await rateLimiter.checkLoginAttempts(username);
      if (!lockoutCheck.allowed) {
        securityLogger.warn(
          { username, clientIp: ip, channel: 'web' },
          'Login blocked — account locked out',
        );
        await audit('login_failed', null, 'locked_out');
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
          { username, clientIp: ip, channel: 'web', reason: 'unknown_user' },
          'Login failed',
        );
        await audit('login_failed', null, 'unknown_user');
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      if (!user.isActive) {
        securityLogger.warn(
          { userId: user.id, username, clientIp: ip, channel: 'web', reason: 'account_disabled' },
          'Login failed',
        );
        await audit('login_failed', user.id, 'account_disabled');
        set.status = 401;
        return { error: 'Account is disabled' };
      }

      const validPassword = await verifyPassword(password, user.passwordHash);
      if (!validPassword) {
        await rateLimiter.recordFailedLogin(username);
        securityLogger.warn(
          { userId: user.id, username, clientIp: ip, channel: 'web', reason: 'bad_password' },
          'Login failed',
        );
        await audit('login_failed', user.id, 'bad_password');
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
            { userId: user.id, username, clientIp: ip, channel: 'web', reason: 'bad_totp' },
            'Login failed',
          );
          await audit('login_failed', user.id, 'bad_totp');
          set.status = 401;
          return { error: 'Invalid TOTP code' };
        }
      }

      // Successful login — clear failed attempts
      await rateLimiter.clearLoginAttempts(username);

      const sessionManager = getSessionManager();
      const ipAddress = recordedClientIp(request, socketAddress);
      const userAgent = request.headers.get('user-agent') || undefined;

      const { token, session } = await sessionManager.create(user.id, {
        ipAddress,
        userAgent,
      });

      set.headers['Set-Cookie'] = sessionCookie(token, request);

      securityLogger.info(
        { userId: user.id, username, clientIp: ip, channel: 'web' },
        'Login successful',
      );
      await audit('login', user.id);

      // Token lives only in the HttpOnly cookie — do not echo it in the
      // response body where same-origin scripts could read it.
      return {
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
        },
        expiresAt: session.expiresAt,
        returnTo: returnTo ?? '/',
      };
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
        totpCode: t.Optional(t.String()),
        returnTo: returnToField,
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
    async ({ body, request, set, socketAddress }) => {
      const { username, password, totpCode, deviceName, returnTo } = body;
      if (returnTo !== undefined && !isSafeReturnTo(returnTo)) {
        set.status = 400;
        return INVALID_RETURN_TO;
      }
      const rateLimiter = getRateLimiter();
      const ip = clientIp(request, socketAddress);
      const audit = (outcome: 'login' | 'login_failed', userId: string | null, reason?: string) =>
        auditSignIn({ outcome, userId, username, channel: 'mobile', request, socketAddress, reason });

      const lockoutCheck = await rateLimiter.checkLoginAttempts(username);
      if (!lockoutCheck.allowed) {
        securityLogger.warn(
          { username, clientIp: ip, channel: 'mobile' },
          'Login blocked — account locked out',
        );
        await audit('login_failed', null, 'locked_out');
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
          { username, clientIp: ip, channel: 'mobile', reason: 'unknown_user' },
          'Login failed',
        );
        await audit('login_failed', null, 'unknown_user');
        set.status = 401;
        return { error: 'Invalid credentials' };
      }

      if (!user.isActive) {
        securityLogger.warn(
          { userId: user.id, username, clientIp: ip, channel: 'mobile', reason: 'account_disabled' },
          'Login failed',
        );
        await audit('login_failed', user.id, 'account_disabled');
        set.status = 401;
        return { error: 'Account is disabled' };
      }

      const validPassword = await verifyPassword(password, user.passwordHash);
      if (!validPassword) {
        await rateLimiter.recordFailedLogin(username);
        securityLogger.warn(
          { userId: user.id, username, clientIp: ip, channel: 'mobile', reason: 'bad_password' },
          'Login failed',
        );
        await audit('login_failed', user.id, 'bad_password');
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
            { userId: user.id, username, clientIp: ip, channel: 'mobile', reason: 'bad_totp' },
            'Login failed',
          );
          await audit('login_failed', user.id, 'bad_totp');
          set.status = 401;
          return { error: 'Invalid TOTP code' };
        }
      }

      await rateLimiter.clearLoginAttempts(username);

      const sessionManager = getSessionManager();
      const ipAddress = recordedClientIp(request, socketAddress);
      const ua = deviceName || request.headers.get('user-agent') || 'Mobile App';

      const { token, session } = await sessionManager.create(user.id, {
        ipAddress,
        userAgent: `Mobile: ${ua}`,
        ttlMs: getConfig().security.mobileSessionMaxAge,
      });

      securityLogger.info(
        { userId: user.id, username, clientIp: ip, deviceName, channel: 'mobile' },
        'Login successful',
      );
      await audit('login', user.id);

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
        },
        expiresAt: session.expiresAt,
        returnTo: returnTo ?? '/',
      };
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
        totpCode: t.Optional(t.String()),
        deviceName: t.Optional(t.String()),
        returnTo: returnToField,
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
      const { user, principal, request, set, socketAddress } = ctx;
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const sessionManager = getSessionManager();
      const { token, session } = await sessionManager.create(user.id, {
        channelType: 'web',
        channelId: 'ws-ticket',
        ipAddress: recordedClientIp(request, socketAddress),
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
    async ({ body, request, set, socketAddress }) => {
      const { username, email, password, returnTo } = body;
      if (returnTo !== undefined && !isSafeReturnTo(returnTo)) {
        set.status = 400;
        return INVALID_RETURN_TO;
      }

      // Rate-limit registration attempts by IP
      const rateLimiter = getRateLimiter();
      const ip = clientIp(request, socketAddress);
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

      // Self-registration: the new user is both the actor and the resource.
      await auditRepository.log({
        userId: user.id,
        action: 'user_created',
        resourceType: 'user',
        resourceId: user.id,
        ipAddress: recordedClientIp(request, socketAddress),
        userAgent: request.headers.get('user-agent') || undefined,
        channelType: 'web',
        details: { username: user.username, isAdmin: user.isAdmin, selfRegistered: true },
      });

      // Every user starts with one proactive turn a day: the weekday-morning
      // briefing. It is an ordinary hook (pause / edit / delete on the Hooks
      // page). Fail-soft — a missing hook must never fail a registration.
      try {
        await ensureDailyBriefingHook(user.id);
      } catch (err) {
        apiLogger.warn({ err, userId: user.id }, 'daily briefing hook not seeded at registration');
      }

      // Auto-login after registration
      const sessionManager = getSessionManager();
      const ipAddress = recordedClientIp(request, socketAddress);
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
        returnTo: returnTo ?? '/',
      };
    },
    {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 50 }),
        // `format: 'email'` was never registered with the validator, so every
        // request that carried an email failed as "Invalid request data" —
        // registering with an address was impossible. `pattern` is enforced
        // natively; the real check is the unique constraint on the column.
        email: t.Optional(t.String({ pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' })),
        password: t.String({ minLength: 8 }),
        returnTo: returnToField,
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
    async ({ body, request, set, socketAddress }) => {
      // Rate-limit passkey auth attempts by IP
      const rateLimiter = getRateLimiter();
      const ip = clientIp(request, socketAddress);
      const passkeyCheck = await rateLimiter.check(`passkey:${ip}`, 10, 300000); // 10 attempts per 5 min
      if (!passkeyCheck.allowed) {
        set.status = 429;
        return { error: 'Too many authentication attempts. Try again later.' };
      }

      const passkeyAuth = getPasskeyAuth();
      const ipAddress = recordedClientIp(request, socketAddress);

      const verification = await passkeyAuth.verifyAuthentication(body.userId, body.response, ipAddress);

      if (!verification.verified) {
        return { error: 'Authentication failed' };
      }

      const sessionManager = getSessionManager();
      let created: Awaited<ReturnType<typeof sessionManager.create>>;
      try {
        created = await sessionManager.create(body.userId, {
          ipAddress,
          userAgent: request.headers.get('user-agent') || undefined,
        });
      } catch (err) {
        if (!(err instanceof InactiveUserError)) throw err;
        set.status = 401;
        return { error: 'Account is disabled' };
      }
      const { token, session } = created;

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
