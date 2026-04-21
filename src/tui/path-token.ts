/**
 * Extract the file-path token being typed at the end of the input string.
 * Returns null if the cursor isn't on a path-like token.
 *
 * Kept in its own module so tests can import it without tripping the
 * `mock.module('./file-completer', ...)` stub used by TUI render tests.
 */
export function extractPathToken(
  input: string,
): { token: string; start: number } | null {
  const match = input.match(/((?:\.{0,2}\/)[^\s]*)$/);
  if (match) return { token: match[1], start: input.length - match[1].length };
  return null;
}
