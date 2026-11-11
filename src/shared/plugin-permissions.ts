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
import { formatStoreBytes, type PluginPermissionChange, type PluginPermissionDiff, type PluginPermissionsSummary, type PluginToolEffect } from './plugin-package';

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
  'store:read': 'Reads the data it keeps for you',
  'store:write': 'Keeps data for you',
  'mail:read': 'Reads your mail',
  'mail:draft': 'Saves mail drafts (never sends them)',
  'mail:send': 'Sends mail as you',
  'calendar:read': 'Reads your calendar',
  'calendar:write': 'Adds events to your calendar and changes the ones it added',
};

/** The store in words: "Keeps up to 5 MB of its own data per user". */
export function storeWords(quotaBytes: number): string {
  return `Keeps up to ${formatStoreBytes(quotaBytes)} of its own data per user`;
}

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
  if (p.secrets.length > 0) out.push(`Asks you for these secrets: ${p.secrets.join(', ')}`);
  if (p.settings.length > 0) out.push(`Settings: ${p.settings.join(', ')}`);
  if (p.store) out.push(storeWords(p.store.quotaBytes));
  const { read, write, external } = p.effects;
  const tools = [
    read > 0 ? plural(read, 'read tool', 'read tools') : '',
    write > 0 ? plural(write, 'write tool', 'write tools') : '',
    external > 0 ? plural(external, 'external tool', 'external tools') : '',
  ].filter(Boolean);
  out.push(tools.length > 0 ? `Tools: ${tools.join(', ')}` : 'No tools');
  const c = p.contributions;
  if (c.commands.length > 0) out.push(`Adds slash commands: ${c.commands.map((x) => `/${x.name}`).join(', ')}`);
  if (c.schedules.length > 0) out.push(`Runs on a schedule: ${c.schedules.map((x) => `${x.id} (${x.cron} UTC)`).join(', ')}`);
  if (c.events.length > 0) out.push(`Reacts to events: ${[...new Set(c.events.map((x) => x.on))].join(', ')}`);
  if (c.prompt) out.push(`Adds text to ${c.prompt.roles ? 'some agents\' instructions' : 'every agent\'s instructions'}`);
  if (c.context) out.push(`Adds context to ${c.context.roles ? 'some agents\' turns' : 'every agent turn'}`);
  if (p.pages.length > 0) out.push(`Adds ${plural(p.pages.length, 'page', 'pages')}: ${p.pages.map((x) => x.title).join(', ')}`);
  if (p.trustedInput) out.push('Asks to run its model calls on CLI lanes (needs a separate approval)');
  out.push(`Sees data up to protection level ${p.maxProtection}`);
  return out;
}

/**
 * Whether a tool's effect change widens what it may do unasked. Up (read →
 * write → external) it does more; down to `read` it is no longer asked about
 * per call and may run unattended (schedules, events, context), so write →
 * read and external → read widen too. external → write narrows (a write
 * tool is asked about by default, and runs unattended only under an ALLOW rule).
 */
export function effectChangeWidens(from: PluginToolEffect, to: PluginToolEffect): boolean {
  return EFFECT_RANK[to] > EFFECT_RANK[from] || (to === 'read' && from !== 'read');
}

/**
 * What changed from `before` (the installed version's permissions, recomputed
 * from its manifest) to `after` (a newer listing's). `widened` is true when
 * anything asks for more than before. The marketplace repository's PR
 * summary applies the same rules, so the two agree.
 */
