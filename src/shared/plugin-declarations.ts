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
 *   event:*, prompt, context, page:*, ui, secrets, settings, model:cli-tools, protection
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
  | 'page' | 'secret' | 'setting' | 'model-cli-tools' | 'protection' | 'change';

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

/** A page's egress: it can navigate its frame anywhere, with what it shows in the URL. */
export const PAGE_EGRESS_NOTE = 'A page can send what it shows to any website: it can navigate to any address with that data in the URL. '
  + 'A package with pages is limited to data at protection level 1, whatever it declares.';

/**
 * The warning when a package can send data out (`web:read`, `model:complete`,
 * `agent:run`, or a page, which can navigate anywhere) and also read the
 * user's data: what it reads it can send anywhere. Null when it cannot do both.
 */
export function egressReadWarning(scopes: readonly string[], opts: { pages?: boolean } = {}): string | null {
  const out = [...scopes.filter((s) => EGRESS_SCOPES.includes(s)), ...(opts.pages ? ['its pages'] : [])];
  const reads = scopes.filter((s) => s.endsWith(':read') && s !== 'web:read');
  if (out.length === 0 || reads.length === 0) return null;
  return `With ${out.join(' and ')} and ${reads.join(', ')} together, this package can send what it reads anywhere. `
    + 'It is limited to data at protection level 1.';
}

/** The guidance notes a permissions summary calls for, as structured warnings. */
export function permissionsGuidance(p: PluginPermissionsSummary): PluginGuidanceWarning[] {
  const out: PluginGuidanceWarning[] = [];
  if (p.runtime === 'in-process') out.push({ code: 'in_process', message: IN_PROCESS_NOTE });
  const egress = egressReadWarning(p.host, { pages: p.pages.length > 0 });
  if (egress) out.push({ code: 'egress_with_read', message: egress });
  if (p.trustedInput) out.push({ code: 'model_cli_tools', message: `It declares model.trustedInput: ${MODEL_CLI_TOOLS_WARNING}` });
  return out;
}

/**
 * How the sandbox holds on the host that shows the declarations
 * (src/plugins/packages/sandbox-policy.ts, `hostEnforcement`): the runner
 * that wraps the server, or null; and why it may not run here, or null.
 */
export interface PluginHostEnforcement {
  runner: string | null;
  refused: string | null;
}

export const NOT_SANDBOXED_NOTE = 'plugins.sandbox is off and no sandbox wraps it: it runs as the Octipus server\'s user, '
  + 'and can read that user\'s files, the server\'s environment (its database URL and master key) and connect anywhere. '
  + 'Only a plugin that is not from the marketplace can run this way.';
export const NETWORK_NOT_ENFORCED_NOTE = 'Network not enforced on this host: no sandbox takes direct network away, so nothing stops it from connecting anywhere.';

/**
 * A wildcard host that may cover sites anyone can register: `*.github.io`,
 * `*.co.uk`. Without a public suffix list, any wildcard over fewer than three
 * labels (`*.example.com` included) is flagged. Guidance, never a refusal.
 */
export function broadWildcardNote(host: string): string | null {
  if (!host.startsWith('*.')) return null;
  const domain = host.slice(2).replace(/:\d+$/, '');
  if (domain.split('.').length >= 3) return null;
  return `${host} covers every name under ${domain}; if anyone can register one there (as with *.github.io or *.co.uk), the package can reach sites nobody vetted.`;
}

/** The runtime item: what it runs as, and whether this host sandboxes it (`host`), never "sandboxed" where it is not. */
function runtimeItem(p: PluginPermissionsSummary, host: PluginHostEnforcement | null): PluginDeclarationItem {
  if (p.runtime === 'in-process') return { id: 'runtime', kind: 'runtime', label: 'Runs inside the Octipus server process', detail: 'runtime: in-process', guidance: IN_PROCESS_NOTE };
  if (!host) {
    return { id: 'runtime', kind: 'runtime', label: 'Runs as a separate program', detail: 'runtime: package', guidance: 'Sandboxed where the host has a sandbox runner; the host you install it on says whether it has one.' };
  }
  if (host.runner) return { id: 'runtime', kind: 'runtime', label: `Runs as a separate program in a sandbox (${host.runner})`, detail: 'runtime: package' };
  if (host.refused) return { id: 'runtime', kind: 'runtime', label: 'NOT sandboxed on this host, so it does not run here', detail: 'runtime: package', guidance: host.refused };
  return { id: 'runtime', kind: 'runtime', label: 'NOT sandboxed on this host', detail: 'runtime: package', guidance: NOT_SANDBOXED_NOTE };
}

