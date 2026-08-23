import { createHash } from 'crypto';
import { Cache } from '@/db/cache';
import { coreLogger } from '@/utils/logger';

interface CachedResponse {
  response: string;
  model: string;
  tokens: number;
  cachedAt: number;
}

/**
 * Redis-backed response cache for casual/direct LLM responses.
 * Keys are SHA-256 hashes of normalized message + recent context.
 */
export class ResponseCache {
  private cache: Cache;

  constructor(ttlSeconds: number = 120) {
    this.cache = new Cache(ttlSeconds);
  }

  private buildKey(sessionId: string, message: string, recentContext: string): string {
    const hash = createHash('sha256')
      .update(sessionId)
      .update('|')
      .update(message.trim().toLowerCase())
      .update('|')
      .update(recentContext)
      .digest('hex');
    return `resp_cache:${hash}`;
  }

  async get(sessionId: string, message: string, recentContext: string = ''): Promise<CachedResponse | null> {
    try {
      const cached = await this.cache.get<CachedResponse>(this.buildKey(sessionId, message, recentContext));
      if (cached) {
        coreLogger.debug({ message: message.slice(0, 50), sessionId }, 'Response cache hit');
      }
      return cached;
    } catch (error) {
      coreLogger.debug({ error }, 'Response cache get error (non-fatal)');
      return null;
    }
  }

  async set(sessionId: string, message: string, recentContext: string = '', response: CachedResponse): Promise<void> {
    try {
      await this.cache.set(this.buildKey(sessionId, message, recentContext), response);
    } catch (error) {
      coreLogger.debug({ error }, 'Response cache set error (non-fatal)');
    }
  }
}

// Singleton
let instance: ResponseCache | null = null;

export function getResponseCache(): ResponseCache {
  if (!instance) {
    instance = new ResponseCache();
  }
  return instance;
}
