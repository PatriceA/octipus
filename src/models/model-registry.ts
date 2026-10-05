import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { Cache } from '@/db/cache';
import { type ModelConfigEntry, modelConfig, type NewModelConfigEntry, userModelBindings } from '@/db/schema/models';
import { getCapabilitiesForModel, type ModelCapabilities } from '@/models/capabilities';
import { SINGLE_MODEL_CHAT_TOPICS } from '@/models/single-model-binding';
import { canonicalTopic } from '@/models/topics';
import { getUserOrgIds } from '@/services/org-membership';
import { modelLogger } from '@/utils/logger';

const CACHE_TTL = 300; // 5 minutes

/**
 * Install-level rows only (coworking spec §8.1). A personal row
 * (`owner_user_id` set) belongs to one user: it is never a default, a topic
 * model, a fallback, or a member of an install-wide list, and it never enters a
 * global cache.
 */
const INSTALL_ROWS = isNull(modelConfig.ownerUserId);

/** Is this a personal (user-owned) row? */
export function isPersonalModel(row: Pick<ModelConfigEntry, 'ownerUserId'>): boolean {
  return row.ownerUserId != null;
}

export class ModelRegistry {
  // Resolve the live connection per access rather than snapshotting it at
  // construction: this is a process-global singleton, so a cached handle would
  // dangle after the socket is recycled (max_lifetime) or closed/reopened
  // between integration-test files, surfacing as CONNECTION_ENDED. getDb() is a
  // cheap `if (db) return db`.
  private get db() {
    return getDb();
  }
  private cache = new Cache(CACHE_TTL);

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
   * Get model configuration by name — the row identity (`name` is unique).
   * Used to re-read the row a request already resolved (`AgentContext.modelName`,
   * `CompletionOptions.modelConfigName`); a name a PERSON typed goes through
   * `resolveModel({ userId, name })`, which checks visibility. Personal rows are
   * read but never cached.
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
    if (model && !isPersonalModel(model)) {
      await this.cacheSet(`model:${name}`, model);
    }

