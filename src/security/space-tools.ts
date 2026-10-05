/**
 * What an agent may call inside a space (docs/plans/coworking-spec.md §5.6).
 *
 * - `COMMENTER_TOOLS` — the explicit per-tool list a commenter's (or guest's)
 *   turn may run: read and search tools, `*_read` connector actions (as the
 *   flow guard classifies them), and task comments. Not `isReadOnlyAction`:
 *   a tool is allowed for commenters because it is named here.
 * - Writes are allowed only through containers known to act on the space
 *   (`SPACE_TOOL_IDS`, an allowlist). Personal-only tools — scheduling,
 *   monitors, pipelines and recipes, memory, profile and skill tools,
 *   `sync_vault`, `index_file` / `index_directory`, meeting notes, MCP
 *   server administration, skill distillation, and every write through the
 *   requester's personal connections (OAuth connectors, their MCP servers,
 *   their real browser) — act on the requester's own account and
 *   automation, so a space session neither gets them offered
 *   (`withoutPersonalOnlyTools`) nor runs them (`personalOnlyReason`, in
 *   `routeApprovalFor`). The agent is told why (`spaceSessionNotice`).
 * - Reads through those personal connections are allowed and mark the
 *   session `private` (`personalSourceRead`), so the I6 rule asks before
 *   their data is written into the space.
 * - The space's own connectors (§9.5) are not personal: in a space session
 *   the GitHub tool, the Atlassian tool and `connector_*` act only through
 *   the space's connection (`connectorOwnerOf`, the GitHub tool's space
 *   token), never the member's, so they are space tools
 *   (`SPACE_CONNECTOR_TOOL_IDS`) — their writes follow the member's role and
 *   their reads do not mark the session private.
 * - `isReadCall` — the calls that read; every other call in a space session
 *   counts as a write for the I6 rule.
 * - `isAgentConfigPath` — a coding agent's configuration under the space's
 *   file root (`.claude/`, `.codex/`, …) is never written from a space.
 */
import type { ToolHandler } from '@/core/agent-base';
import type { SpaceRole } from './space-access';

/** One tool call as the approval path sees it. */
export interface SpaceToolCall {
  /** Tool container id (`notes`, `filesystem`, `mcp`, `cli-native:Read`, …). */
  toolId: string;
  /** The permission action (a manifest verb such as `read`, or the tool name). */
  action: string;
  /** The bare tool name within its container (`read_note`), when the path knows it. */
  toolName?: string;
  /** The call's arguments, when the path has them (target paths, `connector_call_tool`'s remote tool). */
  args?: Record<string, unknown>;
}

/** `toolId:toolName` of every tool a commenter's turn may run. */
export const COMMENTER_TOOLS: ReadonlySet<string> = new Set([
  'notes:read_note', 'notes:list_notes', 'notes:search_notes', 'notes:query_notes', 'notes:suggest_links',
  'tasks:list_tasks', 'tasks:add_task_comment',
  'documents:list_documents', 'documents:get_document', 'documents:search_documents',
  'knowledge:knowledge_stats', 'knowledge:search_knowledge', 'knowledge:read_knowledge',
  'knowledge:get_backlinks', 'knowledge:traverse_knowledge',
  'artifacts:list_live_artifacts', 'artifacts:get_live_artifact',
  'filesystem:read_file', 'filesystem:list_directory', 'filesystem:file_info', 'filesystem:search_files',
  'websearch:search', 'websearch:fetch_page',
  'task_state:list_recent_session_tasks', 'task_state:read_task_state',
  'skill_runtime:read_resource',
  // Room posts (S2) are not a tool: a room turn's answer is posted as the
  // turn's reply, which a commenter's turn may give.
]);

/** Connector containers whose `*_read` actions count as reads (flow-guard.ts `classifyFlow`). */
const READ_SUFFIX_TOOL_IDS = new Set(['google-workspace', 'microsoft365']);

