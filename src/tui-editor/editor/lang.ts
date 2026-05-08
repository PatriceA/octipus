/**
 * Language detection from filename / extension.
 *
 * Used by the syntax highlighter to pick the right pattern set,
 * and by the editor to render a tiny language tag in the status
 * bar. Keep the list small — adding a new language is a one-line
 * change here + a one-block change in `highlight.ts`.
 */
export type Language =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'markdown'
  | 'shell'
  | 'sql'
  | 'yaml'
  | 'toml'
  | 'css'
  | 'html'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'text';

const EXT_MAP: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
};

export function detectLanguage(path: string): Language {
  const lower = path.toLowerCase();
  // Special filenames first.
  if (lower.endsWith('/dockerfile') || lower.endsWith('\\dockerfile')) return 'shell';
  if (lower.endsWith('/makefile') || lower === 'makefile') return 'shell';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = lower.slice(dot + 1);
  return EXT_MAP[ext] ?? 'text';
}
