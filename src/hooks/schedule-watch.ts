/**
 * Watch — skip unchanged runs of a recurring scheduled agent hook
 * (docs/HOOKS.md#watch-skip-unchanged-runs).
 *
 * A schedule may name up to WATCH_MAX_SOURCES sources (`triggerConfig.watch`).
 * Before the run, each is read by a probe that calls no model (the `web:read`
 * fetch, a stat of a workspace file, a task-board query, the heartbeat's inbox
 * and GitHub probes), and the results are hashed together with the hook's
 * action config into a fingerprint. The run is skipped only when every source
 * was read, the fingerprint equals the one taken before the last run, and that
 * run succeeded. A source that cannot be read never counts as unchanged: the
 * run goes ahead, and it leaves no fingerprint to skip the next one against.
 *
 * The state (`triggerConfig.watchState`) is server-held: the hooks routes drop
 * a user-supplied value and edits keep the stored one (SERVER_TRIGGER_CONFIG_KEYS).
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonical } from '@/core/monitors/types';
import { getDb } from '@/db/postgres';
import { notInSharedWorkspace } from '@/db/repositories/scoped';
import { type Hook, hooks } from '@/db/schema/hooks';
import { tasks } from '@/db/schema/tasks';
import { WATCH_MAX_SOURCES, type WatchSource, type WatchState } from '@/shared/schedule-watch';

const watchSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), 'A watched URL must be http(s)'),
  }).strict(),
  z.object({
    kind: z.literal('file'),
    path: z.string().trim().min(1).max(500).refine((p) => !p.includes('\0'), 'The path contains a null byte'),
  }).strict(),
  z.object({ kind: z.literal('tasks') }).strict(),
  z.object({ kind: z.literal('inbox') }).strict(),
  z.object({ kind: z.literal('github_prs') }).strict(),
]);

export const watchListSchema = z.array(watchSourceSchema).max(WATCH_MAX_SOURCES, `A schedule watches at most ${WATCH_MAX_SOURCES} sources`);

// The Zod shape and the shared type must describe the same thing.
const _sameShape: z.infer<typeof watchSourceSchema> extends WatchSource ? (WatchSource extends z.infer<typeof watchSourceSchema> ? true : never) : never = true;
void _sameShape;

/**
 * Check a hook's `triggerConfig.watch` against what it may be put on: a
 * recurring (cron) schedule whose action is an orchestrated `spawn_agent`
 * turn. Not a one-shot, a reminder (notify) or a digest (`awayDigestHours`):
 * what the owner asked to receive arrives every time. Not a direct spawn
 * either: it reports success when the agent starts, not when it finishes, so
 * "the last run succeeded" could not be known. Returns the normalized list
 * (undefined when there is none, `null`, or `[]`) or the reason it is refused.
 */
export function checkScheduleWatch(hook: {
  trigger: string;
  triggerConfig: unknown;
  action: string;
  actionConfig: unknown;
}): { ok: true; watch: WatchSource[] | undefined } | { ok: false; error: string } {
  const raw = (hook.triggerConfig as Record<string, unknown> | null | undefined)?.watch;
  if (raw === undefined || raw === null) return { ok: true, watch: undefined };
  const parsed = watchListSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid watch: ${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
  }
  if (parsed.data.length === 0) return { ok: true, watch: undefined };
  const trigger = (hook.triggerConfig ?? {}) as Record<string, unknown>;
  const action = (hook.actionConfig ?? {}) as Record<string, unknown>;
  if (hook.trigger !== 'schedule' || typeof trigger.cronExpression !== 'string' || !trigger.cronExpression.trim() || trigger.scheduledAt) {
    return { ok: false, error: 'watch is only for recurring (cron) schedules' };
  }
  if (hook.action !== 'spawn_agent' || action.orchestrated !== true) {
    return { ok: false, error: 'watch is only for scheduled agent runs routed through the root agent (spawn_agent with orchestrated: true)' };
  }
  if (Number(action.awayDigestHours) > 0) {
    return { ok: false, error: 'A digest (awayDigestHours) runs every time; it cannot watch sources' };
  }
  return { ok: true, watch: parsed.data };
}

/** The hook's watch list as stored; an invalid one (written around the API) reads as none. */
export function watchSources(triggerConfig: Hook['triggerConfig'] | null | undefined): WatchSource[] {
  const parsed = watchListSchema.safeParse((triggerConfig as Record<string, unknown> | null | undefined)?.watch);
  return parsed.success ? parsed.data : [];
}

