import { pluginProtectionRepository } from '@/db/repositories/plugin-protection-repository';
import { trustedProtectionConnection, protectionApprovalStamp } from './protection-policy';
/**
 * `repos:collect` of the plugin host API (docs/PLUGIN-PACKAGES.md#repository-evidence-collector):
 * a package asks the host to gather read-only evidence from Git repositories
 * of the caller's execution environment and from approved HTTP connections,
 * in the background, and reads the evidence back by run id.
 *
 * The package never runs a command, never reads a file and never sees a
 * credential. It sends a typed description of what to collect; the host runs
 * a fixed list of Git read operations (rev-parse, log, merge-base, rev-list,
 * diff --name-only, cherry), optional fetches into an audit-only ref
 * namespace through the existing credential broker (`authenticatedGit`), and
 * paginated GET requests through `authenticatedFetch`. Each is bounded in
 * time and output; anything incomplete (a failed fetch, a shallow clone, a
 * truncated range, a page cap) is reported as incomplete, never filled in.
 *
 * Who decides what may be reached:
 *
 * - the **owner** of the execution environment: the repository must lie
 *   inside the environment's own folders (`roots`), the environment is named
 *   by id, must belong to the caller's user/workspace, be enabled, and be a
 *   `host` backend; it is re-resolved before every repository, fetch and page,
 *   so removing or disabling it stops the run;
 * - the **admin** of the package: its settings `collector_roots` (absolute
 *   folders) and `collector_connections` (connection ids) bound what any user
 *   of the package may collect, and `collector_protection_level` classifies
 *   the evidence (a result above the package's maxProtection is withheld);
 * - the **user's rules**: `git.read` for the scope, `connections.fetch` and
 *   `connections.read` per use (DENY refuses; the start itself was confirmed
 *   as a write tool call).
 *
 * The run is a `background_jobs` row (`kind: 'collector'`) read back only by
 * the same package, for the same user, in the same workspace. No host token
 * is held in the background.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { z } from 'zod';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { raiseSessionLevel } from '@/core/protection/session-level';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import type { BackgroundJob } from '@/db/schema/background-jobs';
import { buildIsolatedChildEnv } from '@/security/child-env';
import type { ConnectionPrincipal } from '@/security/credential-connections';
import { executionEnvironmentFor, pathInEnvironment } from '@/security/execution-environments';
import type { Principal } from '@/security/principal';
import { runtimePath } from '@/security/runtime-path';
import type { ExecutionEnvironment } from '@/shared/execution-environment';
import { coreLogger } from '@/utils/logger';
import { type HostTokenGrant, noteHostRead, stopPluginRun, trackPluginRun, untrackPluginRun } from './host-api';

// ── Bounds ─────────────────────────────────────────────────────────────────
export const COLLECTOR_RUN_TIMEOUT_MS = 15 * 60_000;
export const COLLECTOR_GIT_OP_TIMEOUT_MS = 120_000;
export const COLLECTOR_FETCH_TIMEOUT_MS = 300_000;
export const COLLECTOR_HTTP_TIMEOUT_MS = 30_000;
export const COLLECTOR_MAX_RESULT_BYTES = 8 * 1024 * 1024;
/** What the run's ranges, pairs, keys and HTTP items may take of the result; the rest is for the envelope (refs, fetches, problems). */
export const COLLECTOR_EVIDENCE_BUDGET_BYTES = COLLECTOR_MAX_RESULT_BYTES - 512 * 1024;
export const COLLECTOR_MAX_ITEMS = 200_000;
export const COLLECTOR_MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
export const COLLECTOR_MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const COLLECTOR_MAX_CHANGED_FILES = 2000;
export const COLLECTOR_MAX_BODY_CHARS = 2000;
export const COLLECTOR_RUNS_PER_HOUR = 12;
export const COLLECTOR_RUN_BURST = 4;
export const COLLECTOR_MAX_IN_FLIGHT = 1;

/** The package settings an admin fills in; the package cannot supply defaults (FieldDef has none). */
export const COLLECTOR_SETTING_ROOTS = 'collector_roots';
export const COLLECTOR_SETTING_CONNECTIONS = 'collector_connections';
export const COLLECTOR_SETTING_LEVEL = 'collector_protection_level';

/** Branch, tag or ref names: git check-ref-format's rules, conservatively. */
const REF_NAME = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}(?<![./])$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const POINTER = /^(?:\/[^/]{0,100}){0,8}$/;
const PARAM = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

const refInput = z.union([
  z.object({ name: z.string().regex(KEY), branch: z.string().regex(REF_NAME) }).strict(),
  z.object({ name: z.string().regex(KEY), tag: z.string().regex(REF_NAME) }).strict(),
  z.object({ name: z.string().regex(KEY), sha: z.string().regex(SHA) }).strict(),
  z.object({ name: z.string().regex(KEY), localRef: z.string().regex(REF_NAME).refine((r) => r.startsWith('refs/'), 'localRef starts with refs/') }).strict(),
]);
export type CollectorRefInput = z.infer<typeof refInput>;

const pagination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none'), itemsPointer: z.string().regex(POINTER) }).strict(),
  z.object({
    type: z.literal('offset'), itemsPointer: z.string().regex(POINTER), startParam: z.string().regex(PARAM), limitParam: z.string().regex(PARAM),
    limit: z.number().int().min(1).max(500), totalPointer: z.string().regex(POINTER).optional(),
  }).strict(),
  z.object({
    type: z.literal('token'), itemsPointer: z.string().regex(POINTER), tokenParam: z.string().regex(PARAM),
    nextTokenPointer: z.string().regex(POINTER), lastPointer: z.string().regex(POINTER).optional(),
  }).strict(),
  z.object({
    type: z.literal('page'), itemsPointer: z.string().regex(POINTER), pageParam: z.string().regex(PARAM), perPageParam: z.string().regex(PARAM),
    perPage: z.number().int().min(1).max(500),
  }).strict(),
]);

