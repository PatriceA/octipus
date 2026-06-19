/**
 * Per-topic configuration extras (executorModel / temperature / maxTokens),
 * backed by the `topics_config` table. Loaded into an in-memory cache at boot
 * (like ROLE_CONFIGS) so the spawn/completion hot path never hits the DB; the
 * cache is refreshed on write. Topics without a row use all defaults.
 */

import { getDb } from '@/db/postgres';
import { type NewTopicConfig, type TopicConfig, topicsConfig } from '@/db/schema/topics-config';
import { modelLogger } from '@/utils/logger';

/** The resolvable extras for a topic (null fields ⇒ fall back to model defaults). */
export interface ResolvedTopicConfig {
  executorModel: string | null;
  temperature: number | null;
  maxTokens: number | null;
}

const EMPTY: ResolvedTopicConfig = { executorModel: null, temperature: null, maxTokens: null };

// Module-level cache. Populated by loadTopicConfigs() at boot and kept current
// by setTopicConfig(). Empty before load ⇒ getTopicConfig returns EMPTY (no
// override), which is the safe default.
const cache = new Map<string, ResolvedTopicConfig>();
let loaded = false;

function toResolved(row: TopicConfig): ResolvedTopicConfig {
  return {
    executorModel: row.executorModel ?? null,
    temperature: row.temperature ?? null,
    maxTokens: row.maxTokens ?? null,
  };
}

/** Load all topic configs into the in-memory cache. Call once at boot. */
export async function loadTopicConfigs(): Promise<void> {
  const rows = await getDb().select().from(topicsConfig);
  cache.clear();
  for (const row of rows) cache.set(row.topic, toResolved(row));
  loaded = true;
  modelLogger.info({ count: rows.length }, 'Loaded topic configs from database');
}

/**
 * Synchronous cache read for the hot path. Returns EMPTY (all-null) for an
 * unconfigured topic — callers treat null fields as "use model defaults".
 */
export function getTopicConfig(topic: string | undefined): ResolvedTopicConfig {
  if (!topic) return EMPTY;
  return cache.get(topic) ?? EMPTY;
}

/** Upsert a topic's extras and refresh the cache. Returns the new resolved config. */
export async function setTopicConfig(
  topic: string,
  patch: Partial<Pick<ResolvedTopicConfig, 'executorModel' | 'temperature' | 'maxTokens'>>,
): Promise<ResolvedTopicConfig> {
  const db = getDb();
  const values: NewTopicConfig = {
    topic,
    executorModel: patch.executorModel ?? null,
    temperature: patch.temperature ?? null,
    maxTokens: patch.maxTokens ?? null,
  };
  const [row] = await db
    .insert(topicsConfig)
    .values(values)
    .onConflictDoUpdate({
      target: topicsConfig.topic,
      set: {
        executorModel: values.executorModel,
        temperature: values.temperature,
        maxTokens: values.maxTokens,
        updatedAt: new Date(),
      },
    })
    .returning();
  const resolved = toResolved(row);
  cache.set(topic, resolved);
  return resolved;
}

/** Whether the cache has been loaded (for diagnostics/tests). */
export function topicConfigsLoaded(): boolean {
  return loaded;
}

/** Test-only: reset the in-memory cache. */
export function __setTopicConfigCacheForTest(entries: Record<string, ResolvedTopicConfig>): void {
  cache.clear();
  for (const [k, v] of Object.entries(entries)) cache.set(k, v);
  loaded = true;
}

/**
 * Apply a topic's temperature/maxTokens overrides on top of the model-derived
 * completion params. Pure + null-safe: an unset override leaves the base value
 * untouched. Used by the agent worker at completion time.
 */
export function applyTopicParamOverrides<T extends { temperature?: number; maxTokens?: number }>(
  base: T,
  topicConfig: ResolvedTopicConfig,
): T {
  const out = { ...base };
  if (topicConfig.temperature != null) out.temperature = topicConfig.temperature;
  if (topicConfig.maxTokens != null) out.maxTokens = topicConfig.maxTokens;
  return out;
}
