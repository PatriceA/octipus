/**
 * Contributions of plugin packages besides tools (docs/PLUGIN-PACKAGES.md#contributions):
 * slash commands, schedules, events, a prompt section and turn context.
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
import { bindSchedule } from './schedules';
import { forgetRuns, lastRuns } from './status';

export { pluginPromptSections } from './prompt';
export { runPluginContexts } from './context';
export { runDuePluginSchedules } from './schedules';

type Disposer = () => void | Promise<void>;

interface Binding {
  key: string;
  disposers: Disposer[];
  /** Contribution keys bound: `command:<name>`, `schedule:<id>`, `event:<on>:<tool>`, `prompt`, `context`. */
  bound: Set<string>;
  problems: string[];
}

const bindings = new Map<string, Binding>();
let chain: Promise<void> = Promise.resolve();

/** What a binding depends on: when it changes, the package is bound again. */
function bindingKey(row: PluginPackageRow): string {
  const m = row.manifest;
  return JSON.stringify([row.version, row.contentHash, row.approvedContributionsHash, row.installedBy, m.commands, m.schedules, m.events, m.prompt, m.context]);
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
  try {
    const read = await readContributions(m, dir);
    if (read.hash !== row.approvedContributionsHash) {
      binding.problems.push(`Not bound: its contributions are not approved${read.hash ? ` (contributions hash ${read.hash})` : ''}; review and approve them`);
      return binding;
    }
    promptText = read.promptText;
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
  } catch (err) {
    coreLogger.error({ err, pkg }, 'Plugin contributions could not be bound');
    binding.problems.push(`Could not bind: ${(err as Error).message}`);
  }
  if (binding.problems.length > 0) coreLogger.warn({ pkg, problems: binding.problems }, 'Plugin contributions partly bound');
  return binding;
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
 * its prompt file (read from `dir`, the copy being installed) and its command
 * names against the host's and the other installed packages'. Empty when it fits.
 */
export async function contributionInstallProblems(
  manifest: PluginManifest, dir: string, others: ReadonlyArray<{ name: string; manifest: PluginManifest }>,
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
  if (any) {
    try {
      const { packageDir } = await import('../service');
      ({ hash, promptText } = await readContributions(m, packageDir(row.name)));
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
    problems,
  };
}
