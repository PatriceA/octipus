/**
 * What a plugin package declares it will do, as a stable, ordered list of
 * items an admin reads and agrees to (docs/PLUGIN-PACKAGES.md#declarations).
 * The input of the consolidated install consent: one screen where every item
 * is ticked before the install runs, bound to the content hash.
 *
 * Built from the permissions summary (`computePermissions`), which a
 * marketplace listing carries and the host recomputes at install, plus the
 * manifest's own words (tool and command descriptions, secret labels) when
 * the manifest is at hand (a preview, an installed package). Each item's
 * `detail` carries what it is bound to (a schedule's cron and tool, the
 * prompt's sha256, a page's entry), so an item that changed reads as changed. The same
 * package always gives the same ids in the same order:
 *
 *   runtime, in-process, network:*, host:*, tool:*, command:*, schedule:*,
 *   event:*, prompt, context, page:*, ui, secret:*, model:cli-tools, protection
 *
 * plus, in an install preview of an upgrade, `change:*` items (another
 * source, another signer, an older version, a newer Octipus needed) that
 * the admin agrees to like the rest.
 *
 * `guidance` informs; it never refuses. The wording is the admin page's.
 */
import {
  MODEL_CLI_TOOLS_WARNING,
  PLUGIN_MODEL_CLI_TOOLS_APPROVAL,
  type PluginManifest,
  type PluginOrigin,
  type PluginPermissionDiff,
  type PluginPermissionsSummary,
} from './plugin-package';
import { HOST_SCOPE_WORDS } from './plugin-permissions';

export type PluginDeclarationKind =
  | 'runtime' | 'in-process' | 'network' | 'host' | 'tool' | 'command' | 'schedule' | 'event' | 'prompt' | 'context'
  | 'page' | 'secret' | 'model-cli-tools' | 'protection' | 'change';

export interface PluginDeclarationItem {
  /** Stable for the same package: `host:notes:read`, `tool:save_note`, … */
  id: string;
  kind: PluginDeclarationKind;
  /** One line, in plain words. */
  label: string;
  /** The exact thing declared (a scope, a host, a tool's effect and description). */
  detail: string;
  /** What to weigh before agreeing; never a refusal. */
  guidance?: string;
}

/** A structured note for the admin: on a marketplace entry, an install response, an update. */
export interface PluginGuidanceWarning {
  code: string;
  message: string;
}

/** Host scopes that can carry data out of the house (src/plugins/packages/service.ts, `EGRESS_HOST_SCOPES`). */
export const EGRESS_SCOPES: readonly string[] = ['web:read', 'model:complete', 'agent:run'];

/** The admin page's notes on scopes that need saying (web/app/admin/plugins/page.tsx). */
export const AGENT_RUN_NOTE = 'agent:run starts background agent runs as the user who asks (from a write tool only): the host\'s own agent of a role, '
  + 'with web search, the user\'s knowledge and documents (no shell, messages or mail), unattended (nothing is asked; an ASK is refused), '
  + 'for up to 20 minutes and plugins.hostAgentRunTokens tokens a run, counted in the user\'s daily plugin allowance and spend budgets. '
  + 'The package gets only the run\'s id and its final text.';
export const DOCUMENTS_WRITE_NOTE = 'documents:write creates text documents in the user\'s Documents and updates the ones this package created, '
  + 'as that user, marked with the package and tool that made them.';
export const IN_PROCESS_NOTE = 'Runs in the server process: no sandbox, so it has the server\'s network, files and data.';

/**
 * The warning when a package can send data out (`web:read`, `model:complete`,
 * `agent:run`) and also read the user's data: what it reads it can send
 * anywhere. Null when it cannot do both.
 */
export function egressReadWarning(scopes: readonly string[]): string | null {
  const out = scopes.filter((s) => EGRESS_SCOPES.includes(s));
  const reads = scopes.filter((s) => s.endsWith(':read') && s !== 'web:read');
  if (out.length === 0 || reads.length === 0) return null;
  return `With ${out.join(' and ')} and ${reads.join(', ')} together, this package can send what it reads anywhere. `
    + 'It is limited to data at protection level 1.';
}

/** The guidance notes a permissions summary calls for, as structured warnings. */
export function permissionsGuidance(p: PluginPermissionsSummary): PluginGuidanceWarning[] {
  const out: PluginGuidanceWarning[] = [];
  if (p.runtime === 'in-process') out.push({ code: 'in_process', message: IN_PROCESS_NOTE });
  const egress = egressReadWarning(p.host);
  if (egress) out.push({ code: 'egress_with_read', message: egress });
  if (p.trustedInput) out.push({ code: 'model_cli_tools', message: `It declares model.trustedInput: ${MODEL_CLI_TOOLS_WARNING}` });
  return out;
}