export const collectorRequestSchema = z.object({
  environmentId: z.string().min(1).max(100),
  title: z.string().max(200).optional(),
  maxCommits: z.number().int().min(1).max(5000).default(2000),
  repos: z.array(z.object({
    key: z.string().regex(KEY),
    path: z.string().min(2).max(1000).refine((p) => p.startsWith('/') && !p.includes('\0'), 'path is absolute'),
    fetch: z.object({
      connection: z.string().regex(CONNECTION_ID),
      remotePath: z.string().regex(/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.git$/),
    }).strict().optional(),
    baseline: refInput,
    refs: z.array(refInput).min(1).max(6),
  }).strict()).max(25).default([]),
  http: z.array(z.object({
    id: z.string().regex(KEY),
    connection: z.string().regex(CONNECTION_ID),
    path: z.string().min(1).max(4000).refine((p) => p.startsWith('/') && !p.startsWith('//') && !/[\\\r\n\0#]/.test(p), 'path is origin-relative'),
    pagination,
    maxPages: z.number().int().min(1).max(50).default(20),
    /**
     * Repeat the request for issue keys found earlier, `{keys}` in `path`
     * replaced by a comma-separated batch: keys are PROJECT-NUMBER of the
     * listed projects only (the host builds the pattern), found in the
     * collected commit messages or at `pointer` in the items of an earlier request.
     */
    expand: z.object({
      projects: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/)).min(1).max(20),
      from: z.discriminatedUnion('source', [
        z.object({ source: z.literal('commits') }).strict(),
        z.object({ source: z.literal('http'), id: z.string().regex(KEY), pointer: z.string().regex(POINTER) }).strict(),
      ]),
      batch: z.number().int().min(1).max(100).default(50),
    }).strict().optional(),
  }).strict()).max(40).default([]),
}).strict().superRefine((req, ctx) => {
  if (req.repos.length === 0 && req.http.length === 0) ctx.addIssue({ code: 'custom', message: 'Nothing to collect' });
  if (new Set(req.repos.map((r) => r.key)).size !== req.repos.length) ctx.addIssue({ code: 'custom', message: 'repo keys repeat' });
  if (new Set(req.http.map((h) => h.id)).size !== req.http.length) ctx.addIssue({ code: 'custom', message: 'http ids repeat' });
  for (const r of req.repos) {
    if (new Set(r.refs.map((x) => x.name)).size !== r.refs.length) ctx.addIssue({ code: 'custom', message: `repo ${r.key}: ref names repeat` });
  }
  req.http.forEach((h, i) => {
    if (h.path.includes('{keys}') !== !!h.expand) ctx.addIssue({ code: 'custom', message: `http ${h.id}: {keys} in path and expand go together` });
    const from = h.expand?.from;
    if (from?.source === 'http' && !req.http.slice(0, i).some((e) => e.id === from.id)) ctx.addIssue({ code: 'custom', message: `http ${h.id}: expands from an earlier request only` });
  });
});
export type CollectorRequest = z.infer<typeof collectorRequestSchema>;

// ── Evidence ───────────────────────────────────────────────────────────────
export interface CommitEvidence { sha: string; parents: string[]; committedAt: string; subject: string; body: string; bodyTruncated?: true }
export interface RefEvidence {
  name: string; input: string; resolvedRef: string; sha: string | null; tree: string | null;
  status: 'ok' | 'missing' | 'fetch_failed'; source: 'fetched' | 'local' | 'sha'; at: string;
}
export interface RangeEvidence { ref: string; baseSha: string; refSha: string; baselineIsAncestor: boolean; commits: CommitEvidence[]; truncated: boolean }
export interface CherryEntry { sha: string; equivalent: boolean }
export interface PairEvidence {
  a: string; b: string; aInB: boolean; bInA: boolean; onlyInA: number; onlyInB: number; sameTree: boolean;
  changedFiles: string[]; changedFilesTruncated: boolean;
  /** Commits of A not reachable from B; equivalent: an equal patch is in B (git cherry). */
  cherryAtoB: CherryEntry[]; cherryBtoA: CherryEntry[]; cherryTruncated: boolean;
}
export interface FetchEvidence { ref: string; refspec: string; ok: boolean; error?: string; at: string }
export interface RepoEvidence {
  key: string; shallow: boolean | null; fetches: FetchEvidence[]; baseline: RefEvidence | null; refs: RefEvidence[];
  ranges: RangeEvidence[]; pairs: PairEvidence[]; complete: boolean; problems: string[];
}
export interface HttpEvidence { id: string; connection: string; pages: number; items: unknown[]; total: number | null; complete: boolean; error?: string; at: string; keys?: string[] }
export interface CollectorEvidence {
  environmentId: string; startedAt: string; finishedAt: string; complete: boolean; repos: RepoEvidence[]; http: HttpEvidence[];
}

export type CollectorOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; error: string; retryAfter?: number };

export interface CollectorRunView {
  id: string; status: 'running' | 'done' | 'error' | 'interrupted'; title: string; stage: string | null;
  evidence: CollectorEvidence | null; withheld?: { protectionLevel: number }; error: string | null;
  startedAt: string; finishedAt: string | null;
}

class CollectorError extends Error {
  constructor(message: string, readonly code = 'collector_failed', readonly status = 400) { super(message); }
}

export const BUDGET_EXHAUSTED = 'The evidence budget of the run is exhausted; collection stopped here';

/**
 * The cumulative bound of a run, charged before evidence is retained: UTF-8
 * bytes of its JSON form and a count of items (commits, entries, records).
 * Once a charge does not fit, the budget stays exhausted and every later step
 * stops without a request.
 */
export class EvidenceBudget {
  exhausted = false;
  constructor(public bytes = COLLECTOR_EVIDENCE_BUDGET_BYTES, public items = COLLECTOR_MAX_ITEMS) {}

  /** Charge `value` (serialized) and `count` items; false, and exhausted from now on, when it does not fit. */
  take(value: unknown, count: number): boolean {
    if (this.exhausted) return false;
    const size = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    if (size > this.bytes || count > this.items) { this.exhausted = true; return false; }
    this.bytes -= size;
    this.items -= count;
    if (this.bytes === 0 || this.items === 0) this.exhausted = true;
    return true;
  }
}

// ── Policy (re-resolved before each step) ──────────────────────────────────

interface Policy { environment: ExecutionEnvironment; roots: string[]; connections: Set<string>; level: 1 | 2 | 3 | 4 }

