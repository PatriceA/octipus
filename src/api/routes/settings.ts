import { Elysia, t } from 'elysia';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { apiContext } from '@/api/context';
import {
  getCategories,
  getSettingDefinition,
  getSettingsByCategory,
  SETTINGS_REGISTRY,
} from '@/config/settings-registry';
import { getSettingsService } from '@/config/settings-service';
import { auditRepository } from '@/db/repositories/audit-repository';
import { getVault } from '@/security/vault';
import { apiLogger } from '@/utils/logger';

export const settingsRoutes = new Elysia({ prefix: '/settings' })
  .use(apiContext)

  // List all settings grouped by category (secrets masked)
  .get(
    '/',
    async ({ user }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const svc = getSettingsService();
      const categories = getCategories();
      const grouped: Record<string, Array<{
        key: string;
        value: unknown;
        valueType: string;
        description: string;
        defaultValue: unknown;
        isSecret: boolean;
        category: string;
      }>> = {};

      for (const category of categories) {
        const defs = getSettingsByCategory(category);
        grouped[category] = [];

        for (const def of defs) {
          let value: unknown;

          if (def.isSecret && def.vaultName) {
            // Check if secret exists in vault (don't return actual value)
            const vault = getVault();
            const secret = await vault.getSystemSecret(def.vaultName);
            value = secret ? '••••••••' : '';
          } else {
            value = await svc.get(def.key);
          }

          grouped[category].push({
            key: def.key,
            value,
            valueType: def.valueType,
            description: def.description,
            defaultValue: def.defaultValue,
            isSecret: def.isSecret,
            category: def.category,
          });
        }
      }

      return { settings: grouped, categories };
    },
    { detail: { tags: ['settings'] } }
  )

  // Get settings for a specific category
  .get(
    '/category/:category',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const svc = getSettingsService();
      const defs = getSettingsByCategory(params.category);

      if (defs.length === 0) {
        return { error: `Unknown category: ${params.category}` };
      }

      const settings = [];
      for (const def of defs) {
        let value: unknown;
        if (def.isSecret && def.vaultName) {
          const vault = getVault();
          const secret = await vault.getSystemSecret(def.vaultName);
          value = secret ? '••••••••' : '';
        } else {
          value = await svc.get(def.key);
        }

        settings.push({
          key: def.key,
          value,
          valueType: def.valueType,
          description: def.description,
          defaultValue: def.defaultValue,
          isSecret: def.isSecret,
        });
      }

      return { category: params.category, settings };
    },
    { detail: { tags: ['settings'] } }
  )

  // Get full registry metadata (for UI rendering)
  .get(
    '/registry',
    async ({ user }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      return {
        registry: SETTINGS_REGISTRY.map(def => ({
          key: def.key,
          category: def.category,
          valueType: def.valueType,
          defaultValue: def.defaultValue,
          description: def.description,
          isSecret: def.isSecret,
        })),
        categories: getCategories(),
      };
    },
    { detail: { tags: ['settings'] } }
  )

  // Update a single setting
  .put(
    '/:key',
    async ({ user, params, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const { key } = params;
      const { value } = body as { value: unknown };
      const def = getSettingDefinition(key);

      if (!def) {
        return { error: `Unknown setting: ${key}` };
      }

      // Validate workspace paths before saving
      if (key === 'workspace.rootPath' && typeof value === 'string') {
        const resolved = resolve(value);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          return { error: `Invalid path: ${value} (does not exist or is not a directory)` };
        }
      }

      try {
        if (def.isSecret && def.vaultName) {
          // Store secret in vault
          if (typeof value !== 'string') {
            return { error: 'Secret value must be a string' };
          }
          const vault = getVault();
          await vault.setSystemSecret(def.vaultName, value, {
            description: def.description,
            tags: ['system', 'settings-ui'],
          });

          // Also update settings service to trigger hot-reload
          const svc = getSettingsService();
          await svc.set(key, def.vaultName, user.id);
        } else {
          const svc = getSettingsService();
          await svc.set(key, value, user.id);
        }

        await auditRepository.log({
          userId: user.id,
          action: 'settings_changed',
          resourceType: 'setting',
          resourceId: key,
          details: { key, isSecret: def.isSecret },
        });

        return { success: true, key };
      } catch (error: any) {
        apiLogger.error({ error, key }, 'Failed to update setting');
        return { error: error.message || 'Failed to update setting' };
      }
    },
    {
      body: t.Object({ value: t.Unknown() }),
      detail: { tags: ['settings'] },
    }
  )

  // Batch update multiple settings
  .put(
    '/batch',
    async ({ user, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const { settings } = body as { settings: Record<string, unknown> };
      const svc = getSettingsService();
      const vault = getVault();
      const errors: Record<string, string> = {};
      const updated: string[] = [];

      for (const [key, value] of Object.entries(settings)) {
        const def = getSettingDefinition(key);
        if (!def) {
          errors[key] = `Unknown setting: ${key}`;
          continue;
        }

        try {
          if (def.isSecret && def.vaultName) {
            if (typeof value !== 'string') {
              errors[key] = 'Secret value must be a string';
              continue;
            }
            await vault.setSystemSecret(def.vaultName, value, {
              description: def.description,
              tags: ['system', 'settings-ui'],
            });
            await svc.set(key, def.vaultName, user.id);
          } else {
            await svc.set(key, value, user.id);
          }
          updated.push(key);
        } catch (error: any) {
          errors[key] = error.message;
        }
      }

      if (updated.length > 0) {
        await auditRepository.log({
          userId: user.id,
          action: 'settings_changed',
          resourceType: 'setting',
          resourceId: 'batch',
          details: { keys: updated, errorCount: Object.keys(errors).length },
        });
      }

      return { updated, errors: Object.keys(errors).length > 0 ? errors : undefined };
    },
    {
      body: t.Object({ settings: t.Record(t.String(), t.Unknown()) }),
      detail: { tags: ['settings'] },
    }
  )

  // Reset a setting to its default value
  .post(
    '/:key/reset',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const def = getSettingDefinition(params.key);
      if (!def) {
        return { error: `Unknown setting: ${params.key}` };
      }

      try {
        const svc = getSettingsService();
        await svc.reset(params.key, user.id);

        // If secret, also remove from vault
        if (def.isSecret && def.vaultName) {
          // We don't delete vault entries on reset — just leave them
          // The empty default means "not configured"
        }

        await auditRepository.log({
          userId: user.id,
          action: 'settings_changed',
          resourceType: 'setting',
          resourceId: params.key,
          details: { action: 'reset', key: params.key },
        });

        return { success: true, key: params.key, value: def.defaultValue };
      } catch (error: any) {
        return { error: error.message };
      }
    },
    { detail: { tags: ['settings'] } }
  )

  // Check setup status
  .get(
    '/setup-status',
    async () => {
      const svc = getSettingsService();
      const setupComplete = await svc.get('_system.setupComplete');
      return { setupComplete: !!setupComplete };
    },
    { detail: { tags: ['settings'] } }
  )

  // Mark setup as complete
  .post(
    '/setup-complete',
    async ({ user }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const svc = getSettingsService();
      await svc.set('_system.setupComplete', new Date().toISOString(), user.id);
      return { success: true };
    },
    { detail: { tags: ['settings'] } }
  );
