import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { RedisCache } from '@/db/redis';
import { type ModelConfigEntry, modelConfig, type NewModelConfigEntry } from '@/db/schema/models';
import { getCapabilitiesForModel, type ModelCapabilities } from '@/models/capabilities';
import { SINGLE_MODEL_CHAT_TOPICS } from '@/models/single-model-binding';
import { getUserOrgIds } from '@/services/org-membership';
import { modelLogger } from '@/utils/logger';

const CACHE_TTL = 300; // 5 minutes

export class ModelRegistry {
  // Resolve the live connection per access rather than snapshotting it at
  // construction: this is a process-global singleton, so a cached handle would
  // dangle after the socket is recycled (max_lifetime) or closed/reopened
  // between integration-test files, surfacing as CONNECTION_ENDED. getDb() is a
  // cheap `if (db) return db`.
  private get db() {
    return getDb();
  }
  private cache = new RedisCache(CACHE_TTL);

  private async cacheGet<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttlSeconds);
    } catch {
      // Ignore cache errors (e.g., storage not initialized in CLI/unit mode).
    }
  }

  private async cacheDelete(key: string): Promise<void> {
    try {
      await this.cache.delete(key);
    } catch {
      // Ignore cache errors.
    }
  }

  /**
   * Get model configuration by name
   */
  async getModel(name: string): Promise<ModelConfigEntry | null> {
    // Check cache first
    const cached = await this.cacheGet<ModelConfigEntry>(`model:${name}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.name, name), eq(modelConfig.isEnabled, true)))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cacheSet(`model:${name}`, model);
    }

    return model;
  }

  /**
   * Get model configuration by modelId (the LiteLLM-facing identifier)
   */
  async getModelByModelId(modelId: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cacheGet<ModelConfigEntry>(`model:mid:${modelId}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.modelId, modelId), eq(modelConfig.isEnabled, true)))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cacheSet(`model:mid:${modelId}`, model);
    }

    return model;
  }

  /**
   * Get the default model
   */
  async getDefaultModel(): Promise<ModelConfigEntry | null> {
    const cached = await this.cacheGet<ModelConfigEntry>('model:default');
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.isDefault, true), eq(modelConfig.isEnabled, true)))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cacheSet('model:default', model);
    }

    return model;
  }

  /**
   * Get model for a specific topic.
   * Priority: topicRoles primary → topicRoles backup → legacy topics+priority → default
   */
  async getModelForTopic(topic: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cacheGet<ModelConfigEntry>(`model:topic:${topic}`);
    if (cached) return cached;

    // 1. Check topicRoles for 'primary'
    const primaryResult = await this.db
      .select()
      .from(modelConfig)
      .where(and(
        eq(modelConfig.isEnabled, true),
        sql`${modelConfig.topicRoles}->>${topic} = 'primary'`,
      ))
      .limit(1);

    let model: ModelConfigEntry | null = primaryResult[0] ?? null;

    // 2. Fall back to legacy topics array + priority
    if (!model) {
      const legacyResult = await this.db
        .select()
        .from(modelConfig)
        .where(and(eq(modelConfig.isEnabled, true), sql`${topic} = ANY(${modelConfig.topics})`))
        .orderBy(desc(modelConfig.priority))
        .limit(1);
      model = legacyResult[0] ?? null;
    }

    // No fallback to default — caller must handle null. Falling back here
    // silently routes unmapped topics to whichever model is default, which
    // breaks the "topic → model" contract users configure in the UI.
    if (model) {
      await this.cacheSet(`model:topic:${topic}`, model);
    } else {
      modelLogger.debug({ topic }, 'No model mapped for topic');
    }

    return model;
  }

  /**
   * Get backup model for a topic (for fallback on rate limit/error).
   */
  async getBackupModelForTopic(topic: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cacheGet<ModelConfigEntry>(`model:topic:backup:${topic}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(
        eq(modelConfig.isEnabled, true),
        sql`${modelConfig.topicRoles}->>${topic} = 'backup'`,
      ))
      .limit(1);

    const model = result[0] ?? null;

    if (model) {
      await this.cacheSet(`model:topic:backup:${topic}`, model);
    }

    return model;
  }

  /**
   * Get all enabled models
   */
  async getAllModels(): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .where(eq(modelConfig.isEnabled, true))
      .orderBy(desc(modelConfig.priority), asc(modelConfig.name));
  }

  async getAllModelsIncludeDisabled(): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .orderBy(desc(modelConfig.isEnabled), desc(modelConfig.priority), asc(modelConfig.name));
  }

  /**
   * List models visible to a specific user. System-wide rows
   * (`org_id IS NULL`) are always included; org-scoped rows are
   * included when the user belongs to that org. Admins see
   * everything via `getAllModelsIncludeDisabled`.
   */
  async getModelsForUser(userId: string): Promise<ModelConfigEntry[]> {
    const orgIds = await getUserOrgIds(userId);
    const visibility = orgIds.length > 0
      ? or(isNull(modelConfig.orgId), inArray(modelConfig.orgId, orgIds))
      : isNull(modelConfig.orgId);
    return this.db
      .select()
      .from(modelConfig)
      .where(visibility)
      .orderBy(desc(modelConfig.isEnabled), desc(modelConfig.priority), asc(modelConfig.name));
  }

  /**
   * Get models by provider
   */
  async getModelsByProvider(provider: string): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.provider, provider), eq(modelConfig.isEnabled, true)))
      .orderBy(desc(modelConfig.priority));
  }

  /**
   * Register a new model
   */
  async registerModel(data: NewModelConfigEntry): Promise<ModelConfigEntry> {
    const result = await this.db.insert(modelConfig).values(data).returning();
    modelLogger.info({ model: data.name, provider: data.provider }, 'Model registered');

    // Non-blocking: flag likely-weak models (small local, known-unreliable id)
    // so ops sees it without a network probe gating the insert. Dynamic import
    // avoids a module cycle (capability-gate → conformance → litellm-client →
    // this registry).
    import('./capability-gate')
      .then(({ staticCapabilityWarnings }) => {
        const warnings = staticCapabilityWarnings(data, getConfig().orchestrator.routerSmallModelMaxParams);
        if (warnings.length > 0) {
          modelLogger.warn({ model: data.name, provider: data.provider, warnings }, 'Registered model may be unreliable for agent work');
        }
      })
      .catch((err) => modelLogger.debug({ err, model: data.name }, 'capability warning check skipped'));

    // Clear relevant caches
    await this.invalidateCache(data.name);

    return result[0];
  }

  /**
   * Update model configuration
   */
  async updateModel(name: string, data: Partial<NewModelConfigEntry>): Promise<ModelConfigEntry | null> {
    const result = await this.db
      .update(modelConfig)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(modelConfig.name, name))
      .returning();

    if (result[0]) {
      modelLogger.info({ model: name }, 'Model updated');
      await this.invalidateCache(name);
    }

    return result[0] ?? null;
  }

  /**
   * Enable/disable a model
   */
  async setModelEnabled(name: string, enabled: boolean): Promise<boolean> {
    const result = await this.db
      .update(modelConfig)
      .set({ isEnabled: enabled, updatedAt: new Date() })
      .where(eq(modelConfig.name, name))
      .returning();

    if (result.length > 0) {
      modelLogger.info({ model: name, enabled }, 'Model status changed');
      await this.invalidateCache(name);
      return true;
    }

    return false;
  }

  /**
   * Set a model as the default
   */
  async setDefaultModel(name: string): Promise<boolean> {
    // First, unset current default
    await this.db.update(modelConfig).set({ isDefault: false }).where(eq(modelConfig.isDefault, true));

    // Set new default
    const result = await this.db
      .update(modelConfig)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(modelConfig.name, name))
      .returning();

    if (result.length > 0) {
      modelLogger.info({ model: name }, 'Default model changed');
      await this.cacheDelete('model:default');
      return true;
    }

    return false;
  }

  /**
   * Get resolved capabilities for a model by name.
   * Returns null if the model does not exist.
   */
  async getModelCapabilities(name: string): Promise<ModelCapabilities | null> {
    const model = await this.getModel(name);
    if (!model) return null;
    return getCapabilitiesForModel(model);
  }

  /**
   * Delete a model configuration
   */
  async deleteModel(name: string): Promise<boolean> {
    const result = await this.db.delete(modelConfig).where(eq(modelConfig.name, name)).returning();

    if (result.length > 0) {
      modelLogger.info({ model: name }, 'Model deleted');
      await this.invalidateCache(name);
      return true;
    }

    return false;
  }

  /* Removed `initializeDefaultModels()` — it hardcoded model names
   * (gpt-4o, claude-3-5-sonnet-20241022, …), which violates the "no hardcoded
   * models" rule and would rot as models age. It was also dead code (no
   * callers). Fresh installs get their first model from `bootstrap-model.ts`
   * (user-chosen BOOTSTRAP_* env) and provider discovery / hwfit recommendations.
   */

  /**
   * Invalidate cache for a model
   */
  private async invalidateCache(name: string): Promise<void> {
    await this.cacheDelete(`model:${name}`);
    await this.cacheDelete('model:default');
    // Clear all topic caches. Built from the canonical single-model text-topic
    // set (the source of truth that includes memory_extraction / knowledge_review
    // / evaluation) plus the non-text model classes, so adding a topic in one
    // place keeps invalidation correct — previously this hardcoded list silently
    // omitted knowledge_review and evaluation, leaking their stale bindings.
    const topics = [...SINGLE_MODEL_CHAT_TOPICS, 'embedding', 'ocr', 'vision'];
    for (const topic of topics) {
      await this.cacheDelete(`model:topic:${topic}`);
      await this.cacheDelete(`model:topic:backup:${topic}`);
    }
  }
}

// Singleton instance
let registryInstance: ModelRegistry | null = null;

export function getModelRegistry(): ModelRegistry {
  if (!registryInstance) {
    registryInstance = new ModelRegistry();
  }
  return registryInstance;
}