/** A list setting: newline- or comma-separated, trimmed, empties dropped. */
export function listSetting(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [];
}

async function realRoots(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    if (!p.startsWith('/')) continue;
    try { out.push(await realpath(p)); } catch (err) {
      coreLogger.warn({ root: p, err: (err as Error).message }, 'collector: approved folder is not reachable; ignored');
    }
  }
  return out;
}

export function callerOf(grant: Pick<HostTokenGrant, 'userId'>, workspaceId: string | null, environmentId: string): ConnectionPrincipal & { metadata: Record<string, unknown> } {
  return { userId: grant.userId, workspaceId, metadata: { executionEnvironmentId: environmentId } };
}

/**
 * The environment, folders, connections and level for this package and
 * caller now, or a refusal. Throws CollectorError.
 */
export async function resolvePolicy(plugin: string, caller: ReturnType<typeof callerOf>): Promise<Policy> {
  let environment: ExecutionEnvironment | undefined;
  try { environment = executionEnvironmentFor(caller); } catch (err) {
    throw new CollectorError((err as Error).message, 'environment_unavailable', 403);
  }
  if (!environment || environment.id !== caller.metadata.executionEnvironmentId || !environment.enabled) {
    throw new CollectorError('The execution environment is not one of yours in this workspace, or it is disabled', 'environment_unavailable', 403);
  }
  if (environment.backend !== 'host') {
    throw new CollectorError(`The collector runs in host environments only (this one is ${environment.backend}); nothing was accessed`, 'environment_backend', 409);
  }
  if (await denied(caller.userId, caller.workspaceId ?? null, 'git', 'read')) {
    throw new CollectorError('Your rules deny git.read', 'git_read_denied', 403);
  }
  const { findRow } = await import('./service');
  const row = await findRow(plugin);
  if (!row?.enabled) throw new CollectorError('The plugin is not enabled', 'plugin_disabled', 403);
  const levelText = row.settings[COLLECTOR_SETTING_LEVEL];
  let level = Number(levelText);
  const dataApproval = await pluginProtectionRepository.get(plugin);
  if (dataApproval && dataApproval.contentHash !== row.contentHash) throw new CollectorError('Review this plugin’s data access after its update in Administration → Plugin packages → Data access','data_approval_stale',403);
  if (dataApproval) level = Math.max(level,dataApproval.level);
  if (![1, 2, 3, 4].includes(level)) {
    throw new CollectorError(`An admin has not classified the collected evidence (setting ${COLLECTOR_SETTING_LEVEL}: 1-4)`, 'not_configured', 403);
  }
  const adminRoots = await realRoots(listSetting(row.settings[COLLECTOR_SETTING_ROOTS]));
  const envRoots = await realRoots(environment.roots);
  return {
    environment,
    // A folder counts when both the admin and the environment's owner allowed it.
    roots: adminRoots.filter((a) => envRoots.some((e) => pathInEnvironment(e, a))).concat(envRoots.filter((e) => adminRoots.some((a) => pathInEnvironment(a, e)))),
    connections: new Set(listSetting(row.settings[COLLECTOR_SETTING_CONNECTIONS]).filter(id => !dataApproval || dataApproval.level===1 || dataApproval.connections.some(c=>c.id===id))),
    level: level as 1 | 2 | 3 | 4,
  };
}

async function repoDir(policy: Policy, path: string): Promise<string> {
  let real: string;
  try { real = await realpath(path); } catch { throw new CollectorError('Repository folder not found', 'repo_missing', 404); }
  if (!policy.roots.some((r) => pathInEnvironment(r, real))) {
    throw new CollectorError('Repository is outside the folders both the environment and the plugin admin approved', 'repo_not_approved', 403);
  }
  return real;
}

async function denied(userId: string, workspaceId: string | null, toolId: string, action: string): Promise<boolean> {
  const { getPermissionManager } = await import('@/security/permissions');
  return (await getPermissionManager().check(userId, toolId, action, {}, { sessionId: '', workspaceId })).level === 'DENY';
}

// ── Git, fixed operations ──────────────────────────────────────────────────

const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Run one Git read. Exit codes in `ok` are answers (e.g. merge-base 1 = not an ancestor), anything else throws. */
export function runGit(env: ExecutionEnvironment, cwd: string, args: string[], signal: AbortSignal, ok: number[] = [0]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- fixed executable, fixed subcommands, validated refs, no shell
    execFile('git', ['--no-replace-objects', '-c', `core.hooksPath=${NULL_FILE}`, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], {
      cwd, signal, timeout: COLLECTOR_GIT_OP_TIMEOUT_MS, maxBuffer: COLLECTOR_MAX_GIT_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8',
      env: buildIsolatedChildEnv({
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_FILE, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
        PATH: runtimePath([...env.pathDirectories, process.env.PATH ?? ''].join(delimiter)),
      }),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1) : 0;
      if (!err || ok.includes(code)) { resolve({ code, stdout }); return; }
      const why = signal.aborted ? 'cancelled or timed out' : (err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output exceeded the collector bound' : String(stderr).trim().slice(0, 500);
      reject(new CollectorError(`git ${args[0]} failed: ${why}`, 'git_failed', 502));
    });
  });
}

