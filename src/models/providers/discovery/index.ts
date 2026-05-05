import { createHash } from 'crypto';
import { RedisCache } from '@/db/redis';
import { modelLogger } from '@/utils/logger';
import { AnthropicDiscovery } from './anthropic';
import { curate } from './curation';
import { GeminiDiscovery } from './gemini';
import { OllamaDiscovery } from './ollama';
import { OpenAIDiscovery } from './openai';
import { OpenRouterDiscovery } from './openrouter';
import type { CanonicalModel, CuratedSet, DiscoveryCreds, ProviderDiscovery } from './types';

export type { CanonicalModel, CuratedSet, DiscoveryCreds } from './types';

const TTL_SECONDS = 6 * 60 * 60; // 6h

const CLIENTS: Record<string, ProviderDiscovery> = {
  openai: new OpenAIDiscovery(),
  anthropic: new AnthropicDiscovery(),
  gemini: new GeminiDiscovery(),
  google: new GeminiDiscovery(),
  openrouter: new OpenRouterDiscovery(),
  ollama: new OllamaDiscovery(),
};

const cache = new RedisCache(TTL_SECONDS);

export interface DiscoveryOptions {
  /** Force a fresh fetch even if a cache entry is valid. */
  bypassCache?: boolean;
  /** Show preview/experimental models. Default false. */
  includePreview?: boolean;
  /** Show embeddings/non-chat. Default false. */
  includeNonChat?: boolean;
  /** Cap shortlist size. Default unlimited. */
  limit?: number;
}

interface CacheEntry {
  models: CanonicalModel[];
  fetchedAt: number;
}

function credHash(creds: DiscoveryCreds): string {
  const fp = `${creds.endpoint || ''}:${creds.apiKey || ''}`;
  return createHash('sha256').update(fp).digest('hex').slice(0, 12);
}

/** Resolve API key for a provider from env first, then vault. */
async function resolveCreds(provider: string): Promise<DiscoveryCreds> {
  const envMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    google: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };
  const vaultKeyMap: Record<string, string> = {
    openai: 'openai_api_key',
    anthropic: 'anthropic_api_key',
    gemini: 'gemini_api_key',
    google: 'gemini_api_key',
    openrouter: 'openrouter_api_key',
  };

  // Ollama is endpoint-only; pull from config.
  if (provider === 'ollama') {
    const { getConfig } = await import('@/config');
    return { endpoint: getConfig().ollama?.url || 'http://localhost:11434' };
  }

  if (envMap[provider] && process.env[envMap[provider]]) {
    return { apiKey: process.env[envMap[provider]] };
  }

  try {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const value = await vault.getByName('system', vaultKeyMap[provider]);
    if (value) return { apiKey: value };
  } catch (err) {
    modelLogger.debug({ err, provider }, 'discovery: vault lookup failed');
  }
  return {};
}

/**
 * Discover & curate models for a provider. Stale-while-revalidate: returns
 * cache immediately when fresh; otherwise hits the vendor API and writes
 * the result back. On a network failure, returns the last-known cache with
 * source='cache' (and an `error` field).
 */
export async function discover(
  provider: string,
  opts: DiscoveryOptions = {},
  credsOverride?: DiscoveryCreds,
): Promise<CuratedSet> {
  const client = CLIENTS[provider];
  if (!client) {
    return { shortlist: [], hiddenCount: 0, lastFetched: 0, source: 'unconfigured', error: `Unknown provider: ${provider}` };
  }

  const creds = credsOverride ?? await resolveCreds(provider);
  if (!creds.apiKey && provider !== 'ollama') {
    return { shortlist: [], hiddenCount: 0, lastFetched: 0, source: 'unconfigured', error: `${provider} not configured (missing API key)` };
  }

  const key = `models:discovery:${provider}:${credHash(creds)}`;

  // Cache hit.
  if (!opts.bypassCache) {
    const cached = await cache.get<CacheEntry>(key);
    if (cached && Date.now() - cached.fetchedAt < TTL_SECONDS * 1000) {
      return curate(cached.models, 'cache', cached.fetchedAt, opts);
    }
  }

  // Live fetch.
  try {
    const models = await client.listAll(creds);
    await cache.set(key, { models, fetchedAt: Date.now() } satisfies CacheEntry, TTL_SECONDS);
    return curate(models, 'live', Date.now(), opts);
  } catch (err) {
    const errMsg = (err as Error).message;
    modelLogger.warn({ err: errMsg, provider }, 'discovery: live fetch failed, attempting stale cache');
    const stale = await cache.get<CacheEntry>(key);
    if (stale) {
      const curated = curate(stale.models, 'cache', stale.fetchedAt, opts);
      curated.error = errMsg;
      return curated;
    }
    return { shortlist: [], hiddenCount: 0, lastFetched: 0, source: 'unconfigured', error: errMsg };
  }
}

/** Convenience: list providers we know how to discover. */
export function getDiscoverableProviders(): string[] {
  return Object.keys(CLIENTS);
}
