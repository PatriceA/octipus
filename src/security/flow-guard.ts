/**
 * Flow guard — a light, deterministic information-flow check, after OpenAPPA's
 * APPA model (https://github.com/archestra-ai/OpenAPPA), cut down to what the
 * existing ALLOW/ASK/DENY layer does not already cover.
 *
 * Each session carries a label that only ever gets stricter:
 *
 *   - `suspicious` — the session has read text written by outsiders (web
 *     pages, email, issue comments, external MCP results);
 *   - `private`    — it has read the user's own data (mail, drive, chat,
 *     databases);
 *   - `secret`     — it has read credential material (`.env`, `~/.ssh`, …).
 *
 * Every tool call is classified by a static contract (toolId + action + args):
 * what it adds to the label, and whether it can carry data out (egress). The
 * guard only ever escalates ALLOW to ASK, and only for the exfiltration shapes:
 *
 *   - any egress after `secret`;
 *   - a write-egress (send, post, push, external mutation) after `private`
 *     AND `suspicious` — the "lethal trifecta".
 *
 * The approval itself is the existing human-in-the-loop path: an approval
 * clears that one call, never the label. Unattended runs get `blocked`, as for
 * any ASK. Nothing is added to prompts or tool results, so the steady-state
 * token cost is zero; a refused call costs one short reason line.
 *
 * Children share their root's `sessionId`, so the label is family-wide: a
 * child that read a secret taints the parent's later sends too (conservative).
 *
 * In-memory, LRU-bounded. A restart forgets labels — acceptable for a guard
 * whose failure mode is "asks less", never "asks for everything".
 */
import type { PermissionCheckResult } from './permissions';

export type FlowMode = 'ask' | 'off';

export interface FlowLabel {
  suspicious: boolean;
  private: boolean;
  secret: boolean;
  /** Short, human-readable provenance of each flag (first source wins). */
  sources: Partial<Record<'suspicious' | 'private' | 'secret', string>>;
}

export interface FlowContract {
  /** What the call's result adds to the session label. */
  taints: Array<'suspicious' | 'private' | 'secret'>;
  /** Can the call carry session data out? `read` = URL/query only (fetch, search, navigate). */
  egress?: 'read' | 'write';
}

export interface FlowCall {
  toolId: string;
  action: string;
  args?: Record<string, unknown>;
}

// ── Contracts ───────────────────────────────────────────────────────────────

/** Paths and commands that expose the requester's credentials. */
const CREDENTIAL_RE = new RegExp(
  [
    String.raw`(^|[\s/"'=])\.env(?!\.(example|sample|template|dist)\b)(\.[\w.-]+)?\b`,
    String.raw`\.ssh/`, String.raw`\bid_(rsa|dsa|ecdsa|ed25519)\b`, String.raw`\.aws/`, String.raw`\.azure/`,
    String.raw`\.config/gcloud/`, String.raw`\.config/gh/`, String.raw`\.kube/`, String.raw`\.docker/config\.json`,
    String.raw`\.netrc\b`, String.raw`\.git-credentials\b`, String.raw`\.npmrc\b`, String.raw`\.pypirc\b`,
    String.raw`\.gnupg/`, String.raw`\.password-store/`, String.raw`\.vault-token\b`, String.raw`credentials\.json\b`,
    String.raw`\.claude\.json\b`, String.raw`/proc/[^\s/]+/environ\b`, String.raw`Library/Keychains/`,
    String.raw`[\w.-]*(key|private)[\w.-]*\.pem\b`, String.raw`\.p12\b`, String.raw`\.pfx\b`,
  ].join('|'),
  'i',
);

