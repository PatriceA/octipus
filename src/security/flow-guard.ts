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
 * In-memory, LRU-bounded, and written through to `sessions.flow_label`: a
 * flag is persisted the first time a session gains it, and
 * `loadFlowLabel` / `ensureSharedAudienceKnown` merge the stored label back
 * after a restart or in another process. The space I6 rule (approval-route)
 * reads the label after loading it, so data read before a restart still
 * asks before it is written into a space.
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
  const gained: StoredFlowLabel = {};
  for (const t of contract.taints) {
    if (!label[t]) {
      label[t] = true;
      label.sources[t] = `${call.toolId}:${call.action}`;
      gained[t] = label.sources[t];
    }
  }
  labels.set(sessionId, label);
  if (labels.size > MAX_SESSIONS) labels.delete(labels.keys().next().value as string);
  if (Object.keys(gained).length > 0) persistGained(sessionId, gained);
}

export function clearFlowLabel(sessionId: string): void {
  labels.delete(sessionId);
  sharedAudience.delete(sessionId);
  lookedUp.delete(sessionId);
  uncertain.delete(sessionId);
  // Cleared, not unknown: the stored label is not merged back in this process.
  rememberLoaded(sessionId);
  storeWrite(sessionId, 'clearing', (repo) => repo.clearFlowLabel(sessionId));
}

/** Test seam. */
export function resetFlowLabels(): void {
  labels.clear();
  remoteConsented.clear();
  sharedAudience.clear();
  lookedUp.clear();
  uncertain.clear();
  loaded.clear();
}

// ── Stored labels ───────────────────────────────────────────────────────────

/** `sessions.flow_label`: each flag a session gained, with its first source. */
export type StoredFlowLabel = Partial<Record<'suspicious' | 'private' | 'secret', string>>;

/** Sessions whose stored label this process has merged (bounded). */
const loaded = new Set<string>();

