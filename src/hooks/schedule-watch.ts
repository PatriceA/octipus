/**
 * Watch — skip unchanged runs of a recurring scheduled agent hook
 * (docs/HOOKS.md#watch-skip-unchanged-runs).
 *
 * A schedule may name up to WATCH_MAX_SOURCES sources (`triggerConfig.watch`).
 * Before the run, each is read by a probe that calls no model (the `web:read`
 * fetch, a stat of a workspace file, a task-board query, the heartbeat's inbox
 * and GitHub probes), and the results are hashed together with the hook's
 * action config into a fingerprint. The run is skipped only when every source
 * was read, the fingerprint equals the one recorded by the last run, and that
 * run succeeded. The fingerprint a successful run records is taken AFTER it
 * finished (a second probe), so what the run itself changed in a watched
 * source (a report it rewrote, a task it closed) is not a change for the next
 * run. A source that cannot be read never counts as unchanged: the run goes
 * ahead, and it leaves no fingerprint to skip the next one against.
 *
 * The state (`triggerConfig.watchState`) is server-held: the hooks routes drop
 * a user-supplied value and edits keep the stored one (SERVER_TRIGGER_CONFIG_KEYS).
 */
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
import { withDeadline } from '@/utils/concurrency';
import { sha256 } from '@/utils/crypto';

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
 * (undefined when there is none, `null`, or `[]`) or the reason it is refused;
 * a hook that cannot watch says to remove `watch`.
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
    return { ok: false, error: 'watch is only for recurring (cron) schedules: remove `watch` from triggerConfig' };
  }
  if (hook.action !== 'spawn_agent' || action.orchestrated !== true) {
    return { ok: false, error: 'watch is only for scheduled agent runs routed through the root agent (spawn_agent with orchestrated: true): remove `watch` from triggerConfig, or keep orchestrated on' };
  }
  if (Number(action.awayDigestHours) > 0) {
    return { ok: false, error: 'A digest (awayDigestHours) runs every time and cannot watch sources: remove `watch` from triggerConfig' };
  }
  return { ok: true, watch: parsed.data };
}

/**
 * Why an edit may not be saved because of the hook's stored `watch`, or null.
 * An edit that writes triggerConfig is checked in full. An edit of the action
 * alone is refused only when it turns a hook that could watch into one that
 * cannot (with "remove `watch`"); a hook whose stored watch was already
 * ineligible (written around the API, ignored by the runner) stays editable.
 */
export function watchEditError(
  before: { trigger: string; triggerConfig: unknown; action: string; actionConfig: unknown },
  after: { trigger: string; triggerConfig: unknown; action: string; actionConfig: unknown },
  triggerConfigChanged: boolean,
): string | null {
  const next = checkScheduleWatch(after);
  if (next.ok) return null;
  if (triggerConfigChanged) return next.error;
  return checkScheduleWatch(before).ok ? next.error : null;
}

const OUTCOMES: ReadonlySet<string> = new Set(['running', 'success', 'failed', 'unconfirmed']);

/** The stored state of the last dispatched run, if well-formed. */
export function storedWatchState(triggerConfig: Hook['triggerConfig'] | null | undefined): WatchState | undefined {
  const s = (triggerConfig as Record<string, unknown> | null | undefined)?.watchState as Partial<WatchState> | undefined;
  if (!s || typeof s !== 'object') return undefined;
  if (s.fingerprint !== null && typeof s.fingerprint !== 'string') return undefined;
  if (typeof s.outcome !== 'string' || !OUTCOMES.has(s.outcome)) return undefined;
  return { fingerprint: s.fingerprint ?? null, outcome: s.outcome, runId: String(s.runId ?? ''), at: String(s.at ?? '') };
}

export type WatchDecision =
  | { run: false; reason: 'unchanged' }
  | { run: true; reason: 'unavailable' | 'no_baseline' | 'changed' | 'last_run_not_successful' };

/**
 * Pure: skip only when every source was read (`fingerprint` not null), it
 * equals the fingerprint the last run recorded, and that run succeeded. A run
 * still in progress (`running`), failed or unconfirmed never yields a skip.
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
 * `signal` aborts when the probe's deadline passes: a fetch, a mail request or
 * a `gh` child it started stops. Injectable so the decision is tested without
 * a network, mailbox or `gh`.
 */
export interface WatchProbeDeps {
  page: (url: string, signal: AbortSignal) => Promise<unknown>;
  path: (owner: WatchOwner, path: string, signal: AbortSignal) => Promise<unknown>;
  tasks: (owner: WatchOwner, signal: AbortSignal) => Promise<unknown>;
  inbox: (owner: WatchOwner, signal: AbortSignal) => Promise<unknown>;
  githubPrs: (owner: WatchOwner, signal: AbortSignal) => Promise<unknown>;
}

/** Files up to this size are hashed by content; larger ones by size and modification time. */
export const WATCH_HASH_MAX_BYTES = 5_000_000;
/** A directory with more entries than this cannot be watched (it reads as unavailable). */
export const WATCH_DIR_MAX_ENTRIES = 1000;
/** Longest one probe may take before it counts as unavailable (and is aborted). */
export const WATCH_PROBE_TIMEOUT_MS = 20_000;

