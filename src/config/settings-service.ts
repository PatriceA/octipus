import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { RedisCache, RedisPubSub } from '@/db/redis';
import { type SettingEntry, settings } from '@/db/schema/settings';
import { logger } from '@/utils/logger';
import { getSettingDefinition, SETTINGS_REGISTRY, type SettingValueType } from './settings-registry';

const PUBSUB_CHANNEL = 'settings:changed';
const CACHE_TTL = 60; // seconds

export interface SettingChangeEvent {
  key: string;
  value: unknown;
  oldValue: unknown;
  updatedBy?: string;
}

type ChangeHandler = (key: string, value: unknown, oldValue: unknown) => void;

export class SettingsService {
  private cache: RedisCache;
  private pubsub: RedisPubSub;
  private localCache: Map<string, unknown> = new Map();
  private changeHandlers: Set<ChangeHandler> = new Set();
  private initialized = false;

  constructor() {
    this.cache = new RedisCache(CACHE_TTL);
    this.pubsub = new RedisPubSub();
  }

  /**
   * Initialize the settings service: warm cache and subscribe to changes.
   * Must be called after DB and Redis are available.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.warmCache();

    // Subscribe to cross-instance change notifications
    await this.pubsub.subscribe(PUBSUB_CHANNEL, (message: unknown) => {
      const event = message as SettingChangeEvent;
      if (event?.key) {
        this.localCache.set(event.key, event.value);
        this.notifyHandlers(event.key, event.value, event.oldValue);
      }
    });

    this.initialized = true;
    logger.info('Settings service initialized');
  }

  /**
   * Load all settings from DB into local + Redis cache
   */
  async warmCache(): Promise<void> {
    const db = getDb();
    const rows = await db.select().from(settings);

    for (const row of rows) {
      const value = this.deserialize(row.value, row.valueType as SettingValueType);
      this.localCache.set(row.key, value);
      await this.cache.set(`settings:${row.key}`, value, CACHE_TTL);
    }

    // Fill defaults for keys not yet in DB
    for (const def of SETTINGS_REGISTRY) {
      if (!this.localCache.has(def.key)) {
        this.localCache.set(def.key, def.defaultValue);
      }
    }

    logger.debug({ count: rows.length }, 'Settings cache warmed');
  }

  /**
   * Get a setting value. Returns from local cache (fastest), falls back to Redis, then DB.
   * For secret settings, returns the vault reference name (not the decrypted secret).
   * Use getSecret() to get the actual decrypted value for secrets.
   */
  async get(key: string): Promise<unknown> {
    // Local cache first
    if (this.localCache.has(key)) {
      return this.localCache.get(key);
    }

    // Redis cache
    const cached = await this.cache.get<unknown>(`settings:${key}`);
    if (cached !== null) {
      this.localCache.set(key, cached);
      return cached;
    }

    // DB
    const db = getDb();
    const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (row) {
      const value = this.deserialize(row.value, row.valueType as SettingValueType);
      this.localCache.set(key, value);
      await this.cache.set(`settings:${key}`, value, CACHE_TTL);
      return value;
    }

    // Fall back to registry default
    const def = getSettingDefinition(key);
    return def?.defaultValue ?? null;
  }

  /**
   * Get a setting value synchronously from local cache.
   * Returns undefined if not cached. Use after warmCache().
   */
  getSync(key: string): unknown {
    if (this.localCache.has(key)) {
      return this.localCache.get(key);
    }
    const def = getSettingDefinition(key);
    return def?.defaultValue;
  }

