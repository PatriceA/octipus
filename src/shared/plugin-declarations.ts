/**
 * What a plugin package declares it will do, as a stable, ordered list of
 * items an admin reads and agrees to (docs/PLUGIN-PACKAGES.md#declarations).
 * The input of the consolidated install consent: one screen where every item
 * is ticked before the install runs, bound to the content hash.
 *
 * Built from the permissions summary (`computePermissions`), which a
 * marketplace listing carries and the host recomputes at install, plus the
 * manifest's own words (tool descriptions, secret labels, page titles,
 * cron) when the manifest is at hand (an installed package). The same
 * package always gives the same ids in the same order:
 *
 *   runtime, in-process, network:*, host:*, tool:*, command:*, schedule:*,
 *   event:*, prompt, context, page:*, secret:*, model:cli-tools, protection
 *
 * `guidance` informs; it never refuses. The wording is the admin page's.
 */
import {
  MODEL_CLI_TOOLS_WARNING,
  PLUGIN_MODEL_CLI_TOOLS_APPROVAL,
  type PluginManifest,
  type PluginPermissionsSummary,
} from './plugin-package';
import { HOST_SCOPE_WORDS } from './plugin-permissions';

export type PluginDeclarationKind =
  | 'runtime' | 'in-process' | 'network' | 'host' | 'tool' | 'command' | 'schedule' | 'event' | 'prompt' | 'context'
  | 'page' | 'secret' | 'model-cli-tools' | 'protection';

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
export function declarationItems(p: PluginPermissionsSummary, manifest?: Pick<PluginManifest, 'tools' | 'secrets' | 'commands' | 'schedules' | 'events' | 'prompt' | 'context' | 'ui' | 'model'> | null): PluginDeclarationItem[] {
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
  for (const name of c.commands) {
    const decl = manifest?.commands?.find((x) => x.name === name);
    items.push({ id: `command:${name}`, kind: 'command', label: `Slash command /${name}`, detail: decl ? `→ ${decl.tool}: ${decl.description}` : name });
  }
  for (const id of c.schedules) {
    const decl = manifest?.schedules?.find((x) => x.id === id);
    items.push({ id: `schedule:${id}`, kind: 'schedule', label: `Runs on a schedule (${id})`, detail: decl ? `${decl.cron} UTC → ${decl.tool}` : id });
  }
  for (const on of c.events) {
    const tools = (manifest?.events ?? []).filter((x) => x.on === on).map((x) => x.tool);
    items.push({ id: `event:${on}`, kind: 'event', label: `Reacts to ${on}`, detail: tools.length > 0 ? `→ ${tools.join(', ')}` : on });
  }
  if (c.prompt) {
    const roles = manifest?.prompt?.roles;
    items.push({ id: 'prompt', kind: 'prompt', label: 'Adds text to agents\' instructions', detail: `${manifest?.prompt?.file ?? 'a prompt file'} (${roles ? `roles ${roles.join(', ')}` : 'every agent'})` });
  }
  if (c.context) {
    const roles = manifest?.context?.roles;
    items.push({ id: 'context', kind: 'context', label: 'Adds context to agent turns', detail: `${manifest?.context?.tool ?? 'a read tool'} (${roles ? `roles ${roles.join(', ')}` : 'every agent'})` });
  }
  const pages = manifest?.ui?.pages;
  if (pages && pages.length === p.pages) {
    for (const page of pages) items.push({ id: `page:${page.path}`, kind: 'page', label: `Adds the page "${page.title}"`, detail: page.path });
  } else {
    for (let i = 1; i <= p.pages; i++) items.push({ id: `page:${i}`, kind: 'page', label: `Adds a page (${i} of ${p.pages})`, detail: `page ${i}` });
  }
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