async function resolveCommit(env: ExecutionEnvironment, cwd: string, rev: string, signal: AbortSignal): Promise<{ sha: string; tree: string } | null> {
  const c = await runGit(env, cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], signal, [0, 1, 128]);
  if (c.code !== 0) return null;
  const sha = c.stdout.trim();
  const t = await runGit(env, cwd, ['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`], signal);
  return { sha, tree: t.stdout.trim() };
}

/** The audit-only destination of a fetched ref: never a local branch, never refs/tags. */
export function auditRef(input: CollectorRefInput): { source: string; dest: string } | null {
  if ('branch' in input) return { source: `refs/heads/${input.branch}`, dest: `refs/remotes/octipus-audit/heads/${input.branch}` };
  if ('tag' in input) return { source: `refs/tags/${input.tag}`, dest: `refs/remotes/octipus-audit/tags/${input.tag}` };
  return null;
}

function inputText(input: CollectorRefInput): string {
  return 'branch' in input ? input.branch : 'tag' in input ? input.tag : 'sha' in input ? input.sha : input.localRef;
}

const SEP_RECORD = '\x1e';
const SEP_FIELD = '\x1f';

export function parseLog(stdout: string): CommitEvidence[] {
  return stdout.split(SEP_RECORD).filter((r) => r.trim()).map((record) => {
    const [sha, parents, ct, subject, body = ''] = record.replace(/^\n/, '').split(SEP_FIELD);
    const trimmed = body.trim();
    return {
      sha, parents: parents ? parents.split(' ') : [], committedAt: new Date(Number(ct) * 1000).toISOString(), subject,
      body: trimmed.slice(0, COLLECTOR_MAX_BODY_CHARS), ...(trimmed.length > COLLECTOR_MAX_BODY_CHARS ? { bodyTruncated: true as const } : {}),
    };
  });
}

export function parseCherry(stdout: string): CherryEntry[] {
  return stdout.split('\n').filter(Boolean).map((line) => ({ sha: line.slice(2).trim(), equivalent: line.startsWith('-') }));
}

interface RepoContext { grant: HostTokenGrant; workspaceId: string | null; environmentId: string; maxCommits: number; signal: AbortSignal; budget: EvidenceBudget }

async function collectRepo(ctx: RepoContext, repo: CollectorRequest['repos'][number]): Promise<RepoEvidence> {
  const caller = callerOf(ctx.grant, ctx.workspaceId, ctx.environmentId);
  const out: RepoEvidence = { key: repo.key, shallow: null, fetches: [], baseline: null, refs: [], ranges: [], pairs: [], complete: true, problems: [] };
  const fail = (p: string) => { out.complete = false; out.problems.push(p); };
  let policy = await resolvePolicy(ctx.grant.plugin, caller);
  const cwd = await repoDir(policy, repo.path);
  const env = policy.environment;
  const common = (await runGit(env, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.signal)).stdout.trim();
  if (!policy.roots.some((r) => pathInEnvironment(r, common))) throw new CollectorError('Repository metadata is outside the approved folders', 'repo_not_approved', 403);
  out.shallow = (await runGit(env, cwd, ['rev-parse', '--is-shallow-repository'], ctx.signal)).stdout.trim() === 'true';
  if (out.shallow) fail('shallow clone: history is incomplete, ancestry and ranges are not conclusive');

  const fetched = new Map<string, boolean>();
  if (repo.fetch) {
    if (!policy.connections.has(repo.fetch.connection)) throw new CollectorError(`Connection ${repo.fetch.connection} is not approved for this plugin`, 'connection_not_approved', 403);
    const { connectionFor } = await import('@/security/credential-connections');
    const { authenticatedGit } = await import('@/security/credential-git');
    for (const input of [repo.baseline, ...repo.refs]) {
      const mapped = auditRef(input);
      if (!mapped || fetched.has(mapped.dest)) continue;
      const refspec = `+${mapped.source}:${mapped.dest}`;
      const at = new Date().toISOString();
      try {
        policy = await resolvePolicy(ctx.grant.plugin, caller);
        await repoDir(policy, cwd);
        // The admin may withdraw the connection between two fetches: checked against this policy, not the first one.
        if (!policy.connections.has(repo.fetch.connection)) throw new CollectorError(`Connection ${repo.fetch.connection} is not approved for this plugin`, 'connection_not_approved', 403);
        if (await denied(ctx.grant.userId, ctx.workspaceId, 'connections', 'fetch')) throw new Error('Your rules deny connections.fetch');
        const profile = await connectionFor(repo.fetch.connection, caller);
        await assertInternalConnection(ctx.grant,profile);
        await authenticatedGit(profile, caller, { operation: 'fetch', path: cwd, remotePath: repo.fetch.remotePath, refspecs: [refspec], timeout: COLLECTOR_FETCH_TIMEOUT_MS }, ctx.signal);
        fetched.set(mapped.dest, true);
        out.fetches.push({ ref: input.name, refspec, ok: true, at });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        fetched.set(mapped.dest, false);
        out.fetches.push({ ref: input.name, refspec, ok: false, error: (err as Error).message.slice(0, 500), at });
        fail(`fetch of ${input.name} failed: its state is unknown`);
      }
    }
  }

  const resolveInput = async (input: CollectorRefInput): Promise<RefEvidence> => {
    const at = new Date().toISOString();
    const mapped = auditRef(input);
    const useFetched = repo.fetch && mapped;
    const resolvedRef = useFetched ? mapped.dest : 'sha' in input ? input.sha : 'localRef' in input ? input.localRef : mapped!.source;
    const source: RefEvidence['source'] = useFetched ? 'fetched' : 'sha' in input ? 'sha' : 'local';
    if (useFetched && fetched.get(mapped.dest) === false) {
      return { name: input.name, input: inputText(input), resolvedRef, sha: null, tree: null, status: 'fetch_failed', source, at };
    }
    const c = await resolveCommit(env, cwd, resolvedRef, ctx.signal);
    if (!c) fail(`${input.name} (${inputText(input)}) does not resolve to a commit`);
    else if (source === 'local') out.problems.push(`${input.name} read from local refs without a fetch: may be stale`);
    return { name: input.name, input: inputText(input), resolvedRef, sha: c?.sha ?? null, tree: c?.tree ?? null, status: c ? 'ok' : 'missing', source, at };
  };

  out.baseline = await resolveInput(repo.baseline);
  for (const input of repo.refs) out.refs.push(await resolveInput(input));
  const resolved = out.refs.filter((r): r is RefEvidence & { sha: string; tree: string } => r.sha !== null && r.tree !== null);

  const base = out.baseline.sha;
  if (!base) fail('baseline unresolved: no ranges collected');
  for (const r of resolved) {
    if (!base) break;
    const anc = await runGit(env, cwd, ['merge-base', '--is-ancestor', base, r.sha], ctx.signal, [0, 1]);
    const log = await runGit(env, cwd, ['log', `--max-count=${ctx.maxCommits + 1}`, `--format=${SEP_RECORD}%H${SEP_FIELD}%P${SEP_FIELD}%ct${SEP_FIELD}%s${SEP_FIELD}%b`, `${base}..${r.sha}`, '--'], ctx.signal);
    const commits = parseLog(log.stdout);
    const truncated = commits.length > ctx.maxCommits;
    const range: RangeEvidence = { ref: r.name, baseSha: base, refSha: r.sha, baselineIsAncestor: anc.code === 0, commits: commits.slice(0, ctx.maxCommits), truncated };
    if (!ctx.budget.take(range, range.commits.length)) { fail(`${r.name}: ${BUDGET_EXHAUSTED}`); return out; }
    if (truncated) fail(`${r.name}: more than ${ctx.maxCommits} commits since the baseline; range truncated`);
    out.ranges.push(range);
  }

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      const aInB = (await runGit(env, cwd, ['merge-base', '--is-ancestor', a.sha, b.sha], ctx.signal, [0, 1])).code === 0;
      const bInA = (await runGit(env, cwd, ['merge-base', '--is-ancestor', b.sha, a.sha], ctx.signal, [0, 1])).code === 0;
      const [onlyA, onlyB] = (await runGit(env, cwd, ['rev-list', '--left-right', '--count', `${a.sha}...${b.sha}`, '--'], ctx.signal)).stdout.trim().split(/\s+/).map(Number);
      const names = a.tree === b.tree ? [] : (await runGit(env, cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', a.sha, b.sha, '--'], ctx.signal)).stdout.split('\0').filter(Boolean);
      const limit = ctx.maxCommits;
      const cherryAtoB = onlyA > limit ? [] : parseCherry((await runGit(env, cwd, ['cherry', b.sha, a.sha], ctx.signal)).stdout);
      const cherryBtoA = onlyB > limit ? [] : parseCherry((await runGit(env, cwd, ['cherry', a.sha, b.sha], ctx.signal)).stdout);
      const cherryTruncated = onlyA > limit || onlyB > limit;
      const pair: PairEvidence = {
        a: a.name, b: b.name, aInB, bInA, onlyInA: onlyA, onlyInB: onlyB, sameTree: a.tree === b.tree,
        changedFiles: names.slice(0, COLLECTOR_MAX_CHANGED_FILES), changedFilesTruncated: names.length > COLLECTOR_MAX_CHANGED_FILES,
        cherryAtoB, cherryBtoA, cherryTruncated,
      };
      if (!ctx.budget.take(pair, pair.changedFiles.length + cherryAtoB.length + cherryBtoA.length)) { fail(`${a.name}/${b.name}: ${BUDGET_EXHAUSTED}`); return out; }
      if (cherryTruncated) fail(`${a.name}/${b.name}: too many diverging commits for patch equivalence`);
      out.pairs.push(pair);
    }
  }
  return out;
}

// ── HTTP reads ─────────────────────────────────────────────────────────────

/** RFC 6901, read only. `''` is the whole document. */
export function jsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The pages of one request; `get` returns the parsed JSON body of a path or throws.
 * With a budget, each page's items are charged before they are kept, and no
 * page is requested once it is exhausted.
 */
export async function paginate(
  spec: CollectorRequest['http'][number], get: (path: string) => Promise<unknown>, budget?: EvidenceBudget,
): Promise<{ items: unknown[]; pages: number; total: number | null; complete: boolean; error?: string }> {
  const p = spec.pagination;
  const items: unknown[] = [];
  let total: number | null = null;
  let token: string | null = null;
  for (let page = 0; page < spec.maxPages; page++) {
    if (budget?.exhausted) return { items, pages: page, total, complete: false, error: BUDGET_EXHAUSTED };
    const url = new URL(spec.path, 'http://collector.invalid');
    if (p.type === 'offset') { url.searchParams.set(p.startParam, String(page * p.limit)); url.searchParams.set(p.limitParam, String(p.limit)); }
    if (p.type === 'page') { url.searchParams.set(p.pageParam, String(page + 1)); url.searchParams.set(p.perPageParam, String(p.perPage)); }
    if (p.type === 'token' && token !== null) url.searchParams.set(p.tokenParam, token);
    let body: unknown;
    try { body = await get(url.pathname + url.search); } catch (err) {
      return { items, pages: page, total, complete: false, error: (err as Error).message.slice(0, 500) };
    }
    const got = jsonPointer(body, p.itemsPointer);
    if (!Array.isArray(got)) return { items, pages: page + 1, total, complete: false, error: `No array at ${p.itemsPointer || '(root)'}` };
    if (budget && !budget.take(got, got.length)) return { items, pages: page + 1, total, complete: false, error: BUDGET_EXHAUSTED };
    items.push(...got);
    if (p.type === 'none') return { items, pages: 1, total: null, complete: true };
    if (p.type === 'offset') {
      const t = p.totalPointer ? jsonPointer(body, p.totalPointer) : undefined;
      if (p.totalPointer && typeof t !== 'number') return { items, pages: page + 1, total, complete: false, error: `No number at ${p.totalPointer}` };
      if (typeof t === 'number') total = t;
      if (got.length === 0 || (total !== null ? items.length >= total : got.length < p.limit)) {
        return { items, pages: page + 1, total, complete: total === null || items.length === total };
      }
    }
    if (p.type === 'page' && got.length < p.perPage) return { items, pages: page + 1, total: null, complete: true };
    if (p.type === 'token') {
      const last = p.lastPointer ? jsonPointer(body, p.lastPointer) : undefined;
      const next = jsonPointer(body, p.nextTokenPointer);
      if (last === true || ((next === undefined || next === null || next === '') && last !== false)) return { items, pages: page + 1, total: null, complete: true };
      if (typeof next !== 'string' || !next) return { items, pages: page + 1, total: null, complete: false, error: 'Not the last page, but no next token' };
      token = next;
    }
  }
  return { items, pages: spec.maxPages, total, complete: false, error: `Stopped at ${spec.maxPages} pages` };
}

/** Issue keys of `projects` in `texts`, sorted and distinct. The pattern is the host's own: no package regex runs here. */
export function issueKeys(projects: readonly string[], texts: Iterable<string>): string[] {
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${projects.join('|')})-[1-9][0-9]{0,8}(?![0-9])`, 'g');
  const keys = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(re)) keys.add(m[0]);
  return [...keys].sort();
}

/** The keys an expanding request repeats over, and whether their source was complete. */
export function expansionKeys(spec: CollectorRequest['http'][number], repos: readonly RepoEvidence[], earlier: readonly HttpEvidence[]): { keys: string[]; complete: boolean } {
  const ex = spec.expand!;
  if (ex.from.source === 'commits') {
    return { keys: issueKeys(ex.projects, repos.flatMap((r) => r.ranges.flatMap((g) => g.commits.flatMap((c) => [c.subject, c.body])))), complete: repos.every((r) => r.complete) };
  }
  const { id, pointer } = ex.from;
  const src = earlier.find((e) => e.id === id);
  if (!src) return { keys: [], complete: false };
  return { keys: issueKeys(ex.projects, src.items.map((item) => jsonPointer(item, pointer)).filter((v): v is string => typeof v === 'string')), complete: src.complete };
}

async function collectHttp(ctx: RepoContext, spec: CollectorRequest['http'][number], repos: readonly RepoEvidence[], earlier: readonly HttpEvidence[]): Promise<HttpEvidence> {
  const at = new Date().toISOString();
  if (!spec.expand) return { id: spec.id, connection: spec.connection, at, ...(await fetchPages(ctx, spec)) };
  const { keys, complete } = expansionKeys(spec, repos, earlier);
  if (!ctx.budget.take(keys, keys.length)) return { id: spec.id, connection: spec.connection, at, pages: 0, items: [], total: null, complete: false, error: BUDGET_EXHAUSTED };
  const merged: HttpEvidence = { id: spec.id, connection: spec.connection, at, pages: 0, items: [], total: null, complete, keys, ...(complete ? {} : { error: 'The source of the keys is incomplete' }) };
  for (let i = 0; i < keys.length; i += spec.expand.batch) {
    if (ctx.budget.exhausted) { merged.complete = false; merged.error = BUDGET_EXHAUSTED; break; }
    const batch = keys.slice(i, i + spec.expand.batch);
    const out = await fetchPages(ctx, { ...spec, path: spec.path.replaceAll('{keys}', encodeURIComponent(batch.join(','))) });
    merged.pages += out.pages;
    merged.items.push(...out.items);
    if (!out.complete) { merged.complete = false; merged.error = out.error; }
  }
  return merged;
}

async function fetchPages(ctx: RepoContext, spec: CollectorRequest['http'][number]): Promise<Awaited<ReturnType<typeof paginate>>> {
  const caller = callerOf(ctx.grant, ctx.workspaceId, ctx.environmentId);
  const { authenticatedFetch, connectionFor, readBoundedResponse } = await import('@/security/credential-connections');
  const out = await paginate(spec, async (path) => {
    const policy = await resolvePolicy(ctx.grant.plugin, caller);
    if (!policy.connections.has(spec.connection)) throw new CollectorError(`Connection ${spec.connection} is not approved for this plugin`, 'connection_not_approved', 403);
    if (await denied(ctx.grant.userId, ctx.workspaceId, 'connections', 'read')) throw new CollectorError('Your rules deny connections.read', 'connection_denied', 403);
    const profile = await connectionFor(spec.connection, caller);
    await assertInternalConnection(ctx.grant,profile);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(COLLECTOR_HTTP_TIMEOUT_MS)]);
    // The read itself is bounded by what is left of the run's budget, not only by the page bound.
    const limit = Math.min(COLLECTOR_MAX_PAGE_BYTES, ctx.budget.bytes);
    const { response, mask } = await authenticatedFetch(profile, caller, path, { method: 'GET', signal, headers: { accept: 'application/json' } });
    let text: string;
    try { text = await readBoundedResponse(response, limit); } catch (err) {
      if (limit < COLLECTOR_MAX_PAGE_BYTES && !ctx.signal.aborted) { ctx.budget.exhausted = true; throw new CollectorError(BUDGET_EXHAUSTED, 'budget_exhausted', 413); }
      throw err;
    }
    if (!response.ok) throw new CollectorError(`HTTP ${response.status}`, 'http_status', 502);
    try { return mask(JSON.parse(text)); } catch { throw new CollectorError('The response is not JSON', 'http_not_json', 502); }
  }, ctx.budget);
  if (ctx.signal.aborted) throw new CollectorError('Cancelled', 'cancelled', 409);
  return out;
}


/** A connection edit cannot silently move Internal evidence to a different destination. */
async function assertInternalConnection(grant:HostTokenGrant,profile:Parameters<typeof trustedProtectionConnection>[1]):Promise<void> {
  const approval=await pluginProtectionRepository.get(grant.plugin);
  if(grant.dataApproval!==protectionApprovalStamp(approval))throw new CollectorError('The plugin data approval changed during collection; review the result before starting another run.','data_approval_changed',403);
  if(approval && approval.level>1 && !trustedProtectionConnection(approval,profile))throw new CollectorError('The connection destination changed or is not trusted for this data level. Review Data access in the plugin settings.','connection_trust',403);
}

// ── Runs ───────────────────────────────────────────────────────────────────

interface RunPayload { plugin: string; tool: string; environmentId: string; workspaceId: string | null }
interface RunResult { evidence?: CollectorEvidence; protectionLevel?: number }
const inFlight = new Map<string, number>();
const flightKey = (plugin: string, userId: string) => `${plugin}\n${userId}`;

/** Start a run (`POST /api/plugin-host/collector/runs`). */
export async function startCollectorRun(grant: HostTokenGrant, principal: Principal, body: unknown): Promise<CollectorOutcome<{ id: string; status: 'running' }>> {
  if (grant.effect !== 'write' && grant.effect !== 'external') {
    return { ok: false, status: 403, code: 'read_tool', error: 'A read tool may read a collector run; starting one needs a tool whose effect is write or external' };
  }
  if (principal.workspaceKind === 'shared') return { ok: false, status: 409, code: 'space', error: 'Collector runs start in personal workspaces only' };
  const parsed = collectorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, code: 'invalid', error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(request)'}: ${i.message}`).join('; ') };
  }
  const req = parsed.data;
  const workspaceId = principal.workspaceId ?? null;
  const caller = callerOf(grant, workspaceId, req.environmentId);
  try {
    // Refuse up front what would fail on the first step, so the user sees it now.
    const policy = await resolvePolicy(grant.plugin, caller);
    for (const r of req.repos) {
      await repoDir(policy, r.path);
      if (r.fetch && !policy.connections.has(r.fetch.connection)) throw new CollectorError(`Connection ${r.fetch.connection} is not approved for this plugin`, 'connection_not_approved', 403);
    }
    for (const h of req.http) if (!policy.connections.has(h.connection)) throw new CollectorError(`Connection ${h.connection} is not approved for this plugin`, 'connection_not_approved', 403);
    if (req.repos.some((r) => r.fetch) && await denied(grant.userId, workspaceId, 'connections', 'fetch')) throw new CollectorError('Your rules deny connections.fetch', 'connection_denied', 403);
    if (req.http.length && await denied(grant.userId, workspaceId, 'connections', 'read')) throw new CollectorError('Your rules deny connections.read', 'connection_denied', 403);
  } catch (err) {
    if (err instanceof CollectorError) return { ok: false, status: err.status, code: err.code, error: err.message };
    throw err;
  }
  const key = flightKey(grant.plugin, grant.userId);
  if ((inFlight.get(key) ?? 0) >= COLLECTOR_MAX_IN_FLIGHT) {
    return { ok: false, status: 429, code: 'too_many_runs', error: `At most ${COLLECTOR_MAX_IN_FLIGHT} collector run of a plugin at once`, retryAfter: 60 };
  }
  const limited = checkRateLimit(`plugin-host-collector:${grant.plugin}:${grant.userId}`, { capacity: COLLECTOR_RUN_BURST, refillPerSecond: COLLECTOR_RUNS_PER_HOUR / 3600 });
  if (!limited.allowed) return { ok: false, status: 429, code: 'rate_limited', error: `At most ${COLLECTOR_RUNS_PER_HOUR} collector runs an hour per plugin`, retryAfter: limited.retryAfterSeconds ?? 600 };

  const title = (req.title?.trim() || `${req.repos.length} repositories, ${req.http.length} requests`).slice(0, 200);
  // Reserve before the first await: simultaneous requests must not both pass
  // admission while their durable rows are being created.
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  const release = () => {
    const n = (inFlight.get(key) ?? 1) - 1;
    if (n > 0) inFlight.set(key, n); else inFlight.delete(key);
  };
  let row: BackgroundJob;
  try {
    row = await backgroundJobRepository.create({
      kind: 'collector', userId: grant.userId, workspaceId, title, status: 'running',
      payload: { plugin: grant.plugin, tool: grant.tool, environmentId: req.environmentId, workspaceId } satisfies RunPayload,
    });
  } catch (error) { release(); throw error; }
  void collectInBackground(row.id, grant, workspaceId, req).finally(release);
  coreLogger.info({ plugin: grant.plugin, jobId: row.id, repos: req.repos.length, http: req.http.length }, 'plugin-host: collector run started');
  return { ok: true, value: { id: row.id, status: 'running' } };
}