/** The stored state of the last dispatched run, if well-formed. */
export function storedWatchState(triggerConfig: Hook['triggerConfig'] | null | undefined): WatchState | undefined {
  const s = (triggerConfig as Record<string, unknown> | null | undefined)?.watchState as Partial<WatchState> | undefined;
  if (!s || typeof s !== 'object') return undefined;
  if (s.fingerprint !== null && typeof s.fingerprint !== 'string') return undefined;
  if (s.outcome !== 'running' && s.outcome !== 'success' && s.outcome !== 'failed') return undefined;
  return { fingerprint: s.fingerprint ?? null, outcome: s.outcome, at: String(s.at ?? '') };
}

export type WatchDecision =
  | { run: false; reason: 'unchanged' }
  | { run: true; reason: 'unavailable' | 'no_baseline' | 'changed' | 'last_run_not_successful' };

/**
 * Pure: skip only when every source was read (`fingerprint` not null), it
 * equals the fingerprint taken before the last run, and that run succeeded.
 */
export function decideWatch(stored: WatchState | undefined, fingerprint: string | null): WatchDecision {
  if (fingerprint === null) return { run: true, reason: 'unavailable' };
  if (!stored?.fingerprint) return { run: true, reason: 'no_baseline' };
  if (stored.fingerprint !== fingerprint) return { run: true, reason: 'changed' };
  if (stored.outcome !== 'success') return { run: true, reason: 'last_run_not_successful' };
  return { run: false, reason: 'unchanged' };
}

// ── Probes ──────────────────────────────────────────────────────────────────

/** Whose sources a probe reads: the hook's owner, in the hook's workspace. */
export interface WatchOwner { userId: string; workspaceId: string | null }

/**
 * One reader per source kind. Each returns a JSON-able observation or throws
 * when the source cannot be read (unavailable — never an empty observation).
 * Injectable so the decision is tested without a network, mailbox or `gh`.
 */
export interface WatchProbeDeps {
  page: (url: string) => Promise<unknown>;
  path: (owner: WatchOwner, path: string) => Promise<unknown>;
  tasks: (owner: WatchOwner) => Promise<unknown>;
  inbox: (owner: WatchOwner) => Promise<unknown>;
  githubPrs: (owner: WatchOwner) => Promise<unknown>;
}

/** Files up to this size are hashed by content; larger ones by size and modification time. */
export const WATCH_HASH_MAX_BYTES = 5_000_000;
/** A directory with more entries than this cannot be watched (it reads as unavailable). */
export const WATCH_DIR_MAX_ENTRIES = 1000;
/** Longest one probe may take before it counts as unavailable. */
export const WATCH_PROBE_TIMEOUT_MS = 20_000;

