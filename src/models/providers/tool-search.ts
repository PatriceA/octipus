/**
 * Anthropic's server-side tool search, for the lazy tool path (C7).
 *
 * Octipus's own lazy discovery advertises a core set and lets the model reach
 * the rest through `list_tools` / `describe_tool`. The core set follows the
 * conversation (sticky groups), so a group the conversation reaches for later
 * changes the tool list — the start of the prompt — once, and with it the
 * cached prefix after that point.
 *
 * Claude's tool search removes that change on the first-party API. Every tool
 * is sent on every request; the long tail is marked `defer_loading`, which the
 * API keeps out of the prompt prefix entirely. A tool the model finds through
 * the search tool is appended inline in the conversation as a `tool_reference`
 * (replayed with the rest of the assistant content), so the tool block is the
 * same bytes from the first turn to the last.
 *
 * The non-deferred set must itself never change for a conversation, so it is
 * a fixed floor (`NATIVE_TOOL_SEARCH_FLOOR`), not the sticky selection.
 * Docs: platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
 * (GA, no beta header; Claude 4.5 and later).
 */

/** The BM25 variant: the model writes natural-language queries, not regexes. */
export const TOOL_SEARCH_TOOL = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' } as const;

/**
 * Claude models with tool search: every Fable/Mythos, Opus/Sonnet/Haiku 5 and
 * later, and the 4.5–4.9 generation. Opus 4.1 and earlier do not have it.
 */
export function supportsNativeToolSearch(modelId: string): boolean {
  const id = modelId.toLowerCase().replace(/^.*\//, '').replace(/^anthropic\./, '');
  return /^claude-(?:fable|mythos)-/.test(id) || /^claude-(?:opus|sonnet|haiku)-(?:[5-9]|4-[5-9])(?:\D|$)/.test(id);
}

/**
 * Mark `deferred` tools `defer_loading` and add the search tool first.
 * Mutates nothing it was given. A request whose every client tool is deferred
 * is still valid: the search tool itself is never deferred.
 */
export function withToolSearch(tools: Array<Record<string, unknown>>, deferred: ReadonlySet<string>): Array<Record<string, unknown>> {
  const marked = tools.map((tool) => (deferred.has(String(tool.name)) ? { ...tool, defer_loading: true } : tool));
  return [{ ...TOOL_SEARCH_TOOL }, ...marked];
}