/** The whole run; exported for tests, which drive it without a job row through `collectEvidence`. */
export async function collectEvidence(
  grant: HostTokenGrant, workspaceId: string | null, req: CollectorRequest, signal: AbortSignal,
  onStage?: (stage: string) => Promise<void>, budget = new EvidenceBudget(),
): Promise<CollectorEvidence> {
  const startedAt = new Date().toISOString();
  const ctx: RepoContext = { grant, workspaceId, environmentId: req.environmentId, maxCommits: req.maxCommits, signal, budget };
  const repos: RepoEvidence[] = [];
  for (const r of req.repos) {
    if (budget.exhausted) {
      repos.push({ key: r.key, shallow: null, fetches: [], baseline: null, refs: [], ranges: [], pairs: [], complete: false, problems: [`not collected: ${BUDGET_EXHAUSTED}`] });
      continue;
    }
    await onStage?.(`repository ${r.key}`);
    repos.push(await collectRepo(ctx, r));
  }
  const http: HttpEvidence[] = [];
  for (const h of req.http) {
    if (budget.exhausted) {
      http.push({ id: h.id, connection: h.connection, pages: 0, items: [], total: null, complete: false, error: BUDGET_EXHAUSTED, at: new Date().toISOString() });
      continue;
    }
    await onStage?.(`request ${h.id}`);
    http.push(await collectHttp(ctx, h, repos, http));
  }
  return {
    environmentId: req.environmentId, startedAt, finishedAt: new Date().toISOString(),
    complete: repos.every((r) => r.complete) && http.every((h) => h.complete), repos, http,
  };
}