export function diffPermissions(before: PluginPermissionsSummary, after: PluginPermissionsSummary): PluginPermissionDiff {
  const changes: PluginPermissionChange[] = [];
  const add = (kind: PluginPermissionChange['kind'], change: PluginPermissionChange['change'], text: string, widens: boolean) => {
    changes.push({ kind, change, text, widens });
  };
  if (before.runtime !== after.runtime) add('runtime', 'changed', `runtime ${before.runtime} → ${after.runtime}`, after.runtime === 'in-process');
  if (before.apiVersion !== after.apiVersion) add('apiVersion', 'changed', `apiVersion ${before.apiVersion} → ${after.apiVersion}`, false);
  // A new secret widens (it asks for a credential); a setting added or removed is a change that does not.
  const lists: Array<['host' | 'network' | 'secrets' | 'settings', string, boolean]> = [
    ['host', 'host API scope', true], ['network', 'network host', true], ['secrets', 'secret', true], ['settings', 'setting', false],
  ];
  for (const [kind, label, widens] of lists) {
    const was = before[kind] ?? [];
    const now = after[kind] ?? [];
    for (const v of now) if (!was.includes(v)) add(kind, 'added', `${label} ${v}`, widens);
    for (const v of was) if (!now.includes(v)) add(kind, 'removed', `${label} ${v}`, false);
  }
  // A new store, or a larger quota, widens; a smaller one narrows. (A summary from before the store reads as none.)
  const storeWas = before.store ?? null;
  const storeNow = after.store ?? null;
  if (!storeWas && storeNow) add('store', 'added', `store (${formatStoreBytes(storeNow.quotaBytes)} per user)`, true);
  else if (storeWas && !storeNow) add('store', 'removed', `store (${formatStoreBytes(storeWas.quotaBytes)} per user)`, false);
  else if (storeWas && storeNow && storeWas.quotaBytes !== storeNow.quotaBytes) {
    const wider = storeNow.quotaBytes > storeWas.quotaBytes;
    add('store', wider ? 'wider' : 'narrower', `store quota ${formatStoreBytes(storeWas.quotaBytes)} → ${formatStoreBytes(storeNow.quotaBytes)} per user`, wider);
  }
  const was = new Map(before.tools.map((t) => [t.name, t.effect]));
  const now = new Map(after.tools.map((t) => [t.name, t.effect]));
  for (const [name, effect] of now) {
    const old = was.get(name);
    if (old === undefined) add('tool', 'added', `tool ${name} (${effect})`, true);
    else if (old !== effect) {
      const wider = effectChangeWidens(old, effect);
      // Down to read: fewer prompts, not fewer powers. Named so.
      const text = effect === 'read'
        ? `tool ${name}: ${old} → read (no longer asked before each call; may run unattended)`
        : `tool ${name}: ${old} → ${effect}`;
      add('tool', wider ? 'wider' : 'narrower', text, wider);
    }
  }
  for (const [name, effect] of was) if (!now.has(name)) add('tool', 'removed', `tool ${name} (${effect})`, false);
  diffContributions(before, after, add);
  if (!before.trustedInput && after.trustedInput) add('trustedInput', 'added', 'model.trustedInput', true);
  if (before.trustedInput && !after.trustedInput) add('trustedInput', 'removed', 'model.trustedInput', false);
  if (before.maxProtection !== after.maxProtection) {
    const wider = after.maxProtection > before.maxProtection;
    add('maxProtection', wider ? 'wider' : 'narrower', `maxProtection ${before.maxProtection} → ${after.maxProtection}`, wider);
  }
  return { widened: changes.some((c) => c.widens), changes };
}

type AddChange = (kind: PluginPermissionChange['kind'], change: PluginPermissionChange['change'], text: string, widens: boolean) => void;

const json = (v: unknown) => JSON.stringify(v ?? null);
const rolesText = (roles: readonly string[] | undefined) => (roles ? `roles ${roles.join(', ')}` : 'every role');
/** Whether `after` reaches a role `before` did not (no roles: every role). */
const reachesMore = (before: readonly string[] | undefined, after: readonly string[] | undefined) =>
  before !== undefined && (after === undefined || after.some((r) => !before.includes(r)));

/**
 * Commands, schedules, events, prompt, context, pages and page files. Any
 * difference is a change; it widens when it adds one, points one at another
 * tool, moves a cron, changes the prompt text or file, the context tool, a
 * page or the page files, or reaches roles it did not.
 */