/** Whether a commenter's (or guest's) turn may run this call. */
export function commenterMayRun(call: SpaceToolCall): boolean {
  if (READ_SUFFIX_TOOL_IDS.has(call.toolId) && call.action.endsWith('_read')) return true;
  return !!call.toolName && COMMENTER_TOOLS.has(`${call.toolId}:${call.toolName}`);
}

/** Permission actions that only read. */
const READ_ACTIONS = new Set(['read', 'list', 'search', 'fetch', 'inspect', 'read_file']);
/** Vendor CLI tools that only read (the flow guard's `CLAUDE_READERS`). */
const CLI_READERS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);
/** MCP tool names that only read (the flow guard's `MCP_READ_VERB_RE`). */
const MCP_READ_VERB_RE = /^(get|list|search|read|fetch|query|find|describe|lookup|view|show|count|retrieve)(_|-|[A-Z]|$)/;
/** Remote tool names of a connector that only read. */
const CONNECTOR_READ_NAME_RE = /^(get|list|search|read|view|fetch|query|find|lookup|show|count|retrieve)(_|$)|_(list|search|read|view|get|info|history|labels|folders|diff|checks|log|lists|tasks|events)$/;
/** Actions of a personal-source container that only read, beyond the shared read verbs. */
const SOURCE_READ_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Not `cookies` (credential material) nor `tabs` (acts on the real browser).
  'browser-ext': new Set(['screenshot', 'extract']),
  data: new Set(['query']),
};

/**
 * Whether this call only reads. In a space session every other call is
 * treated as a write into the space for the I6 rule — conservative on
 * purpose: shell and MCP writes land in the space's files or reach out.
 */
export function isReadCall(call: SpaceToolCall): boolean {
  if (call.toolId.startsWith('cli-native:')) return CLI_READERS.has(call.toolId.slice('cli-native:'.length));
  if (call.toolId === 'mcp') {
    const tool = call.action.includes('.') ? call.action.split('.').pop() as string : call.action;
    return tool === 'mcp_list_tools' || MCP_READ_VERB_RE.test(tool);
  }
  if (call.toolId === 'connector') {
    // `connector_call_tool` names the remote tool in its arguments; remote
    // names are MCP tool names (`searchJiraIssuesUsingJql`, `get_page`).
    if (call.toolName === 'connector_list_tools') return true;
    const remote = call.args?.tool_name;
    return call.toolName === 'connector_call_tool' && typeof remote === 'string'
      && (MCP_READ_VERB_RE.test(remote) || CONNECTOR_READ_NAME_RE.test(remote));
  }
  if (SOURCE_READ_ACTIONS[call.toolId]?.has(call.action)) return true;
  if (READ_ACTIONS.has(call.action) || call.action.endsWith('_read')) return true;
  if ((PERSONAL_SOURCE_TOOL_IDS.has(call.toolId) || SPACE_CONNECTOR_TOOL_IDS.has(call.toolId))
    && call.action === call.toolName && CONNECTOR_READ_NAME_RE.test(call.action)) return true;
  return commenterMayRun(call) && call.toolName !== 'add_task_comment';
}

/**
 * Connector containers that, in a space session, act only through the
 * space's own connection (§9.5): the GitHub tool (the space's token, or a
 * refusal), the Atlassian tool and `connector_*` (`connectorOwnerOf`). They
 * are space tools there.
 */
export const SPACE_CONNECTOR_TOOL_IDS: ReadonlySet<string> = new Set(['github', 'atlassian', 'connector']);

/**
 * Containers known to act only on the space when they write: its content
 * (notes, tasks, documents, knowledge, artifacts, files), a sandbox, or the
 * host tools a space session runs in the space's file root. In a space
 * session a write through any other container is personal-only — an
 * allowlist, so a container added later (a plugin, a new connector) is
 * refused until it is listed here. `action_recovery` is the replay review.
 */
