import { requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { executionEnvironmentSchema, executionEnvironmentsSchema } from '@/shared/execution-environment';
import { realpathSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { getConfig } from '@/config';
import { discoverCliKubeconfigs, inspectCliKubeconfig, type CliKubeconfig } from '@/security/cli-kubeconfig';
import { discoverCliRuntimes, inspectCliRuntime, type CliRuntime } from '@/security/cli-runtimes';
import { Elysia, t } from '@/api/http';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { apiContext } from '@/api/context';
import { getFieldConstraints } from '@/config/schema-introspect';
import {
  getCategories,
  getSettingDefinition,
  getSettingsByCategory,
  SETTINGS_REGISTRY,
} from '@/config/settings-registry';
import { MODULES_SETTING } from '@/core/modules/registry';
import { getSettingsService } from '@/config/settings-service';
import { auditRepository } from '@/db/repositories/audit-repository';
import { getVault } from '@/security/vault';
import { apiLogger } from '@/utils/logger';

/**
 * Modules are switched through `/api/modules` (docs/MODULES.md), which
 * follows their dependencies; written here, a reset would switch off every
 * module of an install at once.
 */
const MODULES_ELSEWHERE = 'Modules are switched in Settings → Modules (PUT /api/modules/:id)';

export const settingsRoutes = new Elysia({ prefix: '/settings' })
  .use(apiContext)

  .get('/execution-environments', async ({ user, principal, set }) => {
    if (!user?.isAdmin || !requireScope(principal, API_SCOPES.READ)) { set.status = 403; return { error: 'Admin access required' }; }
    const environments = executionEnvironmentsSchema.parse(await getSettingsService().get('security.executionEnvironments') ?? []);
    const credentials = (await getVault().list(user.id)).filter(entry => entry.credentialType !== 'login').map(entry => ({ name: entry.name, runtimeAllowed: !entry.allowedAgents?.length && (!entry.allowedTools?.length || entry.allowedTools.includes('execution-environment')) }));
    return { environments: environments.filter(entry => entry.userId === user.id), credentials, userId: user.id, machine: hostname(), account: userInfo().username,
      legacy: { sandbox: getConfig().security.shellSandbox, cliTools: getConfig().security.cliRuntimes, kubeconfigs: getConfig().security.cliKubeconfigs.filter(entry => entry.userId === user.id),
        note: 'Existing settings remain active for sessions without a configured environment.' } };
  })
  .put('/execution-environments/:id', async ({ user, principal, params, body, set }) => {
    if (!user?.isAdmin || !requireScope(principal, API_SCOPES.ADMIN)) { set.status = 403; return { error: 'Admin access required' }; }
    try {
      const profile = executionEnvironmentSchema.parse(body);
      if (profile.id !== params.id || profile.userId !== user.id) throw new Error('Choose your own account and the matching environment ID');
      if (profile.enabled && profile.workspaceId) {
        const { getDb } = await import('@/db/postgres');
        const { workspaces } = await import('@/db/schema/organizations');
        const { eq } = await import('drizzle-orm');
        const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, profile.workspaceId));
        if (!workspace || workspace.userId !== user.id || workspace.kind !== 'personal') throw new Error('Choose your own personal workspace');
      }
      if (profile.enabled && profile.backend !== 'ssh') profile.roots = [...new Set(profile.roots.map(root => {
        const path = realpathSync(root); if (!statSync(path).isDirectory()) throw new Error('Choose existing project folders'); return path;
      }))];
      const secrets = await getVault().list(user.id);
      for (const binding of profile.enabled ? profile.credentials : []) {
        const secret = secrets.find(entry => entry.name === binding.secret && entry.workspaceId === profile.workspaceId) ?? secrets.find(entry => entry.name === binding.secret && entry.workspaceId === null && entry.scope === 'user');
        if (!secret || secret.credentialType === 'login' || secret.allowedAgents?.length || (secret.allowedTools?.length && !secret.allowedTools.includes('execution-environment'))) throw new Error(`Secret ${binding.secret} is unavailable for execution environments. Allow it in Secrets first.`);
      }
      let savedProfile = profile;
      await getSettingsService().update('security.executionEnvironments', current => {
        const entries = (current ?? []) as Array<{ id: string; revision?: number; userId: string }>;
        const previous = entries.find(entry => entry.id === profile.id);
        if (previous && previous.userId !== user.id) throw new Error('Environment belongs to another account');
        if (previous && (previous.revision ?? 0) !== profile.revision) throw new Error('Environment changed. Refresh before saving.');
        savedProfile = { ...profile, revision: (previous?.revision ?? 0) + 1 };
        const retained = entries.filter(entry => entry.id !== profile.id).map(entry => profile.enabled && profile.isDefault && entry.userId === profile.userId && (entry as { workspaceId?: string | null }).workspaceId === profile.workspaceId
          ? { ...entry, isDefault: false } : entry);
        return executionEnvironmentsSchema.parse([...retained, savedProfile]);
      }, user.id);
      await auditRepository.log({ userId: user.id, action: 'settings_changed', resourceType: 'execution_environment', resourceId: profile.id,
        details: { backend: profile.backend, roots: profile.roots, approval: profile.approval, background: profile.background, hostIdentity: profile.hostIdentity } });
      return { environment: savedProfile };
    } catch (error) { set.status = 400; return { error: error instanceof Error ? error.message : 'Invalid environment' }; }
  }, { body: t.Record(t.String(), t.Unknown()) })
  .delete('/execution-environments/:id', async ({ user, principal, params, set }) => {
    if (!user?.isAdmin || !requireScope(principal, API_SCOPES.ADMIN)) { set.status = 403; return { error: 'Admin access required' }; }
    await getSettingsService().update('security.executionEnvironments', current => ((current ?? []) as Array<{ id: string; userId: string }>).filter(entry => entry.id !== params.id || entry.userId !== user.id), user.id);
    await auditRepository.log({ userId: user.id, action: 'settings_changed', resourceType: 'execution_environment', resourceId: params.id, details: { operation: 'remove' } });
    return { success: true };
  })
  .post('/execution-environments/:id/test', async ({ user, principal, params, body, set }) => {
    if (!user?.isAdmin || !requireScope(principal, API_SCOPES.ADMIN)) { set.status = 403; return { error: 'Admin access required' }; }
    const profiles = executionEnvironmentsSchema.parse(await getSettingsService().get('security.executionEnvironments') ?? []);
    const profile = profiles.find(entry => entry.id === params.id && entry.userId === user.id);
    if (!profile?.enabled) { set.status = 404; return { error: 'Enabled environment not found' }; }
    return (await import('@/security/environment-readiness')).checkEnvironmentReadiness(profile, body.command);
  }, { body: t.Object({ command: t.Optional(t.String({ maxLength: 4000 })) }) })

  .get('/companion-maintenance', async ({ user, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    const { companionMaintenanceSchema } = await import('@/shared/companion-maintenance');
    return { runtime: companionMaintenanceSchema.parse(await getSettingsService().get('security.companionMaintenance') ?? {}), userId: user.id };
  })
  .put('/companion-maintenance', async ({ user, body, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    try {
      const { companionMaintenanceSchema } = await import('@/shared/companion-maintenance');
      const { realpathSync } = await import('node:fs');
      const runtime = companionMaintenanceSchema.parse({ ...body, userId: user.id });
      runtime.roots = [...new Set(runtime.roots.map(path => { const root = realpathSync(path); if (!statSync(root).isDirectory()) throw new Error('Choose existing maintenance directories'); return root; }))];
      await getSettingsService().set('security.companionMaintenance', runtime, user.id);
      await auditRepository.log({ userId: user.id, action: 'settings_changed', resourceType: 'setting', resourceId: 'security.companionMaintenance', details: { enabled: runtime.enabled, roots: runtime.roots, hostServices: runtime.hostServices, sshAgent: runtime.sshAgent, allowActivation: runtime.allowActivation } });
      return { runtime, userId: user.id };
    } catch { set.status = 400; return { error: 'Choose valid existing directories and runtime options' }; }
  }, { body: t.Record(t.String(), t.Unknown()) })
  .post('/companion-maintenance/test', async ({ user, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    try {
      const { maintenanceRuntime } = await import('@/core/companion/maintenance');
      const runtime = maintenanceRuntime({ userId: user.id, workspaceId: user.id });
      const { LocalShellOperations } = await import('@/tools/shell/local-operations');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const code = 'const fs=require("node:fs");const p=require("node:path").join(process.argv[1],".companion-probe-"+process.pid);fs.writeFileSync(p,"probe",{flag:"wx",mode:384});fs.unlinkSync(p);process.stdout.write("runtime-write-ok")';
      const result = await new LocalShellOperations().exec(`${quote(process.execPath)} -e ${quote(code)} ${quote(runtime.roots[0])}`, runtime.roots[0], {
        timeout: 10000, allowedCwdRoots: runtime.roots, extraReadWrite: runtime.roots, extraReadOnly: [process.execPath], allowNetwork: runtime.hostServices, allowHostUsb: runtime.hostServices, allowHostSshAgent: runtime.sshAgent,
      });
      return { passed: result.exitCode === 0 && !result.killed, exitCode: result.exitCode,
        summary: result.exitCode === 0 ? 'Maintenance runtime launched and wrote to the approved directory.' : 'Maintenance runtime failed its write probe. Inspect server sandbox configuration.',
        capabilities: { hostServices: runtime.hostServices, sshAgent: runtime.sshAgent, activation: runtime.allowActivation } };
    } catch { set.status = 400; return { error: 'Maintenance runtime is unavailable; check saved scope and host prerequisites' }; }
  })
  .get('/cli-tools', async ({ user, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    const approved = (await getSettingsService().get('security.cliRuntimes') ?? []) as CliRuntime[];
    const tools = approved.map(tool => {
      try {
        const current = inspectCliRuntime(tool.path);
        return { ...tool, available: current.name === tool.name && current.resolvedPath === tool.resolvedPath };
      } catch { return { ...tool, available: false }; }
    });
    const identities = (await getSettingsService().get('security.cliKubeconfigs') ?? []) as CliKubeconfig[];
    const own = identities.find(entry => entry.userId === user.id);
    return { approved: tools, discovered: discoverCliRuntimes(), kubeconfig: own ? { path: own.path, context: own.context } : null, kubeconfigCandidates: discoverCliKubeconfigs() };
  })
  .put('/cli-tools-kubeconfig', async ({ user, body, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    try {
      const selected = body.path === null ? null : inspectCliKubeconfig(body.path);
      await getSettingsService().update('security.cliKubeconfigs', current => {
        const entries = ((current ?? []) as CliKubeconfig[]).filter(entry => entry.userId !== user.id);
        return selected ? [...entries, { ...selected, userId: user.id }] : entries;
      }, user.id);
      await auditRepository.log({ userId: user.id, action: 'settings_changed', resourceType: 'setting', resourceId: 'security.cliKubeconfigs', details: { operation: selected ? 'approve' : 'remove', path: selected?.path, context: selected?.context } });
      return { success: true, kubeconfig: selected ? { path: selected.path, context: selected.context } : null };
    } catch { set.status = 400; return { error: 'Could not select kubeconfig. Choose a readable, complete kubeconfig with embedded credentials and certificate data.' }; }
  }, { body: t.Object({ path: t.Union([t.String(), t.Null()]) }) })
  .put('/cli-tools/:name', async ({ user, params, body, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    try {
      const tool = inspectCliRuntime(body.path);
      if (tool.name !== params.name) throw new Error('Command name must match the executable filename.');
      const svc = getSettingsService();
      await svc.update('security.cliRuntimes', current => [...((current ?? []) as CliRuntime[]).filter(entry => entry.name !== tool.name), tool], user.id);
      await auditRepository.log({ userId: user.id, action: 'settings_changed', resourceType: 'setting', resourceId: 'security.cliRuntimes', details: { operation: 'approve', tool } });
      return { success: true, tool };
    } catch (error) { set.status = 400; return { error: error instanceof Error ? error.message : 'Could not approve executable' }; }
  }, { body: t.Object({ path: t.String() }) })
  .delete('/cli-tools/:name', async ({ user, params, set }) => {
    if (!user?.isAdmin) { set.status = 403; return { error: 'Admin access required' }; }
    const svc = getSettingsService();
    await svc.update('security.cliRuntimes', current => ((current ?? []) as CliRuntime[]).filter(entry => entry.name !== params.name), user.id);
    await auditRepository.log({ userId: user.id, action: 'settings_changed', resourceType: 'setting', resourceId: 'security.cliRuntimes', details: { operation: 'remove', name: params.name } });
    return { success: true };
  })

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
        constraints?: ReturnType<typeof getFieldConstraints>;
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
          } else if (def.isSecret) {
            // Settings-table-stored secret: mask in the response.
            const raw = await svc.get(def.key);
            value = raw ? '••••••••' : '';
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
            constraints: getFieldConstraints(def.key) ?? undefined,
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
          constraints: getFieldConstraints(def.key) ?? undefined,
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
          // Real boot-schema constraints (min/max/enum) so the UI can show
          // accurate limits and reject out-of-range input up front.
          constraints: getFieldConstraints(def.key) ?? undefined,
        })),
        categories: getCategories(),
      };
    },
    { detail: { tags: ['settings'] } }
  )

  // Read one setting by key
  //
  // PUT /:key and POST /:key/reset both existed; the GET did not, so
  // `octipus_get_setting` (which has called it since it was written) 404'd on
  // every invocation. Same masking rules as the list route — a secret's
  // presence is reported, never its value.
  .get(
    '/:key',
    async ({ user, params, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }

      const def = getSettingDefinition(params.key);
      if (!def) {
        set.status = 404;
        return { error: `Unknown setting "${params.key}"` };
      }

      const svc = getSettingsService();
      let value: unknown;
      if (def.isSecret && def.vaultName) {
        const secret = await getVault().getSystemSecret(def.vaultName);
        value = secret ? '••••••••' : '';
      } else if (def.isSecret) {
        value = (await svc.get(def.key)) ? '••••••••' : '';
      } else {
        value = await svc.get(def.key);
      }

      return {
        key: def.key,
        value,
        valueType: def.valueType,
        description: def.description,
        defaultValue: def.defaultValue,
        isSecret: def.isSecret,
        category: def.category,
        constraints: getFieldConstraints(def.key) ?? undefined,
      };
    },
    {
      params: t.Object({ key: t.String() }),
      detail: { tags: ['settings'] },
    },
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
      if (key === 'security.executionEnvironments') return { error: 'Manage execution environments in Settings → Environments & Access' };
      if (key === MODULES_SETTING) return { error: MODULES_ELSEWHERE };

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
        if (key === 'security.executionEnvironments') { errors[key] = 'Manage execution environments in Settings → Environments & Access'; continue; }
        if (key === MODULES_SETTING) {
          errors[key] = MODULES_ELSEWHERE;
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
      if (params.key === MODULES_SETTING) return { error: MODULES_ELSEWHERE };

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
