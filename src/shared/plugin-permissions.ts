/**
 * What a plugin package asks for, in words, and what changed between two
 * versions (docs/PLUGIN-PACKAGES.md#marketplace). Pure, shared by the server
 * (the marketplace listing, the update check, the CLI) and the web app, so
 * the Marketplace page, the update notice and `octi plugin marketplace` say
 * the same thing.
 *
 * Read from a `PluginPermissionsSummary` (`computePermissions`). An index
 * entry's permissions were checked against a strict schema before they get
 * here, and the host recomputes them from the downloaded manifest at install
 * and refuses any difference: these words describe the listing, never decide
 * anything.
 */
import type { PluginPermissionChange, PluginPermissionDiff, PluginPermissionsSummary, PluginToolEffect } from './plugin-package';

/** How each host API scope reads, as the user's data is concerned. */
export const HOST_SCOPE_WORDS: Record<string, string> = {
  'notes:read': 'Reads your notes',
  'notes:write': 'Writes notes',
  'tasks:read': 'Reads your tasks',
  'tasks:write': 'Creates tasks',
  'documents:read': 'Reads your documents',
  'documents:write': 'Creates and updates documents',
  notify: 'Sends you notifications',
  'web:read': 'Fetches web pages through Octipus',
  'model:complete': 'Uses your AI model',
  'agent:run': 'Starts background agent runs as you',
};

const EFFECT_RANK: Record<PluginToolEffect, number> = { read: 0, write: 1, external: 2 };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The permissions as short lines, most consequential first, e.g.
 * `["Runs in the server process", "Reads your tasks", "No network access", …]`.
 */
export function permissionsAskSummary(p: PluginPermissionsSummary): string[] {
  const out: string[] = [];
  if (p.runtime === 'in-process') out.push('Runs inside the Octipus server process, with its full authority');
  for (const scope of p.host) out.push(HOST_SCOPE_WORDS[scope] ?? `Host API scope ${scope}`);
  out.push(p.network.length === 0 ? 'No network access' : `Connects to ${p.network.join(', ')}`);
  const { read, write, external } = p.effects;
  const tools = [
    read > 0 ? plural(read, 'read tool', 'read tools') : '',
    write > 0 ? plural(write, 'write tool', 'write tools') : '',
    external > 0 ? plural(external, 'external tool', 'external tools') : '',
  ].filter(Boolean);
  out.push(tools.length > 0 ? `Tools: ${tools.join(', ')}` : 'No tools');
  const c = p.contributions;
  if (c.commands.length > 0) out.push(`Adds slash commands: ${c.commands.map((x) => `/${x}`).join(', ')}`);
  if (c.schedules.length > 0) out.push(`Runs on a schedule (${c.schedules.join(', ')})`);
  if (c.events.length > 0) out.push(`Reacts to events: ${c.events.join(', ')}`);
  if (c.prompt) out.push('Adds text to every agent\'s instructions');
  if (c.context) out.push('Adds context to agent turns');
  if (p.pages > 0) out.push(`Adds ${plural(p.pages, 'page', 'pages')}`);
  if (p.trustedInput) out.push('Asks to run its model calls on CLI lanes (needs a separate approval)');
  out.push(`Sees data up to protection level ${p.maxProtection}`);
  return out;
}

/**
 * What changed from `before` (the installed version's permissions, recomputed
 * from its manifest) to `after` (a newer listing's). `widened` is true when
 * anything asks for more than before.
 */
export function diffPermissions(before: PluginPermissionsSummary, after: PluginPermissionsSummary): PluginPermissionDiff {
  const changes: PluginPermissionChange[] = [];
  const add = (kind: PluginPermissionChange['kind'], change: PluginPermissionChange['change'], text: string, widens: boolean) => {
    changes.push({ kind, change, text, widens });
  };
  if (before.runtime !== after.runtime) add('runtime', 'changed', `runtime ${before.runtime} → ${after.runtime}`, after.runtime === 'in-process');
  if (before.apiVersion !== after.apiVersion) add('apiVersion', 'changed', `apiVersion ${before.apiVersion} → ${after.apiVersion}`, false);
  const lists: Array<['host' | 'network', string]> = [['host', 'host API scope'], ['network', 'network host']];
  for (const [kind, label] of lists) {
    for (const v of after[kind]) if (!before[kind].includes(v)) add(kind, 'added', `${label} ${v}`, true);
    for (const v of before[kind]) if (!after[kind].includes(v)) add(kind, 'removed', `${label} ${v}`, false);
  }
  const was = new Map(before.tools.map((t) => [t.name, t.effect]));
  const now = new Map(after.tools.map((t) => [t.name, t.effect]));
  for (const [name, effect] of now) {
    const old = was.get(name);
    if (old === undefined) add('tool', 'added', `tool ${name} (${effect})`, true);
    else if (old !== effect) {
      const wider = EFFECT_RANK[effect] > EFFECT_RANK[old];
      add('tool', wider ? 'wider' : 'narrower', `tool ${name}: ${old} → ${effect}`, wider);
    }
  }
  for (const [name, effect] of was) if (!now.has(name)) add('tool', 'removed', `tool ${name} (${effect})`, false);
  const contribLists: Array<['commands' | 'schedules' | 'events', string]> = [['commands', 'command /'], ['schedules', 'schedule '], ['events', 'event ']];
  for (const [kind, label] of contribLists) {
    for (const v of after.contributions[kind]) if (!before.contributions[kind].includes(v)) add('contribution', 'added', `${label}${v}`, true);
    for (const v of before.contributions[kind]) if (!after.contributions[kind].includes(v)) add('contribution', 'removed', `${label}${v}`, false);
  }
  for (const kind of ['prompt', 'context'] as const) {
    if (!before.contributions[kind] && after.contributions[kind]) add('contribution', 'added', kind, true);
    if (before.contributions[kind] && !after.contributions[kind]) add('contribution', 'removed', kind, false);
  }
  if (after.pages > before.pages) add('pages', 'added', `pages ${before.pages} → ${after.pages}`, true);
  if (after.pages < before.pages) add('pages', 'removed', `pages ${before.pages} → ${after.pages}`, false);
  if (!before.trustedInput && after.trustedInput) add('trustedInput', 'added', 'model.trustedInput', true);
  if (before.trustedInput && !after.trustedInput) add('trustedInput', 'removed', 'model.trustedInput', false);
  if (before.maxProtection !== after.maxProtection) {
    const wider = after.maxProtection > before.maxProtection;
    add('maxProtection', wider ? 'wider' : 'narrower', `maxProtection ${before.maxProtection} → ${after.maxProtection}`, wider);
  }
  return { widened: changes.some((c) => c.widens), changes };
}

/** Lower case without diacritics, for search (`Café` matches `cafe`). */
export function foldForSearch(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