async function collectInBackground(jobId: string, grant: HostTokenGrant, workspaceId: string | null, req: CollectorRequest): Promise<void> {
  const controller = new AbortController();
  let stopped: string | null = null;
  const stop = (reason: string) => { stopped ??= reason; controller.abort(); };
  trackPluginRun(jobId, { plugin: grant.plugin, userId: grant.userId, sessionId: `collector:${jobId}`, stop });
  const timer = setTimeout(() => stop(`The collector run took longer than ${COLLECTOR_RUN_TIMEOUT_MS / 60_000} minutes and was stopped`), COLLECTOR_RUN_TIMEOUT_MS);
  timer.unref?.();
  try {
    const evidence = await collectEvidence(grant, workspaceId, req, controller.signal, (stage) => backgroundJobRepository.progress(jobId, { stage }));
    if (stopped) throw new Error(stopped);
    if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > COLLECTOR_MAX_RESULT_BYTES) throw new Error(`The evidence exceeds ${COLLECTOR_MAX_RESULT_BYTES} bytes; collect fewer repositories or a smaller range`);
    const policy = await resolvePolicy(grant.plugin, callerOf(grant, workspaceId, req.environmentId));
    await backgroundJobRepository.finish(jobId, { status: 'done', stage: 'done', result: { evidence, protectionLevel: policy.level } as unknown as Record<string, unknown> });
    coreLogger.info({ plugin: grant.plugin, jobId, complete: evidence.complete }, 'plugin-host: collector run finished');
  } catch (err) {
    const message = stopped ?? (err as Error).message;
    coreLogger.warn({ plugin: grant.plugin, jobId, err: (err as Error).message }, 'plugin-host: collector run failed');
    await backgroundJobRepository.finish(jobId, { status: 'error', error: message.slice(0, 1000) })
      .catch((e: unknown) => coreLogger.error({ jobId, err: (e as Error).message }, 'plugin-host: could not record a collector run\'s failure'));
  } finally {
    clearTimeout(timer);
    untrackPluginRun(jobId);
  }
}