export const defaultWatchProbeDeps: WatchProbeDeps = {
  async page(url, signal) {
    // The plugin host's `web:read` fetch: SSRF-guarded, HTML only, capped.
    // The extracted article text, not the raw HTML, so a rotating ad slot or
    // a per-request nonce does not count as a change.
    const { fetchArticle } = await import('@/core/web-read/fetch');
    const article = await fetchArticle(url, signal);
    return sha256(`${article.title}\n${article.textContent}`);
  },
  async path(owner, path, signal) {
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
        ? { type: 'file', sha256: sha256(await readFile(abs, { signal })) }
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
  async inbox(owner, signal) {
    // The heartbeat's inbox probe (core/email/watch.ts): the recent inbox
    // message ids, the same window and filters. It reads ids only.
    const { isJobOn } = await import('@/core/modules/registry');
    if (!isJobOn('inbox-watch')) throw new Error('The inbox module is off');
    const { defaultEmailWatchDeps, EMAIL_LOOKBACK_MS } = await import('@/core/email/watch');
    const provider = await defaultEmailWatchDeps.provider(owner.userId);
    if (!provider) throw new Error('No mailbox connected');
    const listed = await defaultEmailWatchDeps.list(owner.userId, provider, new Date(Date.now() - EMAIL_LOOKBACK_MS), signal);
    return listed.map((m) => m.id).sort();
  },
  async githubPrs(owner, signal) {
    // The heartbeat's GitHub probe: the server's `gh`, so admins only, and a
    // stored DENY on github/read still wins (heartbeat.ts defaultGithubAllowed).
    const { defaultGithubAllowed, pullRequestKey } = await import('@/core/heartbeat');
    if (!(await defaultGithubAllowed(owner.userId))) throw new Error('GitHub is not readable for this user');
    const { probeFailingPullRequests, runGh } = await import('@/core/heartbeat-probes');
    const prs = await probeFailingPullRequests({ runGh }, signal);
    if (prs === null) throw new Error('GitHub could not be read');
    return prs.map(pullRequestKey).sort();
  },
};

function readSource(source: WatchSource, owner: WatchOwner, deps: WatchProbeDeps, signal: AbortSignal): Promise<unknown> {
  switch (source.kind) {
    case 'url': return deps.page(source.url, signal);
    case 'file': return deps.path(owner, source.path, signal);
    case 'tasks': return deps.tasks(owner, signal);
    case 'inbox': return deps.inbox(owner, signal);
    case 'github_prs': return deps.githubPrs(owner, signal);
  }
}

export interface WatchProbe {
  /** Null when any source could not be read. */
  fingerprint: string | null;
  /** The sources that could not be read, and why (`watch`: no source to read). */
  unavailable: Array<{ kind: WatchSource['kind'] | 'watch'; reason: string }>;
}

/**
 * Read `sources` (the hook's validated watch list, checkScheduleWatch) in
 * parallel, each aborted after `timeoutMs`, and hash the observations with
 * the hook's action config into one fingerprint: editing the prompt or the
 * watch list makes the next run run.
 */
export async function probeWatch(
  hook: Pick<Hook, 'userId' | 'workspaceId' | 'actionConfig'>,
  sources: readonly WatchSource[],
  deps: WatchProbeDeps = defaultWatchProbeDeps,
  timeoutMs = WATCH_PROBE_TIMEOUT_MS,
): Promise<WatchProbe> {
  const owner = { userId: hook.userId, workspaceId: hook.workspaceId ?? null };
  const results = await Promise.all(sources.map((source) =>
    withDeadline((signal) => readSource(source, owner, deps, signal), timeoutMs, `Timed out after ${timeoutMs} ms`).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, reason: (err as Error)?.message ?? String(err) }),
    )));
  const unavailable: WatchProbe['unavailable'] = results.flatMap((r, i) => (r.ok ? [] : [{ kind: sources[i].kind, reason: r.reason.slice(0, 300) }]));
  if (sources.length === 0) unavailable.push({ kind: 'watch', reason: 'No watch sources' });
  if (unavailable.length > 0) return { fingerprint: null, unavailable };
  const values = results.map((r) => (r.ok ? r.value : undefined));
  return { fingerprint: sha256(canonical({ v: 1, action: hook.actionConfig, watch: sources, values })), unavailable };
}

/**
 * Mark a run as started: `running` (never a baseline for a skip) under a new
 * `runId`, whatever was stored. Only this run may record its outcome.
 */
export async function startWatchRun(hookId: string, runId: string, at: Date): Promise<void> {
  const state: WatchState = { fingerprint: null, outcome: 'running', runId, at: at.toISOString() };
  await getDb()
    .update(hooks)
    .set({ triggerConfig: sql`coalesce(${hooks.triggerConfig}, '{}'::jsonb) || jsonb_build_object('watchState', ${JSON.stringify(state)}::jsonb)` })
    .where(eq(hooks.id, hookId));
}

/**
 * Record how run `state.runId` ended — compare-and-set: only while it is
 * still the latest run started, so an older overlapping run finishing last
 * never overwrites a newer one. Returns whether it was recorded.
 */
export async function finishWatchRun(hookId: string, state: WatchState): Promise<boolean> {
  const rows = await getDb()
    .update(hooks)
    .set({ triggerConfig: sql`coalesce(${hooks.triggerConfig}, '{}'::jsonb) || jsonb_build_object('watchState', ${JSON.stringify(state)}::jsonb)` })
    .where(and(eq(hooks.id, hookId), sql`${hooks.triggerConfig}->'watchState'->>'runId' = ${state.runId}`))
    .returning({ id: hooks.id });
  return rows.length > 0;
}
