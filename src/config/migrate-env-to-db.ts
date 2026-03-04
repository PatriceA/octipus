import { getSettingsService } from './settings-service';
import { SETTINGS_REGISTRY } from './settings-registry';
import { getVault } from '@/security/vault';
import { logger } from '@/utils/logger';

const MIGRATION_SENTINEL = '_system.envMigrated';

/**
 * One-time migration: read existing .env values and store them in the
 * settings table (non-secrets) and vault (secrets).
 *
 * Idempotent: skips keys that already exist in DB/vault, and marks
 * completion with a sentinel so it doesn't re-run on subsequent boots.
 */
export async function migrateEnvToDb(): Promise<void> {
  const svc = getSettingsService();

  // Check if migration already ran
  const migrated = await svc.get(MIGRATION_SENTINEL);
  if (migrated) {
    logger.debug('Env-to-DB migration already completed, skipping');
    return;
  }

  logger.info('Migrating .env settings to database and vault...');
  let migratedCount = 0;

  for (const def of SETTINGS_REGISTRY) {
    if (!def.envVar) continue;

    const envValue = process.env[def.envVar];
    if (!envValue || envValue.trim() === '') continue;

    try {
      if (def.isSecret && def.vaultName) {
        // Store secret in vault
        const vault = getVault();
        const existing = await vault.getSystemSecret(def.vaultName);
        if (existing === null) {
          await vault.setSystemSecret(def.vaultName, envValue, {
            description: `Auto-migrated from ${def.envVar}`,
            tags: ['system', 'auto-migrated'],
          });
          logger.info({ key: def.key, envVar: def.envVar }, 'Migrated secret to vault');
          migratedCount++;
        }
      } else {
        // Store non-secret in settings table
        const existing = await svc.get(def.key);
        // Only migrate if the current value is still the default
        const isDefault = existing === def.defaultValue ||
          (typeof existing === 'string' && existing === '') ||
          existing === null ||
          existing === undefined;

        if (isDefault) {
          // Coerce value to correct type
          let typedValue: unknown = envValue;
          switch (def.valueType) {
            case 'number':
              typedValue = Number(envValue);
              break;
            case 'boolean':
              typedValue = envValue === 'true' || envValue === '1';
              break;
            case 'string_array':
              typedValue = envValue.split(',').filter(Boolean);
              break;
          }

          await svc.set(def.key, typedValue, 'system');
          logger.info({ key: def.key, envVar: def.envVar }, 'Migrated setting to DB');
          migratedCount++;
        }
      }
    } catch (error) {
      logger.warn({ error, key: def.key, envVar: def.envVar }, 'Failed to migrate setting');
    }
  }

  // Mark migration as complete
  await svc.set(MIGRATION_SENTINEL, new Date().toISOString(), 'system');

  logger.info({ migratedCount }, 'Env-to-DB migration complete');
}
