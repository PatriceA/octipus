/**
 * Contributions of plugin packages besides tools (docs/PLUGIN-PACKAGES.md#contributions):
 * slash commands, schedules, events, a prompt section, turn context and agent roles.
 *
 * Every registration has a disposer. `syncContributions` runs after every
 * change to the installed packages (`syncPluginServers`): an enabled package
 * whose contributions, version, approved content or installer changed is
 * unbound (its disposers in reverse registration order) and bound again; a
 * disabled, upgraded-and-not-yet-enabled or uninstalled one is unbound. So
 * enabling, disabling, upgrading and uninstalling apply without a restart.
 * A contribution that cannot bind (a command name taken since install, files
 * that no longer hash to the approved content) is left out and its reason is
 * listed on the package's row; the rest bind.
 */
import type { PluginPackageRow } from '@/db/schema/plugin-packages';
import type { PluginContributionsView, PluginManifest } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { hashPackageContent } from '../integrity';
import { bindCommand, commandConflicts } from './commands';
import { bindContext } from './context';
import { bindEvent, forgetEventBudget } from './events';
import { hasContributions, readContributions } from './approval';
import { bindPrompt, boundPromptChars, readPromptFile } from './prompt';
import { bindRole, roleConflicts } from './roles';
import { bindSchedule } from './schedules';
import { forgetRuns, lastRuns } from './status';

export { pluginPromptSections } from './prompt';
export { runPluginContexts } from './context';
export { runDuePluginSchedules } from './schedules';

type Disposer = () => void | Promise<void>;

interface Binding {
  key: string;
  disposers: Disposer[];
  /** Contribution keys bound: `command:<name>`, `schedule:<id>`, `event:<on>:<tool>`, `prompt`, `context`, `role:<id>`. */
  bound: Set<string>;
  problems: string[];
}

const bindings = new Map<string, Binding>();
let chain: Promise<void> = Promise.resolve();

/** What a binding depends on: when it changes, the package is bound again. */
function bindingKey(row: PluginPackageRow): string {
  const m = row.manifest;
  return JSON.stringify([row.version, row.contentHash, row.approvedContributionsHash, row.installedBy, m.commands, m.schedules, m.events, m.prompt, m.context, m.roles]);
}

async function dispose(pkg: string, binding: Binding): Promise<void> {
  // Reverse registration order: what was bound last goes first.
  for (const d of [...binding.disposers].reverse()) {
    try {
      await d();
    } catch (err) {
      coreLogger.warn({ err, pkg }, 'Plugin contribution disposer failed');
    }
  }
  binding.disposers.length = 0;
  forgetEventBudget(pkg);
}

async function bind(row: PluginPackageRow): Promise<Binding> {
  const m = row.manifest;
  const binding: Binding = { key: bindingKey(row), disposers: [], bound: new Set(), problems: [] };
  const pkg = row.name;
  const { packageDir } = await import('../service');
  const dir = packageDir(pkg);
  // Nothing binds unless an admin approved exactly what it adds now.
  let promptText: string | null = null;
  let rolePrompts = new Map<string, string>();
  try {
    const read = await readContributions(m, dir);
    if (read.hash !== row.approvedContributionsHash) {
      binding.problems.push(`Not bound: its contributions are not approved${read.hash ? ` (contributions hash ${read.hash})` : ''}; review and approve them`);
      return binding;
    }
    promptText = read.promptText;
    rolePrompts = read.rolePrompts;
  } catch (err) {
    binding.problems.push(`Not bound: ${(err as Error).message}`);
    return binding;
  }
  try {
    if (m.prompt && promptText !== null) {
      try {
        if (row.contentHash === null) throw new Error('prompt: not added until the package content is pinned (its first start)');
        // The text hashed into the approval; the files must also still hash to the approved content.
        const text = promptText;
        if (await hashPackageContent(dir, row) !== row.contentHash) throw new Error('prompt: not added, the package files changed since their content was approved');
        binding.disposers.push(bindPrompt(pkg, text, m.prompt.roles));
        binding.bound.add('prompt');
      } catch (err) {
        binding.problems.push((err as Error).message);
      }
    }
    if (m.context) {
      binding.disposers.push(bindContext(pkg, m.context));
      binding.bound.add('context');
    }
    for (const c of m.commands ?? []) {
      const result = await bindCommand(pkg, c);
      if ('problem' in result) binding.problems.push(`commands: ${result.problem}`);
      else {
        binding.disposers.push(result.dispose);
        binding.bound.add(`command:${c.name}`);
      }
    }
    for (const s of m.schedules ?? []) {
      binding.disposers.push(bindSchedule(pkg, s, row.installedBy));
      binding.bound.add(`schedule:${s.id}`);
    }
    for (const e of m.events ?? []) {
      binding.disposers.push(await bindEvent(pkg, e));
      binding.bound.add(`event:${e.on}:${e.tool}`);
    }
    if (m.roles?.length) await bindRoles(row, rolePrompts, binding);
  } catch (err) {
    coreLogger.error({ err, pkg }, 'Plugin contributions could not be bound');
    binding.problems.push(`Could not bind: ${(err as Error).message}`);
  }
  if (binding.problems.length > 0) coreLogger.warn({ pkg, problems: binding.problems }, 'Plugin contributions partly bound');
  return binding;
}

