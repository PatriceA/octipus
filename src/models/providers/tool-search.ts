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
 * (replayed with the rest of the assistant content), so a tool the conversation
 * reaches for later no longer changes the tool block: the deferred tools add
 * nothing to the prefix, and the loaded set is a fixed floor.
 *
 * The non-deferred set must itself never change for a conversation, so it is
 * a fixed floor (`AgentWorker.nativeToolSearchDeferrals`), not the sticky
 * selection.
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

/** The blocks a tool search leaves in an assistant turn. */
const SEARCH_BLOCK_TYPES = new Set(['server_tool_use', 'tool_search_tool_result']);

/**
 * Drop earlier tool-search blocks from replayed assistant turns, for a request
 * that does not declare the search tool (the setting turned off, the lazy path
 * left): a search result for a tool the request cannot search is not one the
 * API is guaranteed to accept. Mutates `messages`.
 */
export function withoutSearchBlocks(messages: Array<{ role: string; content: unknown }>): void {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const kept = (message.content as Array<{ type?: string }>).filter((block) => !SEARCH_BLOCK_TYPES.has(String(block.type)));
    // A turn of nothing but search blocks keeps them: an empty content array is rejected.
    if (kept.length && kept.length !== message.content.length) message.content = kept;
  }
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
