import { getConfig } from '@/config';
import { RedisCache } from '@/db/redis';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { generateToken, sha256 } from '@/utils/crypto';
import { securityLogger } from '@/utils/logger';

const SESSION_PREFIX = 'session:';
const USER_SESSIONS_PREFIX = 'user-sessions:';

export interface SessionData {
  userId: string;
  username: string;
  isAdmin: boolean;
  channelType?: string;
  channelId?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
  expiresAt: Date;
  lastActivityAt: Date;
}

/** A ticket, not a login: minted per WebSocket handshake and gone in a minute. */
const EPHEMERAL_TTL_MAX_MS = 5 * 60_000;

/** One place resolves the lifetime, so the cap and the store cannot disagree. */
function ttlMsFor(requested: number | undefined, fallback: number): number {
  return requested ?? fallback;
}

/**
 * The same ticket test applied to a session that already exists, read off its
 * own lifetime. The cap must recognise a ticket it minted earlier, not only the
 * one being minted now — otherwise tickets are exempt from the check while
 * still filling the cap and still being eviction candidates, and because they
 * are always the NEWEST entries, oldest-first eviction takes the user's real
 * logins instead.
 */
function isEphemeralSession(s: { createdAt: Date | string; expiresAt: Date | string }): boolean {
  return new Date(s.expiresAt).getTime() - new Date(s.createdAt).getTime() <= EPHEMERAL_TTL_MAX_MS;
}

export class SessionManager {
  private cache: RedisCache;
  private maxAge: number;

  constructor() {
    const config = getConfig();
    this.maxAge = config.security.sessionMaxAge;
    this.cache = new RedisCache(this.maxAge / 1000);
  }

  /**
   * Create a new session
   */
  async create(
    userId: string,
    options?: {
      channelType?: string;
      channelId?: string;
      ipAddress?: string;
      userAgent?: string;
      /** Override the session lifetime (ms). Defaults to the configured
       *  `sessionMaxAge`. Use a small value (e.g. 60_000) for short-lived
       *  tickets — WS-handshake tickets where the long-lived auth is held
       *  in an HttpOnly cookie that the browser can't put in the WS URL. */
      ttlMs?: number;
    }
  ): Promise<{ token: string; session: SessionData }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Enforce the session count limit by EVICTING THE OLDEST, never by
    // revoking everything.
    //
    // The old fallback did the latter, and it fired in ordinary use: every
    // WebSocket handshake mints a short-lived ticket session, so a user opening
    // a few pages reached twenty live sessions in under a minute — at which
    // point their browser cookie, their phone and every other device were
    // revoked mid-click. The observed symptom is a storm of 401s on `/auth/me`
    // and a UI that silently reverts to logged-out a minute after a valid
    // login.
    //
    // Evicting oldest-first keeps the cap doing its job — a bounded number of
    // live sessions per user — without the cure being worse than the disease.
    // Short-lived tickets are exempt from the cap AND from filling it. A
    // WebSocket handshake mints one per connection and it burns down in a
    // minute; counting them meant a browser tab could evict the user's phone.
    const MAX_SESSIONS = 20;
    const isEphemeral = ttlMsFor(options?.ttlMs, this.maxAge) <= EPHEMERAL_TTL_MAX_MS;
    if (!isEphemeral) {
      await this.cleanup(userId);
      // Tickets are filtered out of BOTH the count and the candidate list, not
      // just the check above. `countForUser`/`listForUserWithHashes` stay
      // unfiltered because the sessions UI must still show every live session.
      const live = (await this.listForUserWithHashes(userId)).filter((s) => !isEphemeralSession(s));
      if (live.length >= MAX_SESSIONS) {
        const oldestFirst = [...live].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        // +1 because one more is about to be added.
        const evict = live.length - MAX_SESSIONS + 1;
        for (const victim of oldestFirst.slice(0, evict)) {
          await this.revokeByHash(userId, victim.id);
        }
        securityLogger.warn(
          { userId, evicted: evict, cap: MAX_SESSIONS },
          'Session cap reached — evicted the oldest sessions',
        );
      }
    }

    const token = generateToken(32);
    const tokenHash = sha256(token);
    const now = new Date();
    const ttlMs = ttlMsFor(options?.ttlMs, this.maxAge);

    const session: SessionData = {
      userId,
      username: user.username,
      isAdmin: user.isAdmin,
      channelType: options?.channelType,
      channelId: options?.channelId,
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      lastActivityAt: now,
    };

    // Store session
    await this.cache.set(`${SESSION_PREFIX}${tokenHash}`, session, ttlMs / 1000);