function isUuidShape(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function flowLogger() {
  return (await import('@/utils/logger')).securityLogger;
}

type SessionRepo = typeof import('@/db/repositories/session-repository')['sessionRepository'];
/** The last stored-label write of each session: writes of one session land in order (a room's clear, then its turn's flags). */
const storeWrites = new Map<string, Promise<void>>();

/** Queue a write of the session's stored label behind its previous one (synthetic ids have no row). */
function storeWrite(sessionId: string, what: string, write: (repo: SessionRepo) => Promise<void>): void {
  if (!isUuidShape(sessionId)) return;
  const next = (storeWrites.get(sessionId) ?? Promise.resolve())
    .then(async () => write((await import('@/db/repositories/session-repository')).sessionRepository))
    .catch((err) => flowLogger().then((log) => log.error({ err, sessionId }, `flow label: ${what} the stored label failed`)));
  storeWrites.set(sessionId, next);
  void next.finally(() => { if (storeWrites.get(sessionId) === next) storeWrites.delete(sessionId); });
}

/** Write newly gained flags through to the session row. */
function persistGained(sessionId: string, gained: StoredFlowLabel): void {
  storeWrite(sessionId, 'persisting', (repo) => repo.addFlowLabel(sessionId, gained));
}

function rememberLoaded(sessionId: string): void {
  loaded.add(sessionId);
  if (loaded.size > MAX_SHARED_SESSIONS) loaded.delete(loaded.values().next().value as string);
}

/** Merge a stored label into the in-memory one (labels only tighten). */
function mergeStored(sessionId: string, stored: StoredFlowLabel | null | undefined): void {
  rememberLoaded(sessionId);
  if (!stored) return;
  const label = labels.get(sessionId) ?? empty();
  labels.delete(sessionId);
  for (const t of ['suspicious', 'private', 'secret'] as const) {
    const source = stored[t];
    if (typeof source === 'string' && !label[t]) {
      label[t] = true;
      label.sources[t] = source;
    }
  }
  labels.set(sessionId, label);
  if (labels.size > MAX_SESSIONS) labels.delete(labels.keys().next().value as string);
}

/**
 * Merge the session's stored label (`sessions.flow_label`) into this
 * process, once per session. Throws when the row cannot be read: the
 * caller is deciding whether a write needs consent and must not decide on
 * a label it could not load.
 */
export async function loadFlowLabel(sessionId: string | undefined): Promise<void> {
  if (!sessionId || loaded.has(sessionId)) return;
  if (!isUuidShape(sessionId)) { mergeStored(sessionId, null); return; }
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  mergeStored(sessionId, session?.flowLabel as StoredFlowLabel | null | undefined);
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
  let session: { groupChannelId?: string | null; kind?: string | null; flowLabel?: unknown } | null;
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
  if (!loaded.has(sessionId)) mergeStored(sessionId, session?.flowLabel as StoredFlowLabel | null | undefined);
  // A group thread, or a room (coworking §6.4): replies everyone reads.
  if (session?.groupChannelId || session?.kind === 'room') markSharedAudience(sessionId);
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

// ── Federated audience (docs/plans/federation-spec.md §7.5, FI5) ────────────

/**
 * Why a call is refused outright in a federated run — one whose output
 * members of other installs read (a `remote` turn, or a room with a remote
 * member, read again at every decision) — or undefined. Wider than a
 * room's audience, so stricter: no approval lets a host member's personal
 * data or credential material go there.
 *
 *   - a read of the requester's private data (`private` taint, or a read
 *     through a personal connection: `personalRead`) is refused, where a
 *     room asks;
 *   - a read of credential material (`secret` taint) is refused;
 *   - once the session holds a `private` or `secret` label (read before the
 *     run became federated), any egress is refused — a send out of the
 *     install, or a write into the space (`spaceWrite`: notes, files,
 *     memory, tasks), which the space's remote members read.
 */
export function federatedAudienceReason(label: FlowLabel, call: FlowCall, contract: FlowContract, personalRead = false, spaceWrite = false): string | undefined {
  const name = `${call.toolId}:${call.action}`;
  if (contract.taints.includes('private') || personalRead) {
    return `flow guard: members of this room on other installs read what this run produces, and ${name} reads personal data; `
      + 'personal data never goes to them';
  }
  if (contract.taints.includes('secret')) {
    return `flow guard: members of this room on other installs read what this run produces, and ${name} reads credential material`;
  }
  if ((contract.egress || spaceWrite) && (label.secret || label.private)) {
    const what = label.secret ? `credential material (${label.sources.secret})` : `personal data (${label.sources.private})`;
    return `flow guard: this session read ${what}, and members of this room on other installs read what this run produces; nothing goes out`;
  }
  return undefined;
}

/**
 * Why a write into a space that has members of other installs is refused
 * outright, in a run whose own audience is not federated (a private
 * session of the space): credential material never goes there. Personal
 * data asks (the I6 consent, whose text names the other installs).
 */
export function federatedSpaceWriteReason(label: FlowLabel, call: FlowCall): string | undefined {
  if (!label.secret) return undefined;
  return `flow guard: this session read credential material (${label.sources.secret}), and ${call.toolId}:${call.action} writes into a space `
    + 'that members on other installs read; nothing goes there';
}

// ── Spaces on other installs (docs/plans/federation-spec.md §9) ─────────────

/**
 * Sessions whose member approved a write of their own agent into a space
 * on another install (a post, a note proposal, a task with text). Bounded
 * like the shared-audience marks; losing one only asks again.
 */
const remoteConsented = new Set<string>();

/**
 * Why a write of the member's own agent into a space on another install
 * (`remote_space_post` and the other writes that carry text there) needs
 * the member, or undefined. Treated like a post to a shared audience,
 * stricter: once the session read private data or credential material,
 * EVERY such write asks (labels only tighten); a clean session asks the
 * first time, then not again in that session. Whatever the flow-guard
 * mode. Pure given the label and the consent set.
 */
export function remoteSpaceWriteReason(sessionId: string | undefined, call: FlowCall): string | undefined {
  const label = getFlowLabel(sessionId);
  const name = `${call.toolId}:${call.action}`;
  if (label.secret) {
    return `flow guard: this session read credential material (${label.sources.secret}), and ${name} sends text to a space on another install; `
      + 'every such write needs approval';
  }
  if (label.private) {
    return `flow guard: this session read your private data (${label.sources.private}), and ${name} sends text to a space on another install `
      + 'whose members read it; every such write needs approval';
  }
  if (!sessionId || !remoteConsented.has(sessionId)) {
    return `${name} sends text to a space on another install, where its members read it: the first write of this conversation needs approval`;
  }
  return undefined;
}

/** The member approved a write into a space on another install in `sessionId`: later clean writes there go ahead. */
export function markRemoteSpaceWriteConsented(sessionId: string | undefined): void {
  if (!sessionId) return;
  remoteConsented.delete(sessionId);
  remoteConsented.add(sessionId);
  if (remoteConsented.size > MAX_SHARED_SESSIONS) remoteConsented.delete(remoteConsented.values().next().value as string);
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
 * the common path, and no secret is decrypted. Only `user` and `system` rows
 * count (`canAccessByName`): a space connector's secret (scope `space`,
 * coworking §9.5) is never injected, so it never buys an exemption either.
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