/** Shell commands that reach the network. The CLI shell guard blocks some of these; this covers the rest. */
const NETWORK_CMD_RE =
  /(^|[\s;&|(`])(curl|wget|nc|ncat|netcat|socat|telnet|ftp|sftp|scp|rsync|ssh|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)(\s|$)|\bgit\s+push\b|\bgh\s+(issue|pr|api|gist|release|repo\s+create)\b|\bnpm\s+publish\b/i;

/** MCP tool names that only read. Anything else on an external server may mutate. */
const MCP_READ_VERB_RE = /^(get|list|search|read|fetch|query|find|describe|lookup|view|show|count|retrieve)(_|-|[A-Z]|$)/;

/** Same shape as `SECRET_PLACEHOLDER_PATTERN` in db/schema/vault.ts. */
const VAULT_PLACEHOLDER_RE = /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g;

const CLAUDE_READERS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);

function argText(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  try { return JSON.stringify(args); } catch { return ''; }
}

function command(args: Record<string, unknown> | undefined): string {
  const c = args?.command ?? args?.cmd;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.join(' ') : '';
}

/** Static contract for one call. Pure. */
export function classifyFlow(call: FlowCall): FlowContract {
  const { toolId, args } = call;
  // `mcp_call_tool` resolves to `<server>.<tool>`; take the tool part.
  const action = call.action.includes('.') && toolId === 'mcp' ? call.action.split('.').pop()! : call.action;
  const taints: FlowContract['taints'] = [];

  // Vendor CLI tools: Claude's permission relay, plus every tool use the
  // Claude/Codex output stream reports (auto-allowed reads never hit the relay).
  if (toolId.startsWith('cli-native:')) {
    const name = toolId.slice('cli-native:'.length);
    if (name === 'WebFetch' || name === 'WebSearch' || name === 'web_search') return { taints: ['suspicious'], egress: 'read' };
    const cmd = command(args);
    if (cmd) {
      if (CREDENTIAL_RE.test(cmd)) taints.push('secret');
      return NETWORK_CMD_RE.test(cmd) ? { taints, egress: 'write' } : { taints };
    }
    if (CLAUDE_READERS.has(name) && CREDENTIAL_RE.test(argText(args))) return { taints: ['secret'] };
    return { taints };
  }

  switch (toolId) {
    case 'filesystem':
      return action === 'read' || action === 'read_file' || action === 'list'
        ? { taints: CREDENTIAL_RE.test(argText(args)) ? ['secret'] : [] } : { taints };
    case 'shell':
    case 'docker': {
      const cmd = command(args);
      if (CREDENTIAL_RE.test(cmd)) taints.push('secret');
      // `docker exec` shares the shell's reach; build/start are not data egress.
      return NETWORK_CMD_RE.test(cmd) ? { taints, egress: 'write' } : { taints };
    }
    case 'websearch':
      return { taints: ['suspicious'], egress: 'read' };
    case 'browser':
    case 'browser-ext':
      if (action === 'cookies') return { taints: ['secret'] };
      if (action === 'screenshot' || action === 'tabs') return { taints: ['suspicious'] };
      // Typing into a page or running script can submit a form; navigating only carries a URL.
      return { taints: ['suspicious'], egress: action === 'navigate' || action === 'extract' ? 'read' : 'write' };
    case 'google-workspace':
    case 'microsoft365':
      if (action.endsWith('_read')) return { taints: action === 'email_read' ? ['private', 'suspicious'] : ['private'] };
      // Mail, invites and shared docs reach other people.
      return { taints, egress: 'write' };
    case 'messaging':
      if (action === 'read' || action === 'list') return { taints: ['private', 'suspicious'] };
      return { taints, egress: 'write' };
    case 'email-processor':
      return { taints: ['private', 'suspicious'] };
    case 'data':
      return { taints: ['private'] };
    case 'github':
    case 'gitlab':
    case 'atlassian':
      // Issue and PR text can be written by anyone who can comment.
      if (action === 'read') return { taints: ['suspicious'] };
      return { taints, egress: 'write' };
    case 'git':
      return action === 'push' ? { taints, egress: 'write' } : { taints };
    case 'voice':
      return action === 'initiate_call' ? { taints, egress: 'write' } : { taints };
    case 'mcp':
      if (action === 'mcp_list_tools') return { taints };
      // External servers: results are outsider text; non-read verbs may send.
      return MCP_READ_VERB_RE.test(action) ? { taints: ['suspicious'] } : { taints: ['suspicious'], egress: 'write' };
    default:
      return { taints };
  }
}

// ── Session labels ──────────────────────────────────────────────────────────

const MAX_SESSIONS = 2_000;
const labels = new Map<string, FlowLabel>();

function empty(): FlowLabel {
  return { suspicious: false, private: false, secret: false, sources: {} };
}

export function getFlowLabel(sessionId: string | undefined): FlowLabel {
  return (sessionId && labels.get(sessionId)) || empty();
}

/** Record what a successful (or approved, for CLI-native) call read. Monotonic. */
export function observeFlow(sessionId: string | undefined, call: FlowCall, contract = classifyFlow(call)): void {
  if (!sessionId || contract.taints.length === 0) return;
  const label = labels.get(sessionId) ?? empty();
  labels.delete(sessionId); // re-insert: Map order doubles as LRU order
  for (const t of contract.taints) {
    if (!label[t]) {
      label[t] = true;
      label.sources[t] = `${call.toolId}:${call.action}`;
    }
  }
  labels.set(sessionId, label);
  if (labels.size > MAX_SESSIONS) labels.delete(labels.keys().next().value as string);
}

export function clearFlowLabel(sessionId: string): void {
  labels.delete(sessionId);
  sharedAudience.delete(sessionId);
  lookedUp.delete(sessionId);
  uncertain.delete(sessionId);
}

/** Test seam. */
export function resetFlowLabels(): void {
  labels.clear();
  sharedAudience.clear();
  lookedUp.clear();
  uncertain.clear();
}

// ── Shared audience (group channels) ────────────────────────────────────────

/**
 * Sessions whose replies are posted to a group channel. Two extra rules apply:
 * the session starts `suspicious` (its prompt carries other members' text),
 * and reading the requester's private data needs approval, because whatever
 * it returns can end up in a reply everyone in the channel sees.
 */
const sharedAudience = new Set<string>();
/**
 * Far above `MAX_SESSIONS`: losing a mark mid-turn would silently drop the
 * approval this rule promises, while each entry is one id (~10 MB at the cap).
 */
const MAX_SHARED_SESSIONS = 100_000;

/**
 * Mark a group-channel session. The root agent service calls this at the start
 * of every turn in a session with `group_channel_id` set (the durable source
 * of truth), so a restart or another entry point costs nothing.
 */
export function markSharedAudience(sessionId: string): void {
  sharedAudience.delete(sessionId);
  sharedAudience.add(sessionId);
  if (sharedAudience.size > MAX_SHARED_SESSIONS) sharedAudience.delete(sharedAudience.values().next().value as string);
  observeFlow(sessionId, { toolId: 'group-channel', action: 'transcript' }, { taints: ['suspicious'] });
}

export function isSharedAudience(sessionId: string | undefined): boolean {
  return !!sessionId && (sharedAudience.has(sessionId) || uncertain.has(sessionId));
}

/** Sessions already looked up by `ensureSharedAudienceKnown` (bounded). */
const lookedUp = new Set<string>();
/**
 * Sessions whose lookup failed: treated as shared until a lookup succeeds, so
 * a database hiccup makes the guard ask more, never less.
 */
const uncertain = new Set<string>();

function rememberLookup(sessionId: string): void {
  lookedUp.add(sessionId);
  if (lookedUp.size > MAX_SHARED_SESSIONS) lookedUp.delete(lookedUp.values().next().value as string);
}

/**
 * The root agent service read the session and it is not a group thread:
 * record that, so the first tool call does not look it up again.
 */
export function markNotSharedAudience(sessionId: string): void {
  uncertain.delete(sessionId);
  if (!sharedAudience.has(sessionId)) rememberLookup(sessionId);
}

/**
 * Make sure a group-thread session is marked before its first tool call, from
 * the stored `sessions.group_channel_id` — whatever started the run (a hook
 * spawning an agent, the agents API, a run resumed after a restart). One
 * lookup per session per process; the root agent service also marks on
 * every turn.
 */
export async function ensureSharedAudienceKnown(sessionId: string | undefined): Promise<void> {
  if (!sessionId || sharedAudience.has(sessionId) || lookedUp.has(sessionId)) return;
  // Synthetic contexts (e.g. `artifact-refresh:<id>`) have no session row.
  const { isUuid } = await import('@/db/repositories/scoped');
  if (!isUuid(sessionId)) { rememberLookup(sessionId); return; }
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  let session: { groupChannelId?: string | null } | null;
  try {
    session = await sessionRepository.findById(sessionId);
  } catch {
    // Fail closed: ask as for a group thread until a lookup succeeds — the
    // private-read rule via `uncertain`, and the untrusted-text taint a group
    // session starts with (labels only tighten, so this one stays).
    uncertain.add(sessionId);
    if (uncertain.size > MAX_SHARED_SESSIONS) uncertain.delete(uncertain.values().next().value as string);
    observeFlow(sessionId, { toolId: 'group-channel', action: 'unconfirmed' }, { taints: ['suspicious'] });
    return;
  }
  uncertain.delete(sessionId);
  rememberLookup(sessionId);
  if (session?.groupChannelId) markSharedAudience(sessionId);
}

/** Why a private read in a shared-audience session needs a human, or undefined. Pure. */
export function sharedAudienceReason(shared: boolean, call: FlowCall, contract: FlowContract, unconfirmed = false): string | undefined {
  if (!shared || !contract.taints.includes('private')) return undefined;
  const where = unconfirmed
    ? 'it could not be confirmed whether this conversation is in a shared group channel'
    : 'this conversation is in a shared group channel';
  return `flow guard: ${where} and ${call.toolId}:${call.action} reads private data; `
    + 'anything it returns may be posted where every member can read it, so it needs approval';
}

// ── Decision ────────────────────────────────────────────────────────────────

/** Why this call needs a human, or undefined when the label allows it. Pure given the label. */
export function flowBlockReason(label: FlowLabel, contract: FlowContract): string | undefined {
  if (!contract.egress) return undefined;
  if (label.secret) {
    return `flow guard: this session read credential material (${label.sources.secret}); `
      + 'sending anything out needs approval';
  }
  if (contract.egress === 'write' && label.private && label.suspicious) {
    return `flow guard: this session mixed private data (${label.sources.private}) with untrusted content `
      + `(${label.sources.suspicious}); sending it out needs approval`;
  }
  return undefined;
}

/**
 * Is this an Octipus tool call authenticated through the vault? Such a call
 * is exempt from the egress check: the credential never enters the session,
 * and the vault is the sanctioned way to use one. Every `{{secret:NAME}}` in
 * the arguments must name an active entry this tool may use — tools leave an
 * unresolved placeholder as plain text, so a made-up one must not buy an
 * exemption. Vendor-native CLI tools never resolve placeholders, so never
 * qualify. Only consulted when the guard would otherwise ask: no DB read on
 * the common path, and no secret is decrypted.
 */
export async function isVaultAuthenticated(userId: string, call: FlowCall): Promise<boolean> {
  if (call.toolId.startsWith('cli-native:')) return false;
  const names = [...new Set([...argText(call.args).matchAll(VAULT_PLACEHOLDER_RE)].map(m => m[1] as string))];
  if (names.length === 0) return false;
  const { getVault } = await import('./vault');
  const vault = getVault();
  for (const name of names) {
    const ok = (userId && userId !== 'system' && await vault.canAccessByName(userId, name, { toolId: call.toolId }))
      || await vault.canAccessByName('system', name, { toolId: call.toolId });
    if (!ok) return false;
  }
  return true;
}

/**
 * Apply the guard to a permission result: ALLOW becomes ASK with a reason,
 * ASK keeps ASK (the reason is added), DENY is untouched. Returns the input
 * unchanged when the mode is off or the flow is clean.
 */
export function applyFlowGuard(
  mode: FlowMode | undefined,
  sessionId: string | undefined,
  call: FlowCall,
  permission: PermissionCheckResult,
): PermissionCheckResult {
  if (mode === 'off' || permission.level === 'DENY') return permission;
  // Judge against what the session holds after this call too: `cat .env | curl …`
  // reads and sends in one step.
  const contract = classifyFlow(call);
  const label = { ...getFlowLabel(sessionId) };
  label.sources = { ...label.sources };
  for (const t of contract.taints) if (!label[t]) { label[t] = true; label.sources[t] = `${call.toolId}:${call.action}`; }
  const reason = flowBlockReason(label, contract) ?? sharedAudienceReason(
    isSharedAudience(sessionId), call, contract, !!sessionId && uncertain.has(sessionId) && !sharedAudience.has(sessionId));
  if (!reason) return permission;
  return { ...permission, level: 'ASK', allowed: false, requiresApproval: true, reason, source: 'flow-guard' };
}
