import { execSync } from 'child_process';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastAbort: AbortController | null = null;

/**
 * Get file path completions using fd (with find fallback).
 * Debounced at 250ms; aborts previous in-flight lookups.
 */
export function getFileCompletions(
  prefix: string,
  cwd: string,
  callback: (results: string[]) => void,
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (lastAbort) lastAbort.abort();

  lastAbort = new AbortController();
  const signal = lastAbort.signal;

  debounceTimer = setTimeout(() => {
    try {
      if (signal.aborted) return;
      // Sanitize the prefix to prevent shell injection
      const safe = prefix.replace(/[^\w./_-]/g, '');
      if (!safe) { callback([]); return; }
      // Use fd if available, fall back to find
      const cmd = `fd --max-results 10 --color never "${safe}" 2>/dev/null || find . -maxdepth 3 -name "*${safe}*" 2>/dev/null | head -10`;
      const result = execSync(cmd, { cwd, timeout: 2000, encoding: 'utf-8' });
      if (signal.aborted) return;
      callback(result.trim().split('\n').filter(Boolean));
    } catch {
      callback([]);
    }
  }, 250);
}

/**
 * Cancel any pending file completion lookup.
 */
export function cancelFileCompletions(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (lastAbort) lastAbort.abort();
}

/**
 * Extract the file-path token being typed at the end of the input string.
 * Returns null if the cursor isn't on a path-like token.
 */
export function extractPathToken(input: string): { token: string; start: number } | null {
  // Match a token that looks like a path at the end of the string
  const match = input.match(/((?:\.{0,2}\/)[^\s]*)$/);
  if (match) return { token: match[1], start: input.length - match[1].length };
  return null;
}