/** A collector run of this package, for this user, in this workspace; null for anything else. */
async function runRow(grant: HostTokenGrant, workspaceId: string | null, id: string): Promise<(BackgroundJob & { payload: RunPayload }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await backgroundJobRepository.findById(id);
  if (!row || row.kind !== 'collector' || row.userId !== grant.userId) return null;
  const payload = row.payload as unknown as RunPayload;
  return payload.plugin === grant.plugin && payload.workspaceId === workspaceId ? row as BackgroundJob & { payload: RunPayload } : null;
}

/** Read a run (`GET /api/plugin-host/collector/runs/:id`). */
export async function readCollectorRun(grant: HostTokenGrant, principal: Principal, id: string): Promise<CollectorOutcome<CollectorRunView>> {
  const row = await runRow(grant, principal.workspaceId ?? null, id);
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'Run not found' };
  const result = (row.result ?? {}) as RunResult;
  const status: CollectorRunView['status'] = row.status === 'done' ? 'done' : row.status === 'interrupted' ? 'interrupted'
    : row.status === 'error' || row.status === 'cancelled' ? 'error' : 'running';
  let evidence: CollectorEvidence | null = null;
  let withheld: CollectorRunView['withheld'];
  if (status === 'done') {
    const level = typeof result.protectionLevel === 'number' ? result.protectionLevel : 4;
    if (level > grant.maxProtection) withheld = { protectionLevel: level };
    else {
      evidence = result.evidence ?? null;
      await noteHostRead(grant, level);
      if (grant.sessionId) raiseSessionLevel(grant.sessionId, level);
    }
  }
  return {
    ok: true,
    value: {
      id: row.id, status, title: row.title, stage: row.stage ?? null, evidence, ...(withheld ? { withheld } : {}), error: row.error ?? null,
      startedAt: (row.startedAt ?? row.createdAt).toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    },
  };
}