/** The network items: what it declares, and whether this host enforces it (`host`). */
function networkItems(p: PluginPermissionsSummary, host: PluginHostEnforcement | null): PluginDeclarationItem[] {
  const enforced = p.runtime !== 'in-process' && !!host?.runner;
  const unenforced = !!host && !enforced;
  if (p.network.length === 0) {
    if (unenforced) return [{ id: 'network:none', kind: 'network', label: 'Network not enforced on this host', detail: 'network: []', guidance: `It declares no network. ${NETWORK_NOT_ENFORCED_NOTE}` }];
    return [{ id: 'network:none', kind: 'network', label: enforced ? 'No network access of its own' : 'Declares no network access', detail: 'network: []' }];
  }
  return p.network.map((h) => {
    const guidance = [broadWildcardNote(h), unenforced ? NETWORK_NOT_ENFORCED_NOTE : null].filter((g): g is string => g !== null).join(' ');
    return { id: `network:${h}`, kind: 'network' as const, label: `Connects to ${h}`, detail: h, ...(guidance ? { guidance } : {}) };
  });
}

/**
 * The declaration items of a package: from its permissions summary, with the
 * manifest's own words when given, and with what this host enforces (`host`:
 * the runtime and network items say "NOT sandboxed" / "Network not enforced"
 * where that is so; without it they only say what is declared).
 */
export function declarationItems(
  p: PluginPermissionsSummary, manifest?: Pick<PluginManifest, 'tools' | 'secrets' | 'settings' | 'commands' | 'model'> | null, host: PluginHostEnforcement | null = null,
): PluginDeclarationItem[] {
  const items: PluginDeclarationItem[] = [];
  const egress = egressReadWarning(p.host, { pages: p.pages.length > 0 });
  items.push(runtimeItem(p, host));
  if (p.runtime === 'in-process') {
    items.push({ id: 'in-process', kind: 'in-process', label: 'Has the server\'s full authority', detail: 'Needs its own approval (approveInProcess) for this content', guidance: IN_PROCESS_NOTE });
  }
  items.push(...networkItems(p, host));
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
  for (const page of p.pages) {
    items.push({
      id: `page:${page.path}`, kind: 'page', label: `Adds the page "${page.title}"`, detail: `/${page.path} → ${page.entry}`,
      guidance: egress ? `${PAGE_EGRESS_NOTE} ${egress}` : PAGE_EGRESS_NOTE,
    });
  }
  if (p.ui) items.push({ id: 'ui', kind: 'page', label: 'Serves its page files', detail: `${p.ui.dir}/${p.ui.sha256 ? `, sha256 ${p.ui.sha256}` : ''}` });
  // Names from the summary (a listing carries them); the manifest's labels and required flags when at hand.
  if (p.secrets.length > 0) {
    const of = new Map((manifest?.secrets ?? []).map((s) => [s.key, s]));
    items.push({
      id: 'secrets', kind: 'secret', label: `Asks you for these secrets: ${p.secrets.join(', ')}`,
      detail: p.secrets.map((k) => { const s = of.get(k); return s ? `${k} ("${s.label}"${s.required ? ', required' : ''})` : k; }).join('; '),
      guidance: 'You enter them; the package gets each one as an environment variable of its server, and whatever it can reach with them.',
    });
  }
  if (p.settings.length > 0) {
    items.push({ id: 'settings', kind: 'setting', label: `Asks you for these settings: ${p.settings.join(', ')}`, detail: p.settings.join(', ') });
  }
  if (p.trustedInput) {
    items.push({
      id: PLUGIN_MODEL_CLI_TOOLS_APPROVAL, kind: 'model-cli-tools', label: 'Asks to run its model calls on CLI lanes',
      detail: `model.trustedInput${manifest?.model?.reason ? `: "${manifest.model.reason}"` : ''}`, guidance: MODEL_CLI_TOOLS_WARNING,
    });
  }
  items.push({
    id: 'protection', kind: 'protection', label: `Sees data up to protection level ${p.maxProtection}`, detail: `maxProtection ${p.maxProtection}`,
    ...(p.pages.length > 0 ? { guidance: 'Level 1 at most, whatever it declares: its pages can send what they show to any website.' } : {}),
  });
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
  if (item.kind === 'network' && item.guidance?.includes('sites nobody vetted')) return 'warning';
  if (item.label.startsWith('NOT sandboxed') || item.label === 'Network not enforced on this host' || item.guidance?.startsWith('Network not enforced')) return 'warning';
  if (item.kind === 'tool' && item.id && item.label.endsWith('(external)')) return 'warning';
  if (item.guidance?.includes('send what it reads anywhere') || item.guidance?.includes('send what it shows to any website')) return 'warning';
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
