/**
 * Search across the project's files.
 *
 * With ripgrep (`rg`) installed it does the work: it is fast, respects
 * `.gitignore`, and skips binary files. Without it the editor searches the
 * files of the shared project index (`project-files.ts`: `git ls-files` or a
 * walk) itself, one file at a time with a yield between files, so the editor
 * keeps drawing. Either way results arrive in batches as they are found and
 * stop at `MAX_HITS`; the search can be cancelled.
 *
 * Regular expressions are ripgrep's dialect when ripgrep runs and
 * JavaScript's otherwise; plain text, case and whole-word searches behave
 * the same in both.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { compileQuery, InvalidPatternError, type SearchOptions } from './editor/search';
import { errorCode, indexProjectFiles, SKIP_DIRS } from './project-files';

export interface ProjectHit {
  /** Absolute path. */
  path: string;
  /** 0-based line, and the match as UTF-16 columns of that line. */
  line: number;
  col: number;
  length: number;
  /** The line's text, without its line end. */
  text: string;
}

export interface ProjectSearchDone {
  source: 'rg' | 'walk';
  /** Stopped at `MAX_HITS`. */
  truncated: boolean;
  /** Why the search failed, if it did (an invalid pattern, rg's own error). */
  error?: string;
  cancelled?: boolean;
  /** Files and folders the fallback search could not read (permission denied, …): their matches are missing. */
  unreadable?: number;
}

export interface ProjectSearch {
  done: Promise<ProjectSearchDone>;
  cancel(): void;
}

export const MAX_HITS = 1_000;
/** Files over this are skipped by the fallback search, as the editor would not open them either. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface SearchProjectOptions extends SearchOptions {
  /** The ripgrep binary; `null` forces the fallback (tests). */
  rg?: string | null;
}

export function searchProject(root: string, query: string, options: SearchProjectOptions, onHits: (hits: ProjectHit[]) => void): ProjectSearch {
  let cancelled = false;
  let stop: () => void = () => {};
  const cancel = () => { cancelled = true; stop(); };
  const done = (async (): Promise<ProjectSearchDone> => {
    if (!query) return { source: 'walk', truncated: false };
    try {
      compileQuery(query, options);
    } catch (error) {
      if (!(error instanceof InvalidPatternError)) throw error;
      // ripgrep may still take it (its dialect differs); the fallback cannot.
      if (options.rg === null) return { source: 'walk', truncated: false, error: `Invalid regex: ${error.message}` };
    }
    if (options.rg !== null) {
      const viaRg = await runRipgrep(root, query, options, onHits, (kill) => { stop = kill; }, () => cancelled);
      if (viaRg) return viaRg;
    }
    return walkSearch(root, query, options, onHits, () => cancelled);
  })();
  return { done, cancel };
}

/** Null when ripgrep is not installed: the caller falls back. */
function runRipgrep(
  root: string, query: string, options: SearchProjectOptions, onHits: (hits: ProjectHit[]) => void,
  setStop: (stop: () => void) => void, cancelled: () => boolean,
): Promise<ProjectSearchDone | null> {
  // The folders the tree and the file index skip, and the hidden files they show.
  const args = ['--json', '--no-messages', '--max-columns', '2000', '--max-filesize', '5M', '--hidden', ...[...SKIP_DIRS].flatMap((dir) => ['--glob', `!${dir}`])];
  if (!options.regex) args.push('--fixed-strings');
  if (!options.caseSensitive) args.push('--ignore-case');
  if (options.wholeWord) args.push('--word-regexp');
  args.push('-e', query, '--', '.');
  return new Promise((resolve) => {
    const child = spawn(options.rg ?? 'rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let count = 0;
    let truncated = false;
    let pending = '';
    let errors = '';
    setStop(() => child.kill('SIGTERM'));
    // A chunk can end inside a multi-byte character: the streams' decoders keep the partial bytes for the next one.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errors += chunk; });
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      const batch: ProjectHit[] = [];
      for (const line of lines) {
        if (truncated) break;
        for (const hit of parseRipgrepLine(root, line)) {
          if (count >= MAX_HITS) { truncated = true; child.kill('SIGTERM'); break; }
          batch.push(hit);
          count++;
        }
      }
      if (batch.length && !cancelled()) onHits(batch);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') resolve(null);
      else resolve({ source: 'rg', truncated, error: `ripgrep could not run: ${error.message}` });
    });
    child.once('close', (code) => {
      if (cancelled()) { resolve({ source: 'rg', truncated, cancelled: true }); return; }
      // 0: matches, 1: none; anything else is ripgrep's error (a bad pattern), unless we stopped it.
      if (code !== null && code > 1 && !truncated) resolve({ source: 'rg', truncated, error: errors.trim().split('\n').slice(-3).join(' ') || `ripgrep failed (${code})` });
      else resolve({ source: 'rg', truncated });
    });
  });
}

/** The hits of one line of `rg --json` output (a `match` message); nothing for the others. */
export function parseRipgrepLine(root: string, line: string): ProjectHit[] {
  if (!line.startsWith('{')) return [];
  let message: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start: number; end: number }> } };
  try {
    message = JSON.parse(line);
  } catch (error) {
    // Not one of ripgrep's messages (a line cut at --max-columns, a warning): nothing to show for it.
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  const data = message.data;
  if (message.type !== 'match' || !data?.path?.text || data.lines?.text === undefined || !data.line_number) return [];
  const text = data.lines.text.replace(/\r?\n$/, '');
  const bytes = globalThis.Buffer.from(text, 'utf8');
  const path = isAbsolute(data.path.text) ? data.path.text : join(root, data.path.text);
  // ripgrep reports byte offsets; the editor counts UTF-16 columns.
  const column = (offset: number) => bytes.subarray(0, Math.min(offset, bytes.length)).toString('utf8').length;
  return (data.submatches ?? []).map((m) => {
    const col = column(m.start);
    return { path, line: data.line_number as number - 1, col, length: column(m.end) - col, text };
  });
}

async function walkSearch(root: string, query: string, options: SearchOptions, onHits: (hits: ProjectHit[]) => void, cancelled: () => boolean): Promise<ProjectSearchDone> {
  const re = compileQuery(query, options);
  const index = await indexProjectFiles(root);
  let count = 0;
  let unreadable = index.unreadable?.length ?? 0;
  const done = (truncated: boolean): ProjectSearchDone => ({ source: 'walk', truncated, ...(unreadable ? { unreadable } : {}) });
  for (const path of index.files) {
    if (cancelled()) return { source: 'walk', truncated: false, cancelled: true };
    let content: globalThis.Buffer;
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) continue;
      content = await readFile(path);
    } catch (error) {
      // Removed since it was indexed: not a hit. Unreadable: not a hit either, and counted in the result.
      if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errorCode(error) ?? '')) unreadable++;
      continue;
    }
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split('\n');
    const batch: ProjectHit[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].replace(/\r$/, '');
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (count >= MAX_HITS) { if (batch.length) onHits(batch); return done(true); }
        batch.push({ path, line: i, col: m.index, length: m[0].length, text });
        count++;
      }
    }
    if (batch.length && !cancelled()) onHits(batch);
    // Let the editor draw between files.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return done(false);
}
