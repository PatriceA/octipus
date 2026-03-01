import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { modelConfig, type ModelConfigEntry, type NewModelConfigEntry } from '@/db/schema/models';
import { RedisCache } from '@/db/redis';
import { getConfig } from '@/config';
import { modelLogger } from '@/utils/logger';

const CACHE_TTL = 300; // 5 minutes

export class ModelRegistry {
  private db = getDb();
  private cache = new RedisCache(CACHE_TTL);

  /**
   * Get model configuration by name
   */
  async getModel(name: string): Promise<ModelConfigEntry | null> {
    // Check cache first
    const cached = await this.cache.get<ModelConfigEntry>(`model:${name}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.name, name), eq(modelConfig.isEnabled, true)))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cache.set(`model:${name}`, model);
    }

    return model;
  }

  /**
   * Get model configuration by modelId (the LiteLLM-facing identifier)
   */
  async getModelByModelId(modelId: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cache.get<ModelConfigEntry>(`model:mid:${modelId}`);
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.modelId, modelId), eq(modelConfig.isEnabled, true)))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cache.set(`model:mid:${modelId}`, model);
    }

    return model;
  }

  /**
   * Get the default model
   */
  async getDefaultModel(): Promise<ModelConfigEntry | null> {
    const cached = await this.cache.get<ModelConfigEntry>('model:default');
    if (cached) return cached;

    const result = await this.db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.isDefault, true), eq(modelConfig.isEnabled, true)))
      .limit(1);

    const model = result[0] ?? null;
    if (model) {
      await this.cache.set('model:default', model);
    }

    return model;
  }

  /**
   * Get model for a specific topic.
   * Priority: topicRoles primary → topicRoles backup → legacy topics+priority → default
   */
  async getModelForTopic(topic: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cache.get<ModelConfigEntry>(`model:topic:${topic}`);
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

    // 3. Fall back to default
    if (!model) {
      model = await this.getDefaultModel();
    }

    if (model) {
      await this.cache.set(`model:topic:${topic}`, model);
    }

    return model;
  }

  /**
   * Get backup model for a topic (for fallback on rate limit/error).
   */
  async getBackupModelForTopic(topic: string): Promise<ModelConfigEntry | null> {
    const cached = await this.cache.get<ModelConfigEntry>(`model:topic:backup:${topic}`);
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
      await this.cache.set(`model:topic:backup:${topic}`, model);
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
      .orderBy(desc(modelConfig.priority));
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
      await this.cache.delete('model:default');
      return true;
    }

    return false;
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

  /**
   * Initialize default models from config
   */
  async initializeDefaultModels(): Promise<void> {
    const config = getConfig();

    const defaultModels: NewModelConfigEntry[] = [
      {
        name: 'gpt-4o',
        provider: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 4096,
        contextWindow: 128000,
        supportsVision: true,
        supportsTools: true,
        supportsStreaming: true,
        defaultTemperature: 0.7,
        topics: ['coding', 'analysis', 'general'],
        priority: 100,
        costPerInputToken: 2.5, // per 1M tokens
        costPerOutputToken: 10,
        isEnabled: true,
        isDefault: true,
      },
      {
        name: 'gpt-4o-mini',
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        maxTokens: 4096,
        contextWindow: 128000,
        supportsVision: true,
        supportsTools: true,
        supportsStreaming: true,
        defaultTemperature: 0.7,
        topics: ['chat', 'simple'],
        priority: 50,
        costPerInputToken: 0.15,
        costPerOutputToken: 0.6,
        isEnabled: true,
        isDefault: false,
      },
      {
        name: 'claude-3-5-sonnet',
        provider: 'anthropic',
        modelId: 'claude-3-5-sonnet-20241022',
        maxTokens: 8192,
        contextWindow: 200000,
        supportsVision: true,
        supportsTools: true,
        supportsStreaming: true,
        defaultTemperature: 0.7,
        topics: ['coding', 'analysis'],
        priority: 90,
        costPerInputToken: 3,
        costPerOutputToken: 15,
        isEnabled: true,
        isDefault: false,
      },
      {
        name: 'llama3.2',
        provider: 'ollama',
        modelId: 'llama3.2',
        endpoint: config.ollama.url,
        maxTokens: 4096,
        contextWindow: 128000,
        supportsVision: false,
        supportsTools: true,
        supportsStreaming: true,
        defaultTemperature: 0.7,
        topics: ['local', 'chat'],
        priority: 30,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        isEnabled: true,
        isDefault: false,
      },
      {
        name: 'text-embedding-3-small',
        provider: 'openai',
        modelId: 'text-embedding-3-small',
        maxTokens: 8191,
        contextWindow: 8191,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: false,
        topics: ['embedding'],
        priority: 100,
        costPerInputToken: 0.02,
        costPerOutputToken: 0,
        isEnabled: true,
        isDefault: false,
      },
      // CLI subscription models (free tokens from subscriptions)
      {
        name: 'cli/claude-code',
        provider: 'cli',
        modelId: 'cli/claude-code',
        maxTokens: 16384,
        contextWindow: 200000,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: false,
        topics: ['coding', 'analysis'],
        priority: 80,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        isEnabled: config.cliModels?.enabled !== false,
        isDefault: false,
        metadata: { description: 'Claude Code CLI (subscription)' },
      },
      {
        name: 'cli/gemini-cli',
        provider: 'cli',
        modelId: 'cli/gemini-cli',
        maxTokens: 8192,
        contextWindow: 1000000,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: false,
        topics: ['coding', 'analysis', 'general'],
        priority: 75,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        isEnabled: config.cliModels?.enabled !== false,
        isDefault: false,
        metadata: { description: 'Gemini CLI (subscription)' },
      },
      {
        name: 'cli/codex-cli',
        provider: 'cli',
        modelId: 'cli/codex-cli',
        maxTokens: 4096,
        contextWindow: 128000,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: false,
        topics: ['coding'],
        priority: 70,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        isEnabled: false, // Disabled by default since codex may not be installed
        isDefault: false,
        metadata: { description: 'Codex CLI (subscription)' },
      },
    ];

    for (const model of defaultModels) {
      // Check existence regardless of isEnabled status
      const existing = await this.db
        .select({ name: modelConfig.name })
        .from(modelConfig)
        .where(eq(modelConfig.name, model.name))
        .limit(1);
      if (existing.length === 0) {
        await this.registerModel(model);
      }
    }

    modelLogger.info({ count: defaultModels.length }, 'Default models initialized');
  }

  /**
   * Invalidate cache for a model
   */
  private async invalidateCache(name: string): Promise<void> {
    await this.cache.delete(`model:${name}`);
    await this.cache.delete('model:default');
    // Clear all topic caches (simplified - in production you'd track these)
    const topics = ['coding', 'analysis', 'chat', 'general', 'embedding', 'local', 'simple', 'research'];
    for (const topic of topics) {
      await this.cache.delete(`model:topic:${topic}`);
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
