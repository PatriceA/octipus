/**
 * The `watch` option of a recurring scheduled hook (docs/HOOKS.md#watch-skip-unchanged-runs):
 * the sources a model-free probe reads before the run, so a run whose sources
 * did not change since the last successful one is skipped. The shapes the API
 * stores and the web editor writes; dependency-free, like the rest of `src/shared`.
 * The server validates with Zod in src/hooks/schedule-watch.ts.
 */

/** The source kinds a watch can name: each already has a cheap probe that calls no model. */
export const WATCH_KINDS = ['url', 'file', 'tasks', 'inbox', 'github_prs'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export type WatchSource =
  /** A public web page: the hash of its extracted article text (the `web:read` fetch, SSRF-guarded). */
  | { kind: 'url'; url: string }
  /** A file or directory in the owner's workspace: content hash, or the directory's entries. */
  | { kind: 'file'; path: string }
  /** The owner's task board: how many tasks there are and when one last changed. */
  | { kind: 'tasks' }
  /** The owner's connected inbox: the ids of recent inbox mail (the heartbeat's inbox probe). */
  | { kind: 'inbox' }
  /** Open pull requests by the owner with failing checks (the heartbeat's GitHub probe; admins only). */
  | { kind: 'github_prs' };

/** Most sources one schedule may watch. */
export const WATCH_MAX_SOURCES = 5;

/**
 * What the server keeps about the latest started run of a watched schedule
 * (`triggerConfig.watchState`, server-held). `fingerprint` is the one probed
 * after that run succeeded; null while it runs, after a failure, or when a
 * source could not be read — none of which makes the next run skippable.
 * `unconfirmed`: the turn ended without reporting success (a refusal, a
 * command's answer). `runId` names the run that may record the outcome.
 */
export interface WatchState {
  fingerprint: string | null;
  outcome: 'running' | 'success' | 'failed' | 'unconfirmed';
  runId: string;
  at: string;
}

/** One source as a line of the editor's list: `url https://…`, `file notes/today.md`, `tasks`. */
export function formatWatchSource(source: WatchSource): string {
  if (source.kind === 'url') return `url ${source.url}`;
  if (source.kind === 'file') return `file ${source.path}`;
  return source.kind;
}

/**
 * The editor's list (one source per line, blank lines ignored) as sources, or
 * the first line it cannot read. The server checks the result again.
 */
export function parseWatchLines(text: string): { sources: WatchSource[] } | { error: string } {
  const sources: WatchSource[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const space = line.search(/\s/);
    const kind = space === -1 ? line : line.slice(0, space);
    const arg = space === -1 ? '' : line.slice(space).trim();
    if (kind === 'url' || kind === 'file') {
      if (!arg) return { error: `"${line}": ${kind} needs a ${kind === 'url' ? 'URL' : 'path'}` };
      sources.push(kind === 'url' ? { kind, url: arg } : { kind, path: arg });
    } else if (kind === 'tasks' || kind === 'inbox' || kind === 'github_prs') {
      if (arg) return { error: `"${line}": ${kind} takes no argument` };
      sources.push({ kind });
    } else {
      return { error: `"${line}": unknown source (use ${WATCH_KINDS.join(', ')})` };
    }
  }
  return { sources };
}
