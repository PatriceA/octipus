import { createHash } from 'crypto';
import { RedisCache } from '@/db/redis';
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
  private cache: RedisCache;

  constructor(ttlSeconds: number = 300) {
    this.cache = new RedisCache(ttlSeconds);
  }

  private buildKey(message: string, recentContext: string): string {
    const hash = createHash('sha256')
      .update(message.trim().toLowerCase())
      .update('|')
      .update(recentContext)
      .digest('hex')
      .slice(0, 16);
    return `resp_cache:${hash}`;
  }

  async get(message: string, recentContext: string = ''): Promise<CachedResponse | null> {
    try {
      const cached = await this.cache.get<CachedResponse>(this.buildKey(message, recentContext));
      if (cached) {
        coreLogger.debug({ message: message.slice(0, 50) }, 'Response cache hit');
      }
      return cached;
    } catch (error) {
      coreLogger.debug({ error }, 'Response cache get error (non-fatal)');
      return null;
    }
  }

  async set(message: string, recentContext: string = '', response: CachedResponse): Promise<void> {
    try {
      await this.cache.set(this.buildKey(message, recentContext), response);
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
