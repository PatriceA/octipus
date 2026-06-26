import { extname } from 'path';

/**
 * Raw source-code files are intentionally never indexed into the knowledge
 * base. Indexing whole code files bloats retrieval with low-signal chunks and
 * crowds out the curated/generated content that actually helps — we tried it
 * before and it hurt result quality. Code is navigated via the `repo_registry`
 * tool, read on demand, or represented by *generated summaries* (which are
 * fine to index). This guard is enforced at the indexer chokepoint so no
 * caller (tool, REST route, or a recursive `.ts` directory glob) can bypass it.
 *
 * Prose and structured docs (`.md`, `.txt`, `.rst`, …) are NOT code and remain
 * indexable.
 */

/** Programming-language source extensions (without the dot). */
const CODE_EXTENSIONS = new Set([
  // JS/TS family
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  // systems / compiled
  'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh',
  'java', 'kt', 'kts', 'scala', 'cs', 'swift', 'm', 'mm',
  // scripting
  'py', 'pyi', 'rb', 'php', 'pl', 'pm', 'lua', 'r',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  // web / templates that are code, not prose
  'vue', 'svelte', 'astro',
  // other languages
  'ex', 'exs', 'erl', 'clj', 'cljs', 'hs', 'ml', 'dart', 'groovy', 'gradle',
]);

/** Extension-less filenames that are code/build scripts, not prose. */
const CODE_BASENAMES = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Jenkinsfile',
  'Vagrantfile', 'Brewfile', 'Procfile', 'Containerfile',
]);

/** Shared user-facing explanation for why code is not indexed. */
export const CODE_NOT_INDEXED_MESSAGE =
  'Raw source-code files are not indexed into the knowledge base by design — it bloats ' +
  'retrieval and hurt result quality before. Use the repo_registry tool to navigate code, ' +
  'read the file directly, or index a generated summary instead.';

/**
 * True when `filePath` is a raw source-code file that must not be indexed.
 * Decision is by extension (or a known code basename) — fast and caller-agnostic.
 */
export function isCodeFile(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  if (CODE_BASENAMES.has(base)) return true;
  const ext = extname(filePath).slice(1).toLowerCase();
  return ext.length > 0 && CODE_EXTENSIONS.has(ext);
}

/** Error thrown when something tries to index a raw code file. */
export class CodeFileNotIndexableError extends Error {
  readonly code = 'CODE_FILE_NOT_INDEXABLE';
  constructor(filePath: string) {
    super(`Refusing to index raw code file "${filePath}". ${CODE_NOT_INDEXED_MESSAGE}`);
    this.name = 'CodeFileNotIndexableError';
  }
}