  /**
   * Get multiple settings at once
   */
  async getMany(keys: string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = await this.get(key);
    }
    return result;
  }

  /**
   * Get all settings for a category
   */
  async getByCategory(category: string): Promise<Record<string, unknown>> {
    const defs = SETTINGS_REGISTRY.filter(d => d.category === category);
    const result: Record<string, unknown> = {};
    for (const def of defs) {
      result[def.key] = await this.get(def.key);
    }
    return result;
  }

  /**
   * Set a setting value. Validates type, writes to DB, invalidates cache, notifies subscribers.
   */
  async set(key: string, value: unknown, userId?: string): Promise<void> {
    const def = getSettingDefinition(key);
    if (def) {
      this.validateType(value, def.valueType);
    }

    const oldValue = await this.get(key);
    const serialized = this.serialize(value);
    const valueType = def?.valueType || 'string';

    const db = getDb();

    // Upsert
    const [existing] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);

    if (existing) {
      await db.update(settings)
        .set({
          value: serialized,
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({
        key,
        value: serialized,
        valueType,
        category: def?.category || 'general',
        description: def?.description,
        defaultValue: def ? this.serialize(def.defaultValue) : undefined,
        isSecret: def?.isSecret || false,
        updatedBy: userId,
      });
    }

    // Update caches
    this.localCache.set(key, value);
    await this.cache.set(`settings:${key}`, value, CACHE_TTL);

    // Notify other instances via pub/sub
    const event: SettingChangeEvent = { key, value, oldValue, updatedBy: userId };
    await this.pubsub.publish(PUBSUB_CHANNEL, event);

    // Notify local handlers (pub/sub also fires locally, but we call explicitly for immediate effect)
    this.notifyHandlers(key, value, oldValue);

    logger.info({ key, category: def?.category, updatedBy: userId }, 'Setting updated');
  }

  /**
   * Set multiple settings atomically
   */
  async setMany(entries: Record<string, unknown>, userId?: string): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.set(key, value, userId);
    }
  }

  /**
   * Delete a setting (revert to default)
   */
  async delete(key: string): Promise<void> {
    const db = getDb();
    await db.delete(settings).where(eq(settings.key, key));

    const def = getSettingDefinition(key);
    const oldValue = this.localCache.get(key);

    this.localCache.delete(key);
    await this.cache.delete(`settings:${key}`);

    if (def) {
      await this.pubsub.publish(PUBSUB_CHANNEL, {
        key,
        value: def.defaultValue,
        oldValue,
      });
    }
  }

  /**
   * Reset a setting to its registry default value
   */
  async reset(key: string, userId?: string): Promise<void> {
    const def = getSettingDefinition(key);
    if (!def) {
      throw new Error(`Unknown setting key: ${key}`);
    }
    await this.set(key, def.defaultValue, userId);
  }

  /**
   * List all settings with metadata
   */
  async listAll(): Promise<SettingEntry[]> {
    const db = getDb();
    return db.select().from(settings);
  }

  /**
   * Subscribe to setting changes
   */
  onChange(handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  private notifyHandlers(key: string, value: unknown, oldValue: unknown): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(key, value, oldValue);
      } catch (error) {
        logger.error({ error, key }, 'Settings change handler error');
      }
    }
  }

  private serialize(value: unknown): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  private deserialize(raw: string, valueType: SettingValueType): unknown {
    switch (valueType) {
      case 'number':
        return Number(raw);
      case 'boolean':
        return raw === 'true' || raw === '1';
      case 'string_array':
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : raw.split(',').filter(Boolean);
        } catch {
          return raw.split(',').filter(Boolean);
        }
      case 'json':
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      case 'string':
      default:
        return raw;
    }
  }

  private validateType(value: unknown, valueType: SettingValueType): void {
    switch (valueType) {
      case 'number':
        if (typeof value !== 'number' || !isFinite(value)) {
          throw new Error(`Expected number, got ${typeof value}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`Expected boolean, got ${typeof value}`);
        }
        break;
      case 'string_array':
        if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
          throw new Error('Expected array of strings');
        }
        break;
      case 'json':
        // Any JSON-serializable value is fine
        break;
      case 'string':
        if (typeof value !== 'string') {
          throw new Error(`Expected string, got ${typeof value}`);
        }
        break;
    }
  }
}

// Singleton
let instance: SettingsService | null = null;

export function getSettingsService(): SettingsService {
  if (!instance) {
    instance = new SettingsService();
  }
  return instance;
}

export function resetSettingsService(): void {
  instance = null;
}