/**
 * Register the package's roles: only from files that still hash to the
 * approved content, and only while the admin who installed it is still an
 * active admin — a role is never more than its installing principal could
 * have created by hand.
 */
async function bindRoles(row: PluginPackageRow, prompts: Map<string, string>, binding: Binding): Promise<void> {
  const pkg = row.name;
  const { packageDir } = await import('../service');
  if (row.contentHash === null) {
    binding.problems.push('roles: not added until the package content is pinned (its first start)');
    return;
  }
  if (await hashPackageContent(packageDir(pkg), row) !== row.contentHash) {
    binding.problems.push('roles: not added, the package files changed since their content was approved');
    return;
  }
  const { isAdminInDatabase } = await import('@/core/gateway/commands');
  if (!row.installedBy || !(await isAdminInDatabase(row.installedBy))) {
    binding.problems.push('roles: not added, the admin who installed the package is no longer an active admin; reinstall or upgrade it as an admin');
    return;
  }
  for (const decl of row.manifest.roles ?? []) {
    const text = prompts.get(decl.id);
    if (text === undefined) {
      binding.problems.push(`roles.${decl.id}: its prompt could not be read`);
      continue;
    }
    const result = await bindRole(pkg, decl, text);
    if ('problem' in result) binding.problems.push(result.problem);
    else {
      binding.disposers.push(result.dispose);
      binding.bound.add(`role:${decl.id}`);
    }
  }
}

async function apply(rows: readonly PluginPackageRow[]): Promise<void> {
  const wanted = new Map(rows.filter((r) => r.enabled && hasContributions(r.manifest)).map((r) => [r.name, r]));
  for (const [pkg, binding] of [...bindings]) {
    const row = wanted.get(pkg);
    // One that could not bind everything is tried again (a command name may be free now).
    if (row && bindingKey(row) === binding.key && binding.problems.length === 0) continue;
    bindings.delete(pkg);
    await dispose(pkg, binding);
    if (!rows.some((r) => r.name === pkg)) await forgetRuns(pkg);
  }
  for (const [pkg, row] of wanted) {
    if (bindings.has(pkg)) continue;
    bindings.set(pkg, await bind(row));
  }
}

/**
 * Bind the contributions of the enabled packages among `rows` (every
 * installed package) and unbind the rest. Calls run one at a time, in order.
 * Never throws.
 */
export function syncContributions(rows: readonly PluginPackageRow[]): Promise<void> {
  const next = chain.then(() => apply(rows)).catch((err: unknown) => {
    coreLogger.error({ err }, 'Plugin contributions sync failed');
  });
  chain = next;
  return next;
}

/** Unbind everything (shutdown, tests). */
export function disposeAllContributions(): Promise<void> {
  return syncContributions([]);
}

/**
 * Why a package's contributions cannot be installed beside what is there:
 * its prompt files (read from `dir`, the copy being installed), its command
 * names against the host's and the other installed packages', and its role
 * ids against the other packages' and — with `host` (the default; the install
 * path) — the host's registered roles and stored role rows. Empty when it fits.
 */