function diffContributions(before: PluginPermissionsSummary, after: PluginPermissionsSummary, add: AddChange): void {
  const b = before.contributions;
  const a = after.contributions;
  const was = new Map(b.commands.map((c) => [c.name, c]));
  const now = new Map(a.commands.map((c) => [c.name, c]));
  for (const [name, c] of now) {
    const old = was.get(name);
    if (!old) add('contribution', 'added', `command /${name} → ${c.tool}`, true);
    else {
      if (old.tool !== c.tool) add('contribution', 'changed', `command /${name}: ${old.tool} → ${c.tool}`, true);
      if (json(old.input) !== json(c.input)) add('contribution', 'changed', `command /${name}: input ${json(old.input)} → ${json(c.input)}`, false);
    }
  }
  for (const [name, c] of was) if (!now.has(name)) add('contribution', 'removed', `command /${name} → ${c.tool}`, false);

  const wasS = new Map(b.schedules.map((x) => [x.id, x]));
  const nowS = new Map(a.schedules.map((x) => [x.id, x]));
  for (const [id, x] of nowS) {
    const old = wasS.get(id);
    if (!old) {
      add('contribution', 'added', `schedule ${id} (${x.cron} UTC) → ${x.tool}`, true);
      continue;
    }
    if (old.tool !== x.tool) add('contribution', 'changed', `schedule ${id}: tool ${old.tool} → ${x.tool}`, true);
    if (old.cron !== x.cron) add('contribution', 'changed', `schedule ${id}: cron ${old.cron} → ${x.cron} (UTC)`, true);
    if (json(old.input) !== json(x.input)) add('contribution', 'changed', `schedule ${id}: input ${json(old.input)} → ${json(x.input)}`, false);
  }
  for (const [id, x] of wasS) if (!nowS.has(id)) add('contribution', 'removed', `schedule ${id} (${x.cron} UTC) → ${x.tool}`, false);

  const key = (e: { on: string; tool: string }) => `${e.on} → ${e.tool}`;
  const wasE = new Set(b.events.map(key));
  const nowE = new Set(a.events.map(key));
  for (const e of nowE) if (!wasE.has(e)) add('contribution', 'added', `event ${e}`, true);
  for (const e of wasE) if (!nowE.has(e)) add('contribution', 'removed', `event ${e}`, false);

  if (!b.prompt && a.prompt) add('contribution', 'added', `prompt ${a.prompt.file} (${rolesText(a.prompt.roles)})`, true);
  else if (b.prompt && !a.prompt) add('contribution', 'removed', `prompt ${b.prompt.file}`, false);
  else if (b.prompt && a.prompt) {
    if (b.prompt.file !== a.prompt.file || b.prompt.sha256 !== a.prompt.sha256) add('contribution', 'changed', `prompt text (${a.prompt.file})`, true);
    if (json(b.prompt.roles) !== json(a.prompt.roles)) {
      add('contribution', 'changed', `prompt ${rolesText(b.prompt.roles)} → ${rolesText(a.prompt.roles)}`, reachesMore(b.prompt.roles, a.prompt.roles));
    }
  }
  if (!b.context && a.context) add('contribution', 'added', `context → ${a.context.tool} (${rolesText(a.context.roles)})`, true);
  else if (b.context && !a.context) add('contribution', 'removed', `context → ${b.context.tool}`, false);
  else if (b.context && a.context) {
    if (b.context.tool !== a.context.tool) add('contribution', 'changed', `context tool ${b.context.tool} → ${a.context.tool}`, true);
    if (json(b.context.roles) !== json(a.context.roles)) {
      add('contribution', 'changed', `context ${rolesText(b.context.roles)} → ${rolesText(a.context.roles)}`, reachesMore(b.context.roles, a.context.roles));
    }
  }

  const wasP = new Map(before.pages.map((p) => [p.path, p]));
  const nowP = new Map(after.pages.map((p) => [p.path, p]));
  for (const [path, p] of nowP) {
    const old = wasP.get(path);
    if (!old) add('pages', 'added', `page ${path} ("${p.title}")`, true);
    else if (old.title !== p.title || old.entry !== p.entry) add('pages', 'changed', `page ${path}: "${old.title}" ${old.entry} → "${p.title}" ${p.entry}`, true);
  }
  for (const [path, p] of wasP) if (!nowP.has(path)) add('pages', 'removed', `page ${path} ("${p.title}")`, false);
  if (before.ui && after.ui && (before.ui.dir !== after.ui.dir || before.ui.sha256 !== after.ui.sha256)) {
    add('pages', 'changed', `page files (${after.ui.dir}/)`, true);
  }
}

/** Lower case without diacritics, for search (`Café` matches `cafe`). */
export function foldForSearch(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
