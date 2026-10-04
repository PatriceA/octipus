/**
 * What an agent may call inside a space (docs/plans/coworking-spec.md §5.6).
 *
 * - `COMMENTER_TOOLS` — the explicit per-tool list a commenter's (or guest's)
 *   turn may run: read and search tools, `*_read` connector actions (as the
 *   flow guard classifies them), and task comments. Not `isReadOnlyAction`:
 *   a tool is allowed for commenters because it is named here.
 * - Personal-only tools — scheduling, monitors, pipelines and recipes,
 *   memory and profile tools, `sync_vault`, `index_file` /
 *   `index_directory`, meeting notes (they link personal profiles and
 *   calendars), and personal connectors' write actions — act on the
 *   requester's own account and automation, so a space session neither gets
 *   them offered (`withoutPersonalOnlyTools`) nor runs them
 *   (`personalOnlyReason`, in `routeApprovalFor`). The agent is told why
 *   (`spaceSessionNotice`).
 * - `isReadCall` — the calls that read; every other call in a space session
 *   counts as a write for the I6 rule.
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
  // Room posts join this list in S2.
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
  if (READ_ACTIONS.has(call.action) || call.action.endsWith('_read')) return true;
  return commenterMayRun(call) && call.toolName !== 'add_task_comment';
}

/** Whole containers that act on the requester's own automation or records. */
const PERSONAL_ONLY_TOOL_IDS = new Set(['scheduling', 'monitor', 'profiles']);
/** Single tools (handler names) that do. */
const PERSONAL_ONLY_TOOL_NAMES = new Set([
  // Pipelines and recipes run personal automation.
  'create_pipeline', 'list_pipeline_templates', 'list_recipes', 'invoke_recipe',
  // Memory tools write the requester's personal memories (I7).
  'remember_this', 'remember_about_self', 'reflect',
  // Vault export/import is personal-only (§5.5); indexing reads personal paths.
  'notes__sync_vault', 'knowledge__index_file', 'knowledge__index_directory',
  // Meeting notes link the requester's personal profiles and calendars.
  'notes__write_meeting_note', 'notes__import_calendar_meetings',
]);
/** Personal connectors: their reads are allowed, their writes are personal-only. */
const PERSONAL_CONNECTOR_TOOL_IDS = new Set([
  'google-workspace', 'microsoft365', 'messaging', 'github', 'gitlab', 'atlassian', 'email-processor', 'voice',
]);
const CONNECTOR_READ_NAME_RE = /^(get|list|search|read|view|fetch|query|find|lookup|show|count|retrieve)(_|$)|_(list|search|read|view|get|info|history|labels|folders|diff|checks|log|lists|tasks|events)$/;

/** Why `call` is personal-only, or undefined. */
export function personalOnlyReason(call: SpaceToolCall): string | undefined {
  const name = call.toolName;
  if (PERSONAL_ONLY_TOOL_IDS.has(call.toolId)
    || (name && (PERSONAL_ONLY_TOOL_NAMES.has(name) || PERSONAL_ONLY_TOOL_NAMES.has(`${call.toolId}__${name}`)))) {
    return `${name ?? call.toolId} acts on your personal account and automation, so it is not available in a shared space`;
  }
  if (PERSONAL_CONNECTOR_TOOL_IDS.has(call.toolId) && !connectorReads(call.action, name)) {
    return `${call.toolId} writes through your personal connection, so it is not available in a shared space`;
  }
  return undefined;
}

function connectorReads(action: string, toolName: string | undefined): boolean {
  if (READ_ACTIONS.has(action) || action.endsWith('_read')) return true;
  return action === toolName && CONNECTOR_READ_NAME_RE.test(action);
}

/**
 * The handlers a space session is offered: personal-only tools dropped. A
 * handler whose action depends on its arguments is kept only when its
 * container is not personal-only (the call-time check still runs).
 */
export function withoutPersonalOnlyTools(handlers: ToolHandler[]): ToolHandler[] {
  return handlers.filter((h) => {
    const toolId = h.toolId ?? 'agent';
    const toolName = h.name.includes('__') ? h.name.slice(h.name.indexOf('__') + 2) : h.name;
    if (toolId === 'agent') return !PERSONAL_ONLY_TOOL_NAMES.has(h.name);
    const action = typeof h.permissionAction === 'string' ? h.permissionAction : toolName;
    if (typeof h.permissionAction === 'function' && PERSONAL_CONNECTOR_TOOL_IDS.has(toolId)) return false;
    return !personalOnlyReason({ toolId, action, toolName });
  });
}

/**
 * What the agent is told in a space session: where it is, what the role
 * allows, and why some tools are missing.
 */
export function spaceSessionNotice(spaceName: string, role: SpaceRole, mayWrite: boolean): string {
  return `\n\nSHARED SPACE: this conversation is a private session inside the shared space "${spaceName}", `
    + `where the user is ${role === 'owner' || role === 'editor' ? 'an' : 'a'} ${role}. Notes, tasks, documents, artifacts, knowledge and files you `
    + 'read and write here are the space\'s, visible to its members. '
    + (mayWrite ? '' : 'The user\'s role can only read and comment here: do not try to create or change anything except task comments. ')
    + 'Scheduling, monitors, pipelines and recipes, memory and profile tools, vault sync, indexing and writes through '
    + 'the user\'s personal connectors (mail, calendar, chat, code hosts) are not available in a space, because they act '
    + 'on the user\'s personal account and automation. The user\'s personal memories are not loaded here. '
    + 'Writing data read from the user\'s personal sources into the space needs their approval.';
}