export async function contributionInstallProblems(
  manifest: PluginManifest, dir: string, others: ReadonlyArray<{ name: string; manifest: PluginManifest }>,
  opts: { host: boolean } = { host: true },
): Promise<string[]> {
  const problems: string[] = [];
  if (manifest.prompt) {
    try {
      await readPromptFile(dir, manifest.prompt);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  problems.push(...await commandConflicts(manifest.name, manifest.commands ?? [], others.map((o) => ({ name: o.name, commands: o.manifest.commands }))));
  for (const role of manifest.roles ?? []) {
    try {
      await readPromptFile(dir, { file: role.prompt });
    } catch (err) {
      problems.push(`roles.${role.id}: ${(err as Error).message.replace(/^prompt: /, '')}`);
    }
  }
  if (manifest.roles?.length) {
    problems.push(...await roleConflicts(manifest.name, manifest.roles, others.map((o) => ({ name: o.name, roles: o.manifest.roles })), opts));
  }
  return problems;
}

/**
 * What a package contributes, for its row and the enable confirmation: each
 * part with its tool's effect, the full prompt text, the contributions hash
 * to approve and the approved one, what is bound now, and its last runs.
 */
export async function contributionsView(row: Pick<PluginPackageRow, 'name' | 'manifest' | 'approvedContributionsHash'>): Promise<PluginContributionsView> {
  const m = row.manifest;
  const binding = bindings.get(row.name);
  const bound = (key: string) => binding?.bound.has(key) ?? false;
  const effect = (tool: string) => m.tools?.[tool]?.effect ?? null;
  const any = hasContributions(m);
  const runs = any ? await lastRuns(row.name) : {};
  const problems = binding ? [...binding.problems] : [];
  let hash: string | null = null;
  let promptText: string | null = null;
  let rolePrompts = new Map<string, string>();
  if (any) {
    try {
      const { packageDir } = await import('../service');
      ({ hash, promptText, rolePrompts } = await readContributions(m, packageDir(row.name)));
    } catch (err) {
      problems.push(`Cannot be read: ${(err as Error).message}`);
    }
  }
  return {
    hash,
    approvedHash: row.approvedContributionsHash ?? null,
    approved: any && hash !== null && hash === row.approvedContributionsHash,
    commands: (m.commands ?? []).map((c) => ({ name: c.name, tool: c.tool, effect: effect(c.tool), description: c.description, bound: bound(`command:${c.name}`) })),
    schedules: (m.schedules ?? []).map((s) => ({ id: s.id, cron: s.cron, tool: s.tool, effect: effect(s.tool), bound: bound(`schedule:${s.id}`), lastRun: runs[`schedule:${s.id}`] ?? null })),
    events: (m.events ?? []).map((e) => ({ on: e.on, tool: e.tool, effect: effect(e.tool), bound: bound(`event:${e.on}:${e.tool}`), lastRun: runs[`event:${e.on}:${e.tool}`] ?? null })),
    prompt: m.prompt ? { file: m.prompt.file, roles: m.prompt.roles ?? null, text: promptText, bound: bound('prompt'), chars: boundPromptChars(row.name) } : null,
    context: m.context ? { tool: m.context.tool, effect: effect(m.context.tool), roles: m.context.roles ?? null, bound: bound('context'), lastRun: runs.context ?? null } : null,
    roles: (m.roles ?? []).map((r) => ({
      id: r.id, displayName: r.displayName, description: r.description, lane: r.lane, tools: [...r.tools],
      coreTools: r.coreTools ? [...r.coreTools] : null,
      spawns: r.spawns ? [...r.spawns] : null,
      spawnedBy: r.spawnedBy ? [...r.spawnedBy] : null,
      criticalRules: [...(r.criticalRules ?? [])],
      readOnly: r.readOnly === true,
      limits: r.limits ? { ...r.limits } : null,
      prompt: r.prompt, text: rolePrompts.get(r.id) ?? null, bound: bound(`role:${r.id}`),
    })),
    problems,
  };
}