    return model;
  }

  /**
   * Get model configuration by modelId (the provider-facing identifier).
   * `modelId` is not unique, so this is a fallback for callers that have no row
   * name: install rows first, then — only when `userId` is given — that user's
   * own personal rows. Another user's personal row is never returned.
   */
  async getModelByModelId(modelId: string, opts: { userId?: string } = {}): Promise<ModelConfigEntry | null> {
    const install = await this.getInstallModelByModelId(modelId);
    if (install || !opts.userId) return install;
    const own = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.modelId, modelId), eq(modelConfig.isEnabled, true), eq(modelConfig.ownerUserId, opts.userId)))
      .orderBy(asc(modelConfig.name))
      .limit(1);
    return own[0] ?? null;
  }

  private async getInstallModelByModelId(modelId: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cacheGet<ModelConfigEntry>(`model:mid:${modelId}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.modelId, modelId), eq(modelConfig.isEnabled, true), INSTALL_ROWS))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cacheSet(`model:mid:${modelId}`, model);
    }

    return model;
  }

  /**
   * The row `name` names when `userId` may use it: an install row (system-wide
   * or in one of the user's orgs) or the user's own personal row. Disabled rows
   * are returned too, so a caller can say "disabled" rather than "unknown".
   */
  async getModelVisibleTo(name: string, userId: string): Promise<ModelConfigEntry | null> {
    const rows = await this.db.select().from(modelConfig).where(eq(modelConfig.name, name)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return (await this.isVisibleTo(row, userId)) ? row : null;
  }

  /** Same as `getModelVisibleTo`, keyed by provider model id (install rows first). */
  async getModelByModelIdVisibleTo(modelId: string, userId: string): Promise<ModelConfigEntry | null> {
    const rows = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.modelId, modelId), or(INSTALL_ROWS, eq(modelConfig.ownerUserId, userId))))
      .orderBy(sql`${modelConfig.ownerUserId} IS NOT NULL`, desc(modelConfig.isEnabled), asc(modelConfig.name));
    for (const row of rows) {
      if (await this.isVisibleTo(row, userId)) return row;
    }
    return null;
  }

  private async isVisibleTo(row: ModelConfigEntry, userId: string): Promise<boolean> {
    if (row.ownerUserId) return row.ownerUserId === userId;
    if (!row.orgId) return true;
    return (await getUserOrgIds(userId)).includes(row.orgId);
  }

  /** Is there any row (any owner, enabled or not) whose name or modelId is `nameOrId`? */
  async isRegistered(nameOrId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: modelConfig.id })
      .from(modelConfig)
      .where(or(eq(modelConfig.name, nameOrId), eq(modelConfig.modelId, nameOrId)))
      .limit(1);
    return rows.length > 0;
  }

  /** Does `name` name a personal row (anyone's)? Used before passing an unknown name through to a provider. */
  async isPersonalModelName(name: string): Promise<boolean> {
    const rows = await this.db
      .select({ ownerUserId: modelConfig.ownerUserId })
      .from(modelConfig)
      .where(eq(modelConfig.name, name))
      .limit(1);
    return rows[0]?.ownerUserId != null;
  }

  /** The personal row a user bound to `topic` (canonical lane), or null. */
  async getUserBinding(userId: string, rawTopic: string): Promise<ModelConfigEntry | null> {
    const topic = canonicalTopic(rawTopic);
    const rows = await this.db
      .select({ model: modelConfig })
      .from(userModelBindings)
      .innerJoin(modelConfig, eq(modelConfig.name, userModelBindings.modelName))
      .where(and(
        eq(userModelBindings.userId, userId),
        eq(userModelBindings.topic, topic),
        eq(modelConfig.ownerUserId, userId),
        eq(modelConfig.isEnabled, true),
      ))
      .limit(1);
    return rows[0]?.model ?? null;
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
      .where(and(eq(modelConfig.isDefault, true), eq(modelConfig.isEnabled, true), INSTALL_ROWS))
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
   *
   * Retired topic values (old role topics like 'coding', per-feature background
   * topics like 'memory_extraction') are transparently canonicalized to their
   * lane ('agents' / 'background' / 'chat') — see RETIRED_TOPIC_ALIASES.
   */
  async getModelForTopic(rawTopic: string): Promise<ModelConfigEntry | null> {
    const topic = canonicalTopic(rawTopic);
    const cached = await this.cacheGet<ModelConfigEntry>(`model:topic:${topic}`);
    if (cached) return cached;

    // 1. Check topicRoles for 'primary'
    const primaryResult = await this.db
      .select()
      .from(modelConfig)
      .where(and(
        eq(modelConfig.isEnabled, true),
        INSTALL_ROWS,
        sql`${modelConfig.topicRoles}->>${topic} = 'primary'`,
      ))
      .limit(1);

    let model: ModelConfigEntry | null = primaryResult[0] ?? null;

    // 2. Fall back to legacy topics array + priority
    if (!model) {
      const legacyResult = await this.db
        .select()
        .from(modelConfig)
        .where(and(eq(modelConfig.isEnabled, true), INSTALL_ROWS, sql`${topic} = ANY(${modelConfig.topics})`))
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
   * Retired topic values are canonicalized like getModelForTopic.
   */
  async getBackupModelForTopic(rawTopic: string): Promise<ModelConfigEntry | null> {
    const topic = canonicalTopic(rawTopic);
    const cached = await this.cacheGet<ModelConfigEntry>(`model:topic:backup:${topic}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(
        eq(modelConfig.isEnabled, true),
        INSTALL_ROWS,
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
   * Get all enabled install-level models (personal rows excluded).
   */
  async getAllModels(): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.isEnabled, true), INSTALL_ROWS))
      .orderBy(desc(modelConfig.priority), asc(modelConfig.name));
  }

  /** Every install-level row, enabled or not — the admin registry (personal rows excluded). */
  async getAllModelsIncludeDisabled(): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .where(INSTALL_ROWS)
      .orderBy(desc(modelConfig.isEnabled), desc(modelConfig.priority), asc(modelConfig.name));
  }

  /**
   * List models visible to a specific user: system-wide install rows
   * (`org_id IS NULL`), org-scoped install rows of the user's orgs, and the
   * user's own personal rows. Enabled and disabled alike.
   */
  async getModelsForUser(userId: string): Promise<ModelConfigEntry[]> {
    const orgIds = await getUserOrgIds(userId);
    const orgVisible = orgIds.length > 0
      ? or(isNull(modelConfig.orgId), inArray(modelConfig.orgId, orgIds))
      : isNull(modelConfig.orgId);
    return this.db
      .select()
      .from(modelConfig)
      .where(or(and(INSTALL_ROWS, orgVisible), eq(modelConfig.ownerUserId, userId)))
      .orderBy(desc(modelConfig.isEnabled), desc(modelConfig.priority), asc(modelConfig.name));
  }

  /** A user's own personal rows. */
  async getPersonalModels(userId: string): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .where(eq(modelConfig.ownerUserId, userId))
      .orderBy(asc(modelConfig.name));
  }

  /**
   * Get install-level models by provider
   */
  async getModelsByProvider(provider: string): Promise<ModelConfigEntry[]> {
    return this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.provider, provider), eq(modelConfig.isEnabled, true), INSTALL_ROWS))
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
        const warnings = staticCapabilityWarnings(data, getConfig().agent.smallModelMaxParams);
        if (warnings.length > 0) {
          modelLogger.warn({ model: data.name, provider: data.provider, warnings }, 'Registered model may be unreliable for agent work');
        }
      })
      .catch((err) => modelLogger.debug({ err, model: data.name }, 'capability warning check skipped'));

    // Clear relevant caches
    await this.invalidateCache(data.name, data.modelId);

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
      await this.invalidateCache(name, result[0].modelId);
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
      await this.invalidateCache(name, result[0].modelId);
      return true;
    }

    return false;
  }

  /**
   * Set a model as the default
   */
  async setDefaultModel(name: string): Promise<boolean> {
    const [target] = await this.db.select({ ownerUserId: modelConfig.ownerUserId }).from(modelConfig).where(eq(modelConfig.name, name)).limit(1);
    if (target && isPersonalModel(target)) {
      throw new Error(`Model '${name}' is a personal model and cannot be the install default`);
    }
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
      await this.invalidateCache(name, result[0].modelId);
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
   * Invalidate cache for a model.
   * `modelId` (when known) clears the `model:mid:${modelId}` key that feeds
   * resolveProvider() — A7: without it a changed provider/apiKeyRef kept routing
   * to the old target for up to 5 min.
   */
  private async invalidateCache(name: string, modelId?: string | null): Promise<void> {
    await this.cacheDelete(`model:${name}`);
    if (modelId) await this.cacheDelete(`model:mid:${modelId}`);
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