const SPACE_TOOL_IDS = new Set([
  'notes', 'tasks', 'documents', 'knowledge', 'artifacts', 'artifacts_toolbox', 'task_state', 'plan',
  'filesystem', 'shell', 'git', 'docker', 'browser', 'websearch', 'visual', 'repo_registry',
  'skill_runtime', 'test_container', 'action_recovery',
  // The space's own connectors (`SPACE_CONNECTOR_TOOL_IDS`).
  ...SPACE_CONNECTOR_TOOL_IDS,
  // `remember_for_space` (routed as `space_memory.write`): the space's own memory.
  'space_memory',
]);
/** Whole containers that act on the requester's own automation, records or configuration. */
const PERSONAL_ONLY_TOOL_IDS = new Set(['scheduling', 'monitor', 'profiles', 'mcp_admin', 'skill-distill']);
/** Single tools (handler names) that do. */
const PERSONAL_ONLY_TOOL_NAMES = new Set([
  // Pipelines and recipes run personal automation.
  'create_pipeline', 'list_pipeline_templates', 'list_recipes', 'invoke_recipe',
  // Memory tools write the requester's personal memories (I7).
  'remember_this', 'remember_about_self', 'reflect',
  // Skills are personal configuration (a global meta-tool, no container).
  'update_skill',
  // Vault export/import is personal-only (§5.5); indexing reads personal paths.
  'notes__sync_vault', 'knowledge__index_file', 'knowledge__index_directory',
  // Meeting notes link the requester's personal profiles and calendars.
  'notes__write_meeting_note', 'notes__import_calendar_meetings',
]);
/**
 * Containers that reach the requester's own accounts: OAuth and named
 * tools of their personal connections, their MCP servers, their real
 * browser, their databases. Their reads are allowed in a space and mark the
 * session `private`; their writes are personal-only.
 */
const PERSONAL_SOURCE_TOOL_IDS = new Set([
  'google-workspace', 'microsoft365', 'messaging', 'gitlab', 'email-processor', 'voice',
  'mcp', 'browser-ext', 'data',
]);

/** Why `call` is personal-only, or undefined. */
export function personalOnlyReason(call: SpaceToolCall): string | undefined {
  const name = call.toolName;
  if (PERSONAL_ONLY_TOOL_IDS.has(call.toolId)
    || (name && (PERSONAL_ONLY_TOOL_NAMES.has(name) || PERSONAL_ONLY_TOOL_NAMES.has(`${call.toolId}__${name}`)))) {
    return `${name ?? call.toolId} acts on your personal account and automation, so it is not available in a shared space`;
  }
  // Vendor CLI tools run in the space's mode (CLI_SPACE_MODES), in its file root.
  if (call.toolId.startsWith('cli-native:')) return undefined;
  if (PERSONAL_SOURCE_TOOL_IDS.has(call.toolId)) {
    return isReadCall(call) ? undefined
      : `${call.toolId} writes through your personal connection, so it is not available in a shared space`;
  }
  if (!SPACE_TOOL_IDS.has(call.toolId) && !isReadCall(call)) {
    return `${call.toolId} is not known to act only on the space, so its writes are not available in a shared space`;
  }
  return undefined;
}

/**
 * Whether `call` reads the requester's personal data: a read through a
 * personal-source container, or through a container not known to be the
 * space's. In a space session such a read marks the session `private`, so
 * the next write into the space asks (I6).
 */
export function personalSourceRead(call: SpaceToolCall): boolean {
  if (call.toolId.startsWith('cli-native:') || SPACE_TOOL_IDS.has(call.toolId)) return false;
  return isReadCall(call);
}

/** Directory names and files that configure a coding agent run in their directory. */
const AGENT_CONFIG_DIRS = new Set(['.claude', '.codex', '.gemini', '.agents', '.vibe']);
const AGENT_CONFIG_FILES = new Set(['.mcp.json']);
/** Argument names that carry a path a call writes to. */
const PATH_ARGS = ['path', 'file_path', 'notebook_path', 'destination', 'source', 'target'];

