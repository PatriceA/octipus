/**
 * Built-in tool ids that no longer exist.
 *
 * The Atlassian (Jira/Confluence) and GitLab tools were removed, and then the
 * built-in OAuth connector framework they had moved to: its `connector`
 * container (`connector_list_tools` / `connector_call_tool`) and the
 * `connector:<id>` role bindings that gated it per role. Plugins cover that
 * need now (a plugin brings its own tools, network hosts and secrets).
 *
 * An install that ran them still has their ids in stored role tool lists (the
 * seeder merged `atlassian` into the `pm` row; an operator may have bound
 * `connector:<id>`) and possibly in permission rules. Wherever a stored tool
 * list is read, these are dropped, so a role that names one still loads,
 * spawns and saves — the role editor sends the stored list back, and
 * `unknownToolIds` would otherwise refuse the edit.
 *
 * Permission rules that name them (`connector` / `connector_call_tool`
 * included) are left alone: no tool asks for them, and the permissions page
 * shows and deletes them like any other rule. Stored connector tokens
 * (`connector_<id>_*` vault rows, personal or space) are left alone too:
 * nothing reads them, and the Secrets page lists and deletes them.
 */
export const RETIRED_TOOL_IDS: ReadonlySet<string> = new Set(['atlassian', 'gitlab', 'connector']);

/** The prefix of a removed role↔connector binding (`connector:<id>`). */
export const RETIRED_CONNECTOR_BINDING_PREFIX = 'connector:';

/** The names of the removed connector meta-tools (`connector_list_tools`, `connector_call_tool`). */
const RETIRED_TOOL_NAME_RE = /^connector_/;

/** Whether `id` names a removed built-in tool, a removed connector binding or a removed connector tool. */
export function isRetiredToolId(id: string): boolean {
  return RETIRED_TOOL_IDS.has(id) || id.startsWith(RETIRED_CONNECTOR_BINDING_PREFIX) || RETIRED_TOOL_NAME_RE.test(id);
}

/** `toolIds` without the retired built-ins and connector bindings. */
export function withoutRetiredToolIds(toolIds: readonly string[]): string[] {
  return toolIds.filter((id) => !isRetiredToolId(id));
}