/** Cancel a run (`DELETE /api/plugin-host/collector/runs/:id`). */
export async function cancelCollectorRun(grant: HostTokenGrant, principal: Principal, id: string): Promise<CollectorOutcome<{ id: string; status: 'cancelled' }>> {
  const row = await runRow(grant, principal.workspaceId ?? null, id);
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'Run not found' };
  if (row.status !== 'running' && row.status !== 'queued') return { ok: false, status: 409, code: 'not_running', error: `The run is ${row.status}, not running` };
  stopPluginRun(row.id, `Cancelled by ${grant.plugin}`);
  await backgroundJobRepository.finish(row.id, { status: 'cancelled', error: `Cancelled by ${grant.plugin}` });
  return { ok: true, value: { id: row.id, status: 'cancelled' } };
}

/**
 * What the caller may collect from (`GET /api/plugin-host/collector/environments`):
 * their enabled host environments in this workspace, with the folders both the
 * owner and the admin approved, and the approved connection ids. No secrets.
 */
export async function collectorOptions(grant: HostTokenGrant, principal: Principal): Promise<CollectorOutcome<{ environments: Array<{ id: string; name: string; roots: string[] }>; connections: string[] }>> {
  if (principal.workspaceKind === 'shared') return { ok: false, status: 409, code: 'space', error: 'Collector runs start in personal workspaces only' };
  const { configuredExecutionEnvironments } = await import('@/security/execution-environments');
  const workspaceId = principal.workspaceId ?? null;
  const environments: Array<{ id: string; name: string; roots: string[] }> = [];
  let connections: string[] = [];
  for (const e of configuredExecutionEnvironments()) {
    if (e.userId !== grant.userId || (e.workspaceId !== null && e.workspaceId !== workspaceId) || !e.enabled || e.backend !== 'host') continue;
    try {
      const policy = await resolvePolicy(grant.plugin, callerOf(grant, workspaceId, e.id));
      environments.push({ id: e.id, name: e.name, roots: policy.roots });
      connections = [...policy.connections];
    } catch (err) {
      if (!(err instanceof CollectorError)) throw err;
      if (err.code === 'not_configured' || err.code === 'plugin_disabled' || err.code === 'git_read_denied') return { ok: false, status: err.status, code: err.code, error: err.message };
    }
  }
  return { ok: true, value: { environments, connections } };
}

/** Repository/ref pickers use the same current folder grant as collection. */
export async function collectorRepositories(grant: HostTokenGrant, principal: Principal, input: unknown): Promise<CollectorOutcome<unknown>> {
  const limited = checkRateLimit(`plugin-repo-picker:${grant.plugin}:${grant.userId}`, { capacity: 10, refillPerSecond: 0.5 });
  if (!limited.allowed) return { ok: false, status: 429, code: 'rate_limited', error: 'Wait a moment before browsing repositories again.' };
  if (principal.workspaceKind === 'shared') return { ok: false, status: 409, code: 'space', error: 'Repository selection requires a personal workspace.' };
  const parsed = z.object({ environmentId: z.string().min(1).max(100), root: z.string().min(1).max(2000), repository: z.string().max(2000).optional() }).strict().safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, code: 'invalid', error: 'Choose an environment and approved folder.' };
  try {
    const caller = callerOf(grant, principal.workspaceId ?? null, parsed.data.environmentId);
    const policy = await resolvePolicy(grant.plugin, caller);
    const root = await realpath(parsed.data.root);
    if (!policy.roots.some(p => pathInEnvironment(p, root))) return { ok: false, status: 403, code: 'repo_not_approved', error: 'The selected folder is not approved for this plugin.' };
    if (policy.level > grant.maxProtection) return { ok: false, status: 403, code: 'protection_level', error: 'This plugin cannot read evidence at the configured protection level.' };
    const { setupRepositories } = await import('./setup-repositories');
    const value = await setupRepositories(caller, parsed.data.environmentId, root, parsed.data.repository, policy.roots);
    await noteHostRead(grant, policy.level);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CollectorError) return { ok: false, status: error.status, code: error.code, error: error.message };
    return { ok: false, status: 400, code: 'discovery_failed', error: error instanceof Error ? error.message : 'Repository discovery failed.' };
  }
}

export { CollectorError };
