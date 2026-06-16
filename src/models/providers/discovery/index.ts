import { createHash } from 'crypto';
import { RedisCache } from '@/db/redis';
import { modelLogger } from '@/utils/logger';
import { AnthropicDiscovery } from './anthropic';
import { curate } from './curation';
import { DeepSeekDiscovery } from './deepseek';
import { GeminiDiscovery } from './gemini';
import { GrokDiscovery } from './grok';
import { MistralDiscovery } from './mistral';
import { OllamaDiscovery } from './ollama';
import { OpenAIDiscovery } from './openai';
import { OpenRouterDiscovery } from './openrouter';
import type { CanonicalModel, CuratedSet, DiscoveryCreds, ProviderDiscovery } from './types';

export type { CanonicalModel, CuratedSet, DiscoveryCreds } from './types';

const TTL_SECONDS = 6 * 60 * 60; // 6h

const CLIENTS: Record<string, ProviderDiscovery> = {
  openai: new OpenAIDiscovery(),
  anthropic: new AnthropicDiscovery(),
  deepseek: new DeepSeekDiscovery(),
  gemini: new GeminiDiscovery(),
  google: new GeminiDiscovery(),
  grok: new GrokDiscovery(),
  mistral: new MistralDiscovery(),
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
  /** User ID for resolving user-scoped vault secrets. */
  userId?: string;
}

interface CacheEntry {
  models: CanonicalModel[];
  fetchedAt: number;
}

function credHash(creds: DiscoveryCreds): string {
  const fp = `${creds.endpoint || ''}:${creds.apiKey || ''}`;
  return createHash('sha256').update(fp).digest('hex').slice(0, 12);
}

/** Resolve API key for a provider from env first, then vault (user-scoped → system). */
async function resolveCreds(provider: string, userId?: string): Promise<DiscoveryCreds> {
  const envMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    gemini: 'GEMINI_API_KEY',
    google: 'GEMINI_API_KEY',
    grok: 'XAI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };
  const vaultKeyMap: Record<string, string> = {
    openai: 'openai_api_key',
    anthropic: 'anthropic_api_key',
    deepseek: 'deepseek_api_key',
    gemini: 'gemini_api_key',
    google: 'gemini_api_key',
    grok: 'xai_api_key',
    mistral: 'mistral_api_key',
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
    const vaultKey = vaultKeyMap[provider];
    if (vaultKey) {
      // Try user-scoped secret first, then fall back to system
      if (userId && userId !== 'system') {
        const userValue = await vault.getByName(userId, vaultKey);
        if (userValue) return { apiKey: userValue };
      }
      const value = await vault.getByName('system', vaultKey);
      if (value) return { apiKey: value };
    }
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

  const creds = credsOverride ?? await resolveCreds(provider, opts.userId);
  if (!creds.apiKey && provider !== 'ollama') {
    return { shortlist: [], hiddenCount: 0, lastFetched: 0, source: 'unconfigured', error: `${provider} not configured (missing API key)` };
  }

  // Self-hosted catalogs (Ollama): every model is one the user intentionally
  // pulled. Don't strip OCR/whisper/embedding variants — surface them all.
  const curateOpts = provider === 'ollama'
    ? { ...opts, includeNonChat: true }
    : opts;

  const key = `models:discovery:${provider}:${credHash(creds)}`;

  // Cache hit.
  if (!opts.bypassCache) {
    const cached = await cache.get<CacheEntry>(key);
    if (cached && Date.now() - cached.fetchedAt < TTL_SECONDS * 1000) {
      return curate(cached.models, 'cache', cached.fetchedAt, curateOpts);
    }
  }

  // Live fetch.
  try {
    const models = await client.listAll(creds);
    await cache.set(key, { models, fetchedAt: Date.now() } satisfies CacheEntry, TTL_SECONDS);
    return curate(models, 'live', Date.now(), curateOpts);
  } catch (err) {
    const errMsg = (err as Error).message;
    // Include error name + status so operators can tell timeout from
    // connection-refused from 4xx response without bisecting code paths.
    const errName = (err as Error).name;
    const errStatus = (err as { status?: number }).status;
    modelLogger.warn(
      { err: errMsg, errName, errStatus, provider },
      'discovery: live fetch failed, attempting stale cache',
    );
    const stale = await cache.get<CacheEntry>(key);
    if (stale) {
      const curated = curate(stale.models, 'cache', stale.fetchedAt, curateOpts);
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
