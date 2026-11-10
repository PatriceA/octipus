/**
 * Built-in tool ids that no longer exist.
 *
 * The Atlassian (Jira/Confluence) and GitLab tools were removed. An install
 * that ran them still has their ids in stored role tool lists (the seeder
 * merged `atlassian` into the `pm` row) and possibly in permission rules.
 * Wherever a stored tool list is read, these are dropped, so a role that
 * names one still loads, spawns and saves — the role editor sends the stored
 * list back, and `unknownToolIds` would otherwise refuse the edit.
 *
 * Permission rules that name them are left alone: no tool asks for them, and
 * the permissions page shows and deletes them like any other rule.
 */
export const RETIRED_TOOL_IDS: ReadonlySet<string> = new Set(['atlassian', 'gitlab']);

/** `toolIds` without the retired built-ins. */
export function withoutRetiredToolIds(toolIds: readonly string[]): string[] {
  return toolIds.filter((id) => !RETIRED_TOOL_IDS.has(id));
}