const hashOf = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export const defaultWatchProbeDeps: WatchProbeDeps = {
  async page(url) {
    // The plugin host's `web:read` fetch: SSRF-guarded, HTML only, capped.
    // The extracted article text, not the raw HTML, so a rotating ad slot or
    // a per-request nonce does not count as a change.
    const { fetchArticle } = await import('@/core/web-read/fetch');
    const article = await fetchArticle(url);
    return hashOf(`${article.title}\n${article.textContent}`);
  },
  async path(owner, path) {
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
    const fs = WorkspaceFS.forPrincipal(backgroundUserPrincipal(owner.userId, owner.workspaceId));
    if (fs.isSpace) throw new Error('A schedule in a shared space cannot watch files');
    const abs = fs.resolve(path);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch (err) {
      // A file that is not there (yet) is an observation; it appearing is a change.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
      throw err;
    }
    if (st.isFile()) {
      return st.size <= WATCH_HASH_MAX_BYTES
        ? { type: 'file', sha256: hashOf(await readFile(abs)) }
        : { type: 'file', size: st.size, mtimeMs: st.mtimeMs };
    }
    if (!st.isDirectory()) throw new Error('Not a file or directory');
    const entries = await readdir(abs, { withFileTypes: true });
    if (entries.length > WATCH_DIR_MAX_ENTRIES) throw new Error(`More than ${WATCH_DIR_MAX_ENTRIES} entries`);
    const listed = await Promise.all(entries.map(async (e) => {
      const s = await lstat(join(abs, e.name));
      return [e.name, e.isDirectory() ? 'd' : e.isFile() ? 'f' : 'o', s.size, s.mtimeMs] as const;
    }));
    return { type: 'dir', entries: listed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
  },
  async tasks(owner) {
    // The owner's personal board (as the heartbeat reads it): a task added,
    // edited, completed or deleted moves the count or the latest update.
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int`, latest: sql<string | null>`max(${tasks.updatedAt})::text` })
      .from(tasks)
      .where(and(eq(tasks.userId, owner.userId), notInSharedWorkspace(tasks.workspaceId)));
    return { count: row?.count ?? 0, latest: row?.latest ?? null };
  },
  async inbox(owner) {
    // The heartbeat's inbox probe (core/email/watch.ts): the recent inbox
    // message ids, the same window and filters. It reads ids only.
    const { isJobOn } = await import('@/core/modules/registry');
    if (!isJobOn('inbox-watch')) throw new Error('The inbox module is off');
    const { defaultEmailWatchDeps, EMAIL_LOOKBACK_MS } = await import('@/core/email/watch');
    const provider = await defaultEmailWatchDeps.provider(owner.userId);
    if (!provider) throw new Error('No mailbox connected');
    const listed = await defaultEmailWatchDeps.list(owner.userId, provider, new Date(Date.now() - EMAIL_LOOKBACK_MS));
    return listed.map((m) => m.id).sort();
  },
  async githubPrs(owner) {
    // The heartbeat's GitHub probe: the server's `gh`, so admins only, and a
    // stored DENY on github/read still wins (heartbeat.ts defaultGithubAllowed).
    const { defaultGithubAllowed, pullRequestKey } = await import('@/core/heartbeat');
    if (!(await defaultGithubAllowed(owner.userId))) throw new Error('GitHub is not readable for this user');
    const { probeFailingPullRequests } = await import('@/core/heartbeat-probes');
    const prs = await probeFailingPullRequests();
    if (prs === null) throw new Error('GitHub could not be read');
    return prs.map(pullRequestKey).sort();
  },
};

function readSource(source: WatchSource, owner: WatchOwner, deps: WatchProbeDeps): Promise<unknown> {
  switch (source.kind) {
    case 'url': return deps.page(source.url);
    case 'file': return deps.path(owner, source.path);
    case 'tasks': return deps.tasks(owner);
    case 'inbox': return deps.inbox(owner);
    case 'github_prs': return deps.githubPrs(owner);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export interface WatchProbe {
  /** Null when any source could not be read. */
  fingerprint: string | null;
  /** The sources that could not be read, and why (`watch`: the stored list itself is unusable). */
  unavailable: Array<{ kind: WatchSource['kind'] | 'watch'; reason: string }>;
}

/**
 * Read every watched source of `hook` (in parallel, each bounded by
 * `timeoutMs`) and hash them, with the hook's action config, into one
 * fingerprint: editing the prompt or the watch list makes the next run run.
 */
export async function probeWatch(
  hook: Pick<Hook, 'userId' | 'workspaceId' | 'triggerConfig' | 'actionConfig'>,
  deps: WatchProbeDeps = defaultWatchProbeDeps,
  timeoutMs = WATCH_PROBE_TIMEOUT_MS,
): Promise<WatchProbe> {
  const sources = watchSources(hook.triggerConfig);
  const owner = { userId: hook.userId, workspaceId: hook.workspaceId ?? null };
  const results = await Promise.all(sources.map((source) =>
    withTimeout(Promise.resolve().then(() => readSource(source, owner, deps)), timeoutMs).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, reason: (err as Error)?.message ?? String(err) }),
    )));
  const unavailable: WatchProbe['unavailable'] = results.flatMap((r, i) => (r.ok ? [] : [{ kind: sources[i].kind, reason: r.reason.slice(0, 300) }]));
  if (sources.length === 0) unavailable.push({ kind: 'watch', reason: 'No valid watch sources' });
  if (unavailable.length > 0) return { fingerprint: null, unavailable };
  const values = results.map((r) => (r.ok ? r.value : undefined));
  return { fingerprint: hashOf(canonical({ v: 1, action: hook.actionConfig, watch: sources, values })), unavailable };
}

/** Store the state of the run just dispatched or finished; other triggerConfig keys untouched. */
export async function recordWatchState(hookId: string, state: WatchState): Promise<void> {
  await getDb()
    .update(hooks)
    .set({ triggerConfig: sql`coalesce(${hooks.triggerConfig}, '{}'::jsonb) || jsonb_build_object('watchState', ${JSON.stringify(state)}::jsonb)` })
    .where(eq(hooks.id, hookId));
}
