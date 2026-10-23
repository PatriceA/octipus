/**
 * The module registry (docs/MODULES.md): which modules exist and which are
 * on. One install-wide setting, `modules.enabled`, lists the modules that
 * are on; it goes through the settings service, so a change reaches every
 * process at once.
 *
 * A module counts as on only when it is listed and every module it depends
 * on is on too, so a setting written past the API (an env var, a stored row)
 * can never switch on half of something.
 */
import { getConfig } from '@/config';
import { getSettingsService } from '@/config/settings-service';
import { MODULES } from '@/modules';
import type { ModuleView } from '@/shared/modules';
import type { ModuleDefinition } from './types';

export const MODULES_SETTING = 'modules.enabled';

const byId = new Map(MODULES.map((m) => [m.id, m]));

export function moduleById(id: string): ModuleDefinition | undefined {
  return byId.get(id);
}

/** The ids listed in the setting, known ones only. */
function listed(): Set<string> {
  const value = getConfig().modules?.enabled;
  return new Set(Array.isArray(value) ? value.filter((id) => byId.has(id)) : []);
}

/** Listed and with everything it depends on on. */
function effective(set: ReadonlySet<string>): Set<string> {
  const on = new Set<string>();
  const visit = (id: string, seen: Set<string>): boolean => {
    if (on.has(id)) return true;
    const mod = byId.get(id);
    if (!mod || !set.has(id) || seen.has(id)) return false;
    seen.add(id);
    const ok = mod.dependsOn.every((dep) => visit(dep, seen));
    if (ok) on.add(id);
    return ok;
  };
  for (const id of set) visit(id, new Set());
  return on;
}

/** The modules that are on. */
export function enabledModules(): Set<string> {
  return effective(listed());
}

export function isModuleOn(id: string): boolean {
  return enabledModules().has(id);
}

// ── What a module owns ──────────────────────────────────────────────

const toolOwner = new Map<string, string>();
const jobOwner = new Map<string, string>();
const caseEntityOwner = new Map<string, string>();
for (const m of MODULES) {
  for (const tool of m.tools) toolOwner.set(tool, m.id);
  for (const job of m.jobs) jobOwner.set(job, m.id);
  for (const entity of m.caseEntities) caseEntityOwner.set(entity, m.id);
}

/** The module a tool container belongs to; undefined for a core tool. */
export function moduleOfTool(toolId: string): string | undefined {
  return toolOwner.get(toolId);
}

/** The module serving `pathname`; undefined for a core path. */
export function moduleOfPath(pathname: string): string | undefined {
  for (const m of MODULES) {
    if (m.routes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return m.id;
  }
  return undefined;
}

/** A core tool, or one whose module is on. */
export function isToolOn(toolId: string): boolean {
  const owner = toolOwner.get(toolId);
  return owner === undefined || isModuleOn(owner);
}

/** A core job, or one whose module is on. Unknown names are core. */
export function isJobOn(job: string): boolean {
  const owner = jobOwner.get(job);
  return owner === undefined || isModuleOn(owner);
}

/** A core path, or one whose module is on. */
export function isPathOn(pathname: string): boolean {
  const owner = moduleOfPath(pathname);
  return owner === undefined || isModuleOn(owner);
}

/** A case link entity type of a core feature, or of a module that is on. */
export function isCaseEntityOn(entity: string): boolean {
  const owner = caseEntityOwner.get(entity);
  return owner === undefined || isModuleOn(owner);
}

// ── Changing what is on ─────────────────────────────────────────────

export class ModuleChangeError extends Error {}

/** The modules that depend on `id`, directly or through another. */
function dependents(id: string): string[] {
  const out = new Set<string>();
  const walk = (target: string) => {
    for (const m of MODULES) {
      if (m.dependsOn.includes(target) && !out.has(m.id)) {
        out.add(m.id);
        walk(m.id);
      }
    }
  };
  walk(id);
  return [...out];
}

/** What `id` needs, directly or through another, and itself. */
function withDependencies(id: string): string[] {
  const out = new Set<string>();
  const walk = (target: string) => {
    if (out.has(target)) return;
    out.add(target);
    for (const dep of byId.get(target)?.dependsOn ?? []) walk(dep);
  };
  walk(id);
  return [...out];
}

/**
 * The setting after turning `id` on (with what it depends on) or off.
 * Turning a module off while one that depends on it is on is refused.
 * Declared modules come first, in the registry's order.
 */
export function nextEnabled(current: readonly string[], id: string, on: boolean): string[] {
  if (!byId.has(id)) throw new ModuleChangeError(`Unknown module: ${id}`);
  // Ids this build does not declare are kept as they are: a module declared
  // by a later version finds the install as its migration left it.
  const set = new Set(current);
  if (on) {
    for (const m of withDependencies(id)) set.add(m);
  } else {
    const blocking = dependents(id).filter((m) => effective(set).has(m));
    if (blocking.length > 0) throw new ModuleChangeError(`${blocking.join(', ')} ${blocking.length === 1 ? 'needs' : 'need'} ${id}: turn ${blocking.length === 1 ? 'it' : 'them'} off first`);
    set.delete(id);
  }
  const known = MODULES.map((m) => m.id).filter((m) => set.has(m));
  return [...known, ...[...set].filter((m) => !byId.has(m))];
}

/** Turn one module on or off, under the setting's row lock. Returns the modules now listed. */
export async function setModuleOn(id: string, on: boolean, userId?: string): Promise<string[]> {
  const value = await getSettingsService().update(MODULES_SETTING, (current) => nextEnabled(Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : [], id, on), userId);
  return value as string[];
}

/** Replace the whole list (onboarding): what each listed module depends on is added. */
export async function setEnabledModules(ids: readonly string[], userId?: string): Promise<string[]> {
  for (const id of ids) if (!byId.has(id)) throw new ModuleChangeError(`Unknown module: ${id}`);
  const set = new Set(ids.flatMap(withDependencies));
  const value = MODULES.map((m) => m.id).filter((m) => set.has(m));
  await getSettingsService().update(MODULES_SETTING, () => value, userId);
  return value;
}

/** Every module as the API reports it. */
export function moduleViews(): ModuleView[] {
  const on = enabledModules();
  return MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    profiles: [...m.profiles],
    dependsOn: [...m.dependsOn],
    requiredBy: dependents(m.id),
    pages: [...m.pages],
    routes: [...m.routes],
    tools: [...m.tools],
    jobs: [...m.jobs],
    on: on.has(m.id),
  }));
}
