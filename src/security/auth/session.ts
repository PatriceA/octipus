import { RedisCache } from '@/db/redis';
import { userRepository } from '@/db/repositories/user-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { getConfig } from '@/config';
import { securityLogger } from '@/utils/logger';
import { generateToken, sha256 } from '@/utils/crypto';

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
    }
  ): Promise<{ token: string; session: SessionData }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Enforce session count limit
    const MAX_SESSIONS = 20;
    const activeCount = await this.countForUser(userId);
    if (activeCount >= MAX_SESSIONS) {
      // Revoke oldest sessions to make room
      await this.cleanup(userId);
      const newCount = await this.countForUser(userId);
      if (newCount >= MAX_SESSIONS) {
        await this.revokeAllForUser(userId);
      }
    }

    const token = generateToken(32);
    const tokenHash = sha256(token);
    const now = new Date();

    const session: SessionData = {
      userId,
      username: user.username,
      isAdmin: user.isAdmin,
      channelType: options?.channelType,
      channelId: options?.channelId,
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.maxAge),
      lastActivityAt: now,
    };

    // Store session
    await this.cache.set(`${SESSION_PREFIX}${tokenHash}`, session, this.maxAge / 1000);

    // Track user's sessions
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const userSessions = (await this.cache.get<string[]>(userSessionsKey)) || [];
    userSessions.push(tokenHash);
    await this.cache.set(userSessionsKey, userSessions, this.maxAge / 1000);

    securityLogger.info({ userId, channelType: options?.channelType }, 'Session created');

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