/**
 * The declaration items of a package: from its permissions summary, with the
 * manifest's own words when given.
 */
export function declarationItems(p: PluginPermissionsSummary, manifest?: Pick<PluginManifest, 'tools' | 'secrets' | 'commands' | 'model'> | null): PluginDeclarationItem[] {
  const items: PluginDeclarationItem[] = [];
  const egress = egressReadWarning(p.host);
  items.push(p.runtime === 'in-process'
    ? { id: 'runtime', kind: 'runtime', label: 'Runs inside the Octipus server process', detail: 'runtime: in-process', guidance: IN_PROCESS_NOTE }
    : { id: 'runtime', kind: 'runtime', label: 'Runs as a separate, sandboxed program', detail: 'runtime: package' });
  if (p.runtime === 'in-process') {
    items.push({ id: 'in-process', kind: 'in-process', label: 'Has the server\'s full authority', detail: 'Needs its own approval (approveInProcess) for this content', guidance: IN_PROCESS_NOTE });
  }
  if (p.network.length === 0) items.push({ id: 'network:none', kind: 'network', label: 'No network access of its own', detail: 'network: []' });
  for (const host of p.network) items.push({ id: `network:${host}`, kind: 'network', label: `Connects to ${host}`, detail: host });
  for (const scope of p.host) {
    const guidance = [
      scope === 'agent:run' ? AGENT_RUN_NOTE : null,
      scope === 'documents:write' ? DOCUMENTS_WRITE_NOTE : null,
      egress && (EGRESS_SCOPES.includes(scope) || (scope.endsWith(':read') && scope !== 'web:read')) ? egress : null,
    ].filter((g): g is string => g !== null).join(' ');
    items.push({ id: `host:${scope}`, kind: 'host', label: HOST_SCOPE_WORDS[scope] ?? `Host API scope ${scope}`, detail: scope, ...(guidance ? { guidance } : {}) });
  }
  for (const tool of p.tools) {
    const description = manifest?.tools?.[tool.name]?.description;
    items.push({
      id: `tool:${tool.name}`, kind: 'tool', label: `Tool ${tool.name} (${tool.effect})`,
      detail: description ? `${tool.effect}: ${description}` : tool.effect,
      ...(tool.effect === 'external' ? { guidance: 'An external tool acts outside Octipus (sends, posts, pays); each call follows the user\'s permission rules.' } : {}),
    });
  }
  const c = p.contributions;
  const roles = (r: readonly string[] | undefined) => (r ? `roles ${r.join(', ')}` : 'every agent');
  for (const x of c.commands) {
    const description = manifest?.commands?.find((d) => d.name === x.name)?.description;
    items.push({ id: `command:${x.name}`, kind: 'command', label: `Slash command /${x.name}`, detail: `→ ${x.tool}${description ? `: ${description}` : ''}` });
  }
  for (const x of c.schedules) {
    items.push({
      id: `schedule:${x.id}`, kind: 'schedule', label: `Runs on a schedule (${x.id})`,
      detail: `${x.cron} UTC → ${x.tool}${x.input !== undefined ? ` with ${JSON.stringify(x.input)}` : ''}`,
      guidance: 'Runs unattended as the admin who installs it: a write tool needs that admin\'s ALLOW rule, an external one never runs.',
    });
  }
  for (const on of [...new Set(c.events.map((x) => x.on))]) {
    const tools = c.events.filter((x) => x.on === on).map((x) => x.tool);
    items.push({ id: `event:${on}`, kind: 'event', label: `Reacts to ${on}`, detail: `→ ${tools.join(', ')}` });
  }
  if (c.prompt) {
    items.push({
      id: 'prompt', kind: 'prompt', label: 'Adds text to agents\' instructions',
      detail: `${c.prompt.file} (${roles(c.prompt.roles)})${c.prompt.sha256 ? `, sha256 ${c.prompt.sha256}` : ''}`,
      guidance: 'The text goes into the instructions of every user\'s agents of those roles. Read it in full before agreeing.',
    });
  }
  if (c.context) {
    items.push({
      id: 'context', kind: 'context', label: 'Adds context to agent turns', detail: `${c.context.tool} (${roles(c.context.roles)})`,
      guidance: 'The tool receives the message of every turn of every user of those roles.',
    });
  }
  for (const page of p.pages) items.push({ id: `page:${page.path}`, kind: 'page', label: `Adds the page "${page.title}"`, detail: `/${page.path} → ${page.entry}` });
  if (p.ui) items.push({ id: 'ui', kind: 'page', label: 'Serves its page files', detail: `${p.ui.dir}/${p.ui.sha256 ? `, sha256 ${p.ui.sha256}` : ''}` });
  for (const secret of manifest?.secrets ?? []) {
    items.push({ id: `secret:${secret.key}`, kind: 'secret', label: `Needs the secret ${secret.label}`, detail: `${secret.key}${secret.required ? ' (required)' : ''}` });
  }
  if (p.trustedInput) {
    items.push({
      id: PLUGIN_MODEL_CLI_TOOLS_APPROVAL, kind: 'model-cli-tools', label: 'Asks to run its model calls on CLI lanes',
      detail: `model.trustedInput${manifest?.model?.reason ? `: "${manifest.model.reason}"` : ''}`, guidance: MODEL_CLI_TOOLS_WARNING,
    });
  }
  items.push({ id: 'protection', kind: 'protection', label: `Sees data up to protection level ${p.maxProtection}`, detail: `maxProtection ${p.maxProtection}` });
  return items;
}

