import { validateRecordData } from '@/core/records/fields';
import { configuredExecutionEnvironments, pathInEnvironment } from '@/security/execution-environments';
import { readAvailableConnectionProfiles, connectionUrl, type ConnectionPrincipal } from '@/security/credential-connections';
import type { PluginManifest } from '@/shared/plugin-package';
import type { PluginSetupConfiguration, PluginSetupResources } from '@/shared/plugin-setup';
import type { RecordData } from '@/shared/record-fields';
import { effectiveMaxProtection, PluginPackageError } from './service';

export function setupConfiguration(manifest: PluginManifest, settings: RecordData = {}, secrets: readonly string[] = [], installed = false, enabled = false): PluginSetupConfiguration {
  return { fields: manifest.settings ?? [], secrets: (manifest.secrets ?? []).map(s => ({ ...s, configured: secrets.includes(s.key) })),
    resources: manifest.setup?.resources ?? [], settings: { ...manifest.setup?.defaults, ...settings }, maxProtection: effectiveMaxProtection(manifest, manifest.host ?? []),
    environmentBackends: manifest.host?.includes('repos:collect') ? ['host'] : undefined,
    check: manifest.setup?.check ?? null, companions: manifest.companions, installed, enabled };
}

export async function setupResources(caller: ConnectionPrincipal): Promise<PluginSetupResources> {
  if (caller.space) return { environments: [], connections: [] };
  return {
    environments: configuredExecutionEnvironments().filter(e => e.enabled && e.userId === caller.userId && (e.workspaceId === null || e.workspaceId === caller.workspaceId))
      .map(e => ({ id: e.id, name: e.name, backend: e.backend, roots: e.roots })),
    connections: (await readAvailableConnectionProfiles(caller)).filter(c => c.http).map(c => ({ id: c.id, origin: c.http!.origin, pathPrefix: c.http!.pathPrefix, git: c.http!.git })),
  };
}
const valuesOf = (v: unknown) => typeof v === 'string' ? v.split(/[\n,]/).map(x => x.trim()).filter(Boolean) : [];

/** Validate selected resources again at execution; discovery is not a lasting grant. */
export async function validateSetupSettings(manifest: PluginManifest, input: unknown, caller: ConnectionPrincipal): Promise<RecordData> {
  const values = validateRecordData(manifest.settings ?? [], input);
  if (!manifest.setup?.resources?.length) return values;
  const options = await setupResources(caller);
  if (manifest.host?.includes('repos:collect')) options.environments = options.environments.filter(e => e.backend === 'host');
  const fail = (message: string): never => { throw new PluginPackageError('invalid', message); };
  for (const resource of manifest.setup.resources) {
    const chosen = valuesOf(values[resource.setting]);
    if (!chosen.length) continue;
    if (resource.kind === 'environment' && chosen.some(id => !options.environments.some(e => e.id === id))) fail('The selected environment is no longer available. Choose it again.');
    if (resource.kind === 'folder' && chosen.some(path => !options.environments.some(e => e.roots.some(root => pathInEnvironment(root, path))))) fail('The selected folder is outside your environments. Open Environments & Access to add it.');
    if (resource.kind === 'connection' && chosen.some(id => !options.connections.some(c => c.id === id && (resource.connectionKind !== 'git' || c.git)))) fail('A selected connection is no longer available. Choose an existing connection or connect it in Secrets & Credentials.');
    if (resource.kind === 'protection' && chosen.some(level => !/^[1-4]$/.test(level) || Number(level) > effectiveMaxProtection(manifest, manifest.host ?? []))) fail('This plugin cannot display evidence at the chosen protection level. Keep that classification and choose a compatible plugin or interface.');
    if (resource.kind === 'http-grants') {
      let grants: unknown;
      try { grants = JSON.parse(String(values[resource.setting])); } catch { fail('Choose a connection and the paths it may read.'); }
      if (!grants || typeof grants !== 'object' || Array.isArray(grants)) fail('Connection access must be a map of connections to exact paths.');
      if (!Object.keys(grants as object).length && manifest.settings?.some(f => f.key === resource.setting && f.required)) fail('Select at least one connection and its allowed paths.');
      const profiles = await readAvailableConnectionProfiles(caller);
      for (const [id, paths] of Object.entries(grants as Record<string, unknown>)) {
        const profile = profiles.find(p => p.id === id);
        if (!profile) throw new PluginPackageError('invalid', 'The selected connection is unavailable.');
        if (!profile.http || !Array.isArray(paths) || paths.length === 0 || paths.length > 100 || paths.some(p => typeof p !== 'string')) fail('A connection or its selected paths are invalid.');
        for (const path of paths as string[]) connectionUrl(profile, path);
      }
    }
  }
  return values;
}