/**
 * Whether `path` is, or lies under, a coding agent's configuration:
 * `.claude/`, `.codex/`, `.gemini/`, `.agents/`, `.vibe/` or `.mcp.json`.
 * A CLI model run in a space's file root would read those as its own
 * settings, hooks and MCP servers, so one member's agent writing there
 * would act in every other member's runs.
 */
export function isAgentConfigPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter((s) => s && s !== '.');
  return segments.some((s) => AGENT_CONFIG_DIRS.has(s.toLowerCase()))
    || AGENT_CONFIG_FILES.has((segments.at(-1) ?? '').toLowerCase());
}

/** Why a write call in a space targets a coding agent's configuration, or undefined. */
export function agentConfigWriteReason(call: SpaceToolCall): string | undefined {
  if (isReadCall(call) || !call.args) return undefined;
  for (const key of PATH_ARGS) {
    const value = call.args[key];
    if (typeof value === 'string' && isAgentConfigPath(value)) return agentConfigRefusal(value);
  }
  return undefined;
}

/** The refusal for a write to `path` (see `isAgentConfigPath`). */
export function agentConfigRefusal(path: string): string {
  return `${path} is a coding agent's configuration and cannot be written in a shared space, where it would act in other members' runs`;
}

/**
 * The handlers a space session is offered: personal-only tools dropped. A
 * handler whose action depends on its arguments (`mcp_call_tool`) is kept
 * unless its whole container is personal-only: its reads are allowed, and
 * the call-time check refuses its writes.
 */
export function withoutPersonalOnlyTools(handlers: ToolHandler[]): ToolHandler[] {
  return handlers.filter((h) => {
    const toolId = h.toolId ?? 'agent';
    const toolName = h.name.includes('__') ? h.name.slice(h.name.indexOf('__') + 2) : h.name;
    if (toolId === 'agent') return !PERSONAL_ONLY_TOOL_NAMES.has(h.name);
    if (typeof h.permissionAction === 'function' || (toolId === 'connector' && toolName === 'connector_call_tool')) {
      return !PERSONAL_ONLY_TOOL_IDS.has(toolId);
    }
    // A handler that declares itself read-only is offered as a read.
    const action = h.replaySafety === 'read_only' ? 'read' : h.permissionAction ?? toolName;
    return !personalOnlyReason({ toolId, action, toolName });
  });
}

/**
 * What the agent is told in a space session: where it is, what the role
 * allows, and why some tools are missing.
 */
export function spaceSessionNotice(spaceName: string, role: SpaceRole, mayWrite: boolean, room?: { title: string }): string {
  const where = room
    ? `this conversation is the room "${room.title}" of the shared space "${spaceName}": every member of the room reads it, and you are answering one of them`
    : `this conversation is a private session inside the shared space "${spaceName}"`;
  return `\n\nSHARED SPACE: ${where}, `
    + `where the user is ${role === 'owner' || role === 'editor' ? 'an' : 'a'} ${role}. Notes, tasks, documents, artifacts, knowledge and files you `
    + 'read and write here are the space\'s, visible to its members. '
    + (mayWrite ? '' : 'The user\'s role can only read and comment here: do not try to create or change anything except task comments. ')
    + (role === 'guest' ? 'As a guest the user reaches only some rooms and folders of the space; tools answer within that scope, so what they do not return may still exist. ' : '')
    + 'Scheduling, monitors, pipelines and recipes, memory, profile and skill tools, vault sync, indexing and writes through '
    + 'the user\'s personal connections (mail, calendar, chat, GitLab, MCP servers, their browser) are not '
    + 'available in a space, because they act on the user\'s personal account and automation. GitHub, Atlassian and the '
    + 'other connectors act here through the space\'s own connections, which a space owner connects. Coding agent configuration '
    + '(.claude, .codex, .gemini, .agents, .mcp.json) cannot be written here. The user\'s personal memories are not loaded here. '
    + 'Writing data read from the user\'s personal sources into the space needs their approval.';
}