// ── Install consent (docs/PLUGIN-PACKAGES.md#installing-and-managing) ──────

/** A declaration on the consent screen: whether the installed version already had it, agreed (`carried`). */
export interface PluginConsentItem extends PluginDeclarationItem {
  /** Unchanged from the installed version, whose consent covered it: shown ticked, not asked again. */
  carried: boolean;
  /** `new`: the installed version did not declare it (or nothing is installed); `changed`: it did, otherwise. */
  status: 'new' | 'changed' | 'unchanged';
}

/** `POST /api/plugin-packages/preview`: a package downloaded, verified and staged, not installed. */
export interface PluginInstallPreview {
  previewId: string;
  name: string;
  version: string;
  title: string;
  contentHash: string;
  signedBy: string | null;
  origin: PluginOrigin;
  declarations: PluginConsentItem[];
  /** Notes for the whole package (a signature caveat, deprecation); never a refusal. */
  guidance: PluginGuidanceWarning[];
  /** For an upgrade: the installed version's permissions against these. */
  diff: PluginPermissionDiff | null;
  /** The installed version an upgrade replaces, or null. */
  upgradeFrom: string | null;
  expiresAt: string;
}

/** `GET /api/plugin-packages/:name/consent`: the declarations of an installed package's content, to agree to before enabling. */
export interface PluginConsentView {
  name: string;
  version: string;
  title: string;
  contentHash: string;
  signedBy: string | null;
  origin: PluginOrigin | null;
  enabled: boolean;
  declarations: PluginConsentItem[];
  guidance: PluginGuidanceWarning[];
}

/** What an install or consent with the admin's agreement answers. */
export interface PluginConsentResult {
  name: string;
  version: string;
  contentHash: string;
  enabled: boolean;
  /** Why it was not enabled although asked (a required setting or secret missing), or null. */
  enableProblem: string | null;
  warnings: string[];
}

/** The ids the admin must tick: every item not carried over. */
export function requiredConsentIds(items: readonly PluginConsentItem[]): string[] {
  return items.filter((i) => !i.carried).map((i) => i.id);
}

/** Whether an item's guidance is a warning (weigh it) or information. */
export function guidanceTone(item: PluginDeclarationItem): 'warning' | 'info' {
  if (item.kind === 'in-process' || item.kind === 'model-cli-tools' || item.kind === 'change' || (item.kind === 'runtime' && item.detail.includes('in-process'))) return 'warning';
  if (item.kind === 'tool' && item.id && item.label.endsWith('(external)')) return 'warning';
  if (item.guidance?.includes('send what it reads anywhere')) return 'warning';
  return 'info';
}

/**
 * The consent items of `after` against the installed version's `before`
 * items: equal items (same id, label, detail and guidance) are `unchanged`,
 * and carried when `covered(id)` says the installed version's consent
 * covered them. Without `before` every item is new.
 */
export function consentItems(after: readonly PluginDeclarationItem[], before: readonly PluginDeclarationItem[] | null, covered: (id: string) => boolean = () => false): PluginConsentItem[] {
  const was = new Map((before ?? []).map((i) => [i.id, i]));
  return after.map((item) => {
    const old = was.get(item.id);
    const same = old !== undefined && old.label === item.label && old.detail === item.detail && old.kind === item.kind && (old.guidance ?? '') === (item.guidance ?? '');
    const status = old === undefined ? 'new' : same ? 'unchanged' : 'changed';
    return { ...item, status, carried: same && item.kind !== 'change' && covered(item.id) };
  });
}