    // Track user's sessions
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];
    userSessions.push(tokenHash);
    await this.cache.set(userSessionsKey, userSessions, this.maxAge / 1000);

    securityLogger.info({ userId, channelType: options?.channelType, ttlMs }, 'Session created');

    return { token, session };
  }

  /**
   * Validate a session token
   */
  async validate(token: string): Promise<SessionData | null> {
    const tokenHash = sha256(token);
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);

    if (!session) {
      return null;
    }

    // Check expiration
    if (new Date(session.expiresAt) < new Date()) {
      await this.revoke(token);
      return null;
    }

    // Update last activity
    session.lastActivityAt = new Date();
    await this.cache.set(`${SESSION_PREFIX}${tokenHash}`, session, this.maxAge / 1000);

    return session;
  }

  /**
   * Get session without validation (for internal use)
   */
  async get(token: string): Promise<SessionData | null> {
    const tokenHash = sha256(token);
    return this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);
  }

  /**
   * List active sessions for a user with their hashes (IDs)
   */
  async listForUserWithHashes(userId: string): Promise<(SessionData & { id: string })[]> {
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];

    const sessions: (SessionData & { id: string })[] = [];

    for (const tokenHash of userSessions) {
      const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);
      if (session && new Date(session.expiresAt) > new Date()) {
        sessions.push({ ...session, id: tokenHash });
      }
    }

    return sessions;
  }

  /**
   * Revoke a session by its token hash
   */
  async revokeByHash(userId: string, tokenHash: string): Promise<boolean> {
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);

    if (!session || session.userId !== userId) {
      return false;
    }

    // Remove session
    await this.cache.delete(`${SESSION_PREFIX}${tokenHash}`);

    // Remove from user's sessions
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];
    const filteredSessions = userSessions.filter((h) => h !== tokenHash);
    await this.cache.set(userSessionsKey, filteredSessions, this.maxAge / 1000);

    await auditRepository.logLogout(userId);
    securityLogger.info({ userId }, 'Session revoked by hash');

    return true;
  }

  /**
   * Revoke a session
   */
  async revoke(token: string): Promise<boolean> {
    const tokenHash = sha256(token);
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);

    if (!session) {
      return false;
    }

    // Remove session
    await this.cache.delete(`${SESSION_PREFIX}${tokenHash}`);

    // Remove from user's sessions
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${session.userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];
    const filteredSessions = userSessions.filter((h) => h !== tokenHash);
    await this.cache.set(userSessionsKey, filteredSessions, this.maxAge / 1000);

    await auditRepository.logLogout(session.userId);
    securityLogger.info({ userId: session.userId }, 'Session revoked');

    return true;
  }

  /**
   * Revoke all sessions for a user
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];

    let count = 0;
    for (const tokenHash of userSessions) {
      await this.cache.delete(`${SESSION_PREFIX}${tokenHash}`);
      count++;
    }

    await this.cache.delete(userSessionsKey);

    securityLogger.info({ userId, count }, 'All user sessions revoked');

    return count;
  }

  /**
   * List active sessions for a user
   */
  async listForUser(userId: string): Promise<Omit<SessionData, 'userId'>[]> {
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];

    const sessions: Omit<SessionData, 'userId'>[] = [];

    for (const tokenHash of userSessions) {
      const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);
      if (session && new Date(session.expiresAt) > new Date()) {
        const { userId: _, ...rest } = session;
        sessions.push(rest);
      }
    }

    return sessions;
  }

  /**
   * Refresh session expiration
   */
  async refresh(token: string): Promise<SessionData | null> {
    const tokenHash = sha256(token);
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);

    if (!session) {
      return null;
    }

    // Extend expiration
    session.expiresAt = new Date(Date.now() + this.maxAge);
    session.lastActivityAt = new Date();

    await this.cache.set(`${SESSION_PREFIX}${tokenHash}`, session, this.maxAge / 1000);

    return session;
  }

  /**
   * Get active session count for a user
   */
  async countForUser(userId: string): Promise<number> {
    const sessions = await this.listForUser(userId);
    return sessions.length;
  }

  /**
   * Clean up expired sessions for a user
   */
  async cleanup(userId: string): Promise<number> {
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];

    const activeSessions: string[] = [];
    let cleaned = 0;

    for (const tokenHash of userSessions) {
      const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${tokenHash}`);
      if (session && new Date(session.expiresAt) > new Date()) {
        activeSessions.push(tokenHash);
      } else {
        await this.cache.delete(`${SESSION_PREFIX}${tokenHash}`);
        cleaned++;
      }
    }

    if (activeSessions.length !== userSessions.length) {
      await this.cache.set(userSessionsKey, activeSessions, this.maxAge / 1000);
    }

    return cleaned;
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}
