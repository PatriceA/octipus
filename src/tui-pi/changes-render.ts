/**
 * Renders the `/changes` gateway command result for the TUI.
 *
 * The gateway `changes` command (src/core/gateway/commands.ts) returns plain
 * text — either a file list or a unified diff for one file. The messages pane
 * re-colours whole system lines with the role colour (so inline ANSI wouldn't
 * survive), but it renders ASSISTANT messages through pi-tui's Markdown, which
 * honours fenced code blocks. So the readable path is to wrap multi-line
 * output in a ```diff fence: monospace alignment for the file list, and
 * green/red +/- highlighting for a diff when the markdown theme supports it.
 *
 * Short single-line replies ("Not a git repository", "No changes …") stay
 * plain system lines — a code fence around one sentence would be noise.
 */
import type { Role } from './gateway-adapter';

export interface RenderedChanges {
  role: Role;
  content: string;
}

/** Whether the body looks like a unified diff (has +/- prefixed lines). */
function looksLikeDiff(body: string): boolean {
  return /^[+-]/m.test(body);
}

/**
 * A backtick fence longer than any run of backticks already inside `body`, so
 * an embedded ``` (e.g. a diff of a markdown file whose content has its own
 * code fence) can't close our fence early. CommonMark's rule for nested fences.
 */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Turn a `/changes` result body into a message. Multi-line output becomes a
 * fenced assistant message (```diff when it contains diff lines, plain ```
 * otherwise); a single line stays a plain system message.
 */
export function formatChangesMessage(body: string): RenderedChanges {
  const trimmed = body.replace(/\s+$/, '');
  if (!trimmed.includes('\n')) {
    return { role: 'system', content: trimmed };
  }
  const lang = looksLikeDiff(trimmed) ? 'diff' : '';
  const fence = fenceFor(trimmed);
  return { role: 'assistant', content: `${fence}${lang}\n${trimmed}\n${fence}` };
}
