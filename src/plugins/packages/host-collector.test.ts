/**
 * `repos:collect` (./host-collector.ts) against real temporary Git
 * repositories: ancestry, source-only commits, cherry-picks, same tree with a
 * different history, reverts, shallow clones, unknown refs, fetches into the
 * audit namespace only, pagination and the authorization boundary (approved
 * folders, environments, connections, rules, ownership of runs).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PluginProtectionApproval } from '@/shared/plugin-protection';
import type { HostTokenGrant } from './host-api';

const h = vi.hoisted(() => ({
  environments: [] as Array<Record<string, unknown>>,
  approval: null as PluginProtectionApproval|null,
  settings: {} as Record<string, string>,
  enabled: true,
  deny: new Set<string>(),
  jobs: new Map<string, Record<string, unknown>>(),
  pages: new Map<string, { status: number; body: unknown }>(),
  remotes: new Map<string, string>(),
  fetchCalls: [] as string[],
  httpCalls: [] as string[],
  afterFetch: null as null | (() => void),
}));

vi.mock('@/security/execution-environments', async (orig) => {
  const real = await orig<typeof import('@/security/execution-environments')>();
  const forCaller = (c: { userId: string; workspaceId?: string | null; metadata?: Record<string, unknown> | null }) => {
    const entries = h.environments.filter((e) => e.userId === c.userId && (e.workspaceId === null || e.workspaceId === c.workspaceId));
    const selected = entries.find((e) => e.id === c.metadata?.executionEnvironmentId);
    if (!selected?.enabled) throw new Error('Execution environment was removed, disabled or is unavailable for this account/workspace.');
    return selected;
  };
  return { ...real, executionEnvironmentFor: forCaller, configuredExecutionEnvironments: () => h.environments };
});
vi.mock('@/db/repositories/plugin-protection-repository',()=>({pluginProtectionRepository:{get:async()=>h.approval}}));
vi.mock('./service', () => ({ findRow: async () => ({ enabled: h.enabled, settings: h.settings, contentHash:`sha256:${'a'.repeat(64)}` }) }));
vi.mock('@/security/permissions', () => ({
  getPermissionManager: () => ({ check: async (_u: string, tool: string, action: string) => ({ level: h.deny.has(`${tool}.${action}`) ? 'DENY' : 'ALLOW' }) }),
}));
vi.mock('@/core/protection/session-level', () => ({ raiseSessionLevel: () => {} }));
vi.mock('./read-level', () => ({ recordReadLevel: async () => {} }));
vi.mock('@/db/repositories/background-job-repository', () => ({
  backgroundJobRepository: {
    create: async (input: Record<string, unknown>) => {
      const row = { ...input, id: globalThis.crypto.randomUUID(), createdAt: new Date(), startedAt: new Date(), finishedAt: null, stage: null, error: null, result: null };
      h.jobs.set(row.id, row);
      return row;
    },
    progress: async (id: string, u: Record<string, unknown>) => { const r = h.jobs.get(id); if (r?.status === 'running') Object.assign(r, u); },
    finish: async (id: string, o: Record<string, unknown>) => {
      const r = h.jobs.get(id);
      if (r?.status !== 'running') return null;
      Object.assign(r, o, { finishedAt: new Date() });
      return r;
    },
    findById: async (id: string) => h.jobs.get(id) ?? null,
  },
}));
vi.mock('@/security/credential-connections', () => ({
  connectionFor: async (id: string) => ({ id, http:{origin:'https://example.com',pathPrefix:'/api'} }),
  readBoundedResponse: async (r: { text: string }, max: number) => {
    if (Buffer.byteLength(r.text, 'utf8') > max) throw new Error('Connection response exceeded the supported size');
    return r.text;
  },
  authenticatedFetch: async (_p: unknown, _c: unknown, path: string) => {
    h.httpCalls.push(path);
    const page = h.pages.get(path);
    if (!page) throw new Error(`unexpected path ${path}`);
    return { response: { ok: page.status < 400, status: page.status, text: JSON.stringify(page.body) }, mask: (v: unknown) => v };
  },
}));
// The broker is tested in credential-git.test.ts; here it fetches from a local fixture "remote" with the same refspec rules.
vi.mock('@/security/credential-git', () => ({
  authenticatedGit: async (_p: unknown, _c: unknown, args: { path: string; remotePath: string; refspecs: string[] }) => {
    h.fetchCalls.push(...args.refspecs);
    for (const r of args.refspecs) if (!/^\+?refs\/[A-Za-z0-9_./*-]+:refs\/(?:remotes|tags)\/[A-Za-z0-9_./*-]+$/.test(r)) throw new Error('bad refspec');
    execFileSync('git', ['fetch', '--no-tags', h.remotes.get(args.remotePath) ?? '/nonexistent', ...args.refspecs], { cwd: args.path, stdio: 'pipe' });
    h.afterFetch?.();
    return { exitCode: 0 };
  },
}));

const { collectEvidence, collectorRequestSchema, paginate, issueKeys, startCollectorRun, readCollectorRun, cancelCollectorRun, collectorOptions, auditRef, EvidenceBudget, BUDGET_EXHAUSTED } = await import('./host-collector');

let root: string;
let outside: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null' },
}).trim();
const commit = (cwd: string, file: string, content: string, message: string) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };

const grant = (over: Partial<HostTokenGrant> = {}): HostTokenGrant => ({
  plugin: 'release-reconcile', userId: 'user-a', workspaceId: null, sessionId: null, scopes: ['repos:collect'], maxProtection: 4,
  tool: 'audit_start', effect: 'write', expiresAt: Date.now() + 30_000, ...over,
});
const principal = (userId = 'user-a', workspaceId = 'ws-a', workspaceKind: 'personal' | 'shared' = 'personal') =>
  ({ kind: 'user', userId, username: userId, isAdmin: false, sessionToken: null, roles: ['user'], workspaceId, workspaceKind }) as never;

const repoPath = () => join(root, 'service');
let shas: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'collector-root-'));
  outside = mkdtempSync(join(tmpdir(), 'collector-outside-'));
  const remote = join(root, 'remote-service');
  mkdirSync(remote);
  git(remote, 'init', '-q', '-b', 'main');
  shas.base = commit(remote, 'app.txt', 'v0\n', 'Initial');
  git(remote, 'tag', 'v1.0.0');
  // source: three ticketed changes, one revert
  git(remote, 'checkout', '-q', '-b', 'source');
  shas.a = commit(remote, 'a.txt', 'a\n', 'ABC-1: add a');
  shas.b = commit(remote, 'b.txt', 'b\n', 'ABC-2: add b');
  shas.c = commit(remote, 'c.txt', 'c\n', 'ABC-3: add c');
  git(remote, 'revert', '--no-edit', shas.c);
  shas.revert = git(remote, 'rev-parse', 'HEAD');
  // release: merged ABC-1 by merge, cherry-picked ABC-2 (patch-equivalent, different sha)
  git(remote, 'checkout', '-q', '-b', 'release', shas.base);
  git(remote, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/ABC-1' into 'release'\n\nSee merge request group/service!7", shas.a);
  git(remote, 'cherry-pick', shas.b);
  shas.picked = git(remote, 'rev-parse', 'HEAD');
  // mirror: same tree as source, separate history (a squash)
  git(remote, 'checkout', '-q', '-b', 'mirror', shas.base);
  git(remote, 'merge', '-q', '--squash', 'source');
  git(remote, 'commit', '-q', '-m', 'ABC-9: squash of source');
  git(remote, 'checkout', '-q', 'main');
  git(root, 'clone', '-q', remote, 'service');
  git(root, 'clone', '-q', '--depth', '1', `file://${remote}`, 'shallow');
  h.remotes.set('/group/service.git', remote);
  symlinkSync(outside, join(root, 'escape'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

beforeEach(() => {
  h.environments = [
    { id: 'env-a', name: 'Workstation', userId: 'user-a', workspaceId: null, enabled: true, isDefault: true, backend: 'host', roots: [root], pathDirectories: [] },
    { id: 'env-b', name: 'Other', userId: 'user-b', workspaceId: null, enabled: true, isDefault: true, backend: 'host', roots: [root], pathDirectories: [] },
    { id: 'env-ssh', name: 'Remote', userId: 'user-a', workspaceId: null, enabled: true, isDefault: false, backend: 'ssh', roots: ['/srv'], pathDirectories: [] },
  ];
  h.settings = { collector_roots: root, collector_connections: 'forge, tracker', collector_protection_level: '1' };
  h.enabled = true;
  h.approval = null;
  h.deny.clear();
  h.pages.clear();
  h.fetchCalls.length = 0;
  h.httpCalls.length = 0;
  h.afterFetch = null;
});

const request = (over: Record<string, unknown> = {}) => collectorRequestSchema.parse({
  environmentId: 'env-a',
  repos: [{
    key: 'service', path: repoPath(), fetch: { connection: 'forge', remotePath: '/group/service.git' },
    baseline: { name: 'baseline', tag: 'v1.0.0' },
    refs: [{ name: 'source', branch: 'source' }, { name: 'release', branch: 'release' }, { name: 'mirror', branch: 'mirror' }],
  }],
  ...over,
});
const collect = (req = request(), g = grant()) => collectEvidence(g, 'ws-a', req, new AbortController().signal);

describe('git evidence', () => {
  test('fetches into the audit namespace only and resolves immutable SHAs', async () => {
    const before = git(repoPath(), 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags');
    const ev = await collect();
    const repo = ev.repos[0];
    expect(ev.complete).toBe(true);
    expect(repo.fetches.every((f) => f.ok && f.refspec.includes(':refs/remotes/octipus-audit/'))).toBe(true);
    expect(git(repoPath(), 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags')).toBe(before);
    expect(repo.baseline?.sha).toBe(shas.base);
    expect(repo.refs.find((r) => r.name === 'release')?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('ancestry, source-only, cherry-pick equivalence and reverts', async () => {
    const repo = (await collect()).repos[0];
    const pair = repo.pairs.find((p) => p.a === 'source' && p.b === 'release')!;
    expect(pair.aInB).toBe(false);
    expect(pair.bInA).toBe(false);
    // A is merged by ancestry (absent from cherry), B is cherry-picked (equivalent), C and its revert are source-only.
    expect(pair.cherryAtoB.find((c) => c.sha === shas.a)).toBeUndefined();
    expect(pair.cherryAtoB.find((c) => c.sha === shas.b)?.equivalent).toBe(true);
    expect(pair.cherryAtoB.find((c) => c.sha === shas.c)?.equivalent).toBe(false);
    const source = repo.ranges.find((r) => r.ref === 'source')!;
    expect(source.baselineIsAncestor).toBe(true);
    expect(source.commits.find((c) => c.sha === shas.revert)?.body).toContain(`This reverts commit ${shas.c}`);
    const release = repo.ranges.find((r) => r.ref === 'release')!;
    expect(release.commits.find((c) => c.parents.length === 2)?.body).toContain('!7');
  });

  test('same tree with a different history', async () => {
    const pair = (await collect()).repos[0].pairs.find((p) => p.a === 'source' && p.b === 'mirror')!;
    expect(pair.sameTree).toBe(true);
    expect(pair.aInB || pair.bInA).toBe(false);
    expect(pair.changedFiles).toEqual([]);
    // Release got A by merge and B by cherry-pick; C was reverted on source: equal trees, diverged ancestry.
    const rel = (await collect()).repos[0].pairs.find((p) => p.a === 'source' && p.b === 'release')!;
    expect(rel).toMatchObject({ sameTree: true, aInB: false, bInA: false });
    const ev = await collect(request({ repos: [{ ...request().repos[0], refs: [{ name: 'source', branch: 'source' }, { name: 'main', branch: 'main' }] }] }));
    expect(ev.repos[0].pairs[0]).toMatchObject({ sameTree: false, bInA: true, changedFiles: ['a.txt', 'b.txt'] });
  });

  test('a failed fetch or unknown ref is unknown, never a verdict', async () => {
    const ev = await collect(request({ repos: [{ ...request().repos[0], refs: [{ name: 'gone', branch: 'no-such-branch' }, { name: 'release', branch: 'release' }] }] }));
    const repo = ev.repos[0];
    expect(ev.complete).toBe(false);
    expect(repo.refs.find((r) => r.name === 'gone')).toMatchObject({ status: 'fetch_failed', sha: null });
    expect(repo.ranges.map((r) => r.ref)).toEqual(['release']);
    const local = await collect(request({ repos: [{ key: 'service', path: repoPath(), baseline: { name: 'b', sha: shas.base }, refs: [{ name: 'x', localRef: 'refs/heads/nope' }] }] }));
    expect(local.repos[0].refs[0].status).toBe('missing');
    expect(local.complete).toBe(false);
  });

  test('a shallow clone is incomplete', async () => {
    const ev = await collect(request({ repos: [{ key: 's', path: join(root, 'shallow'), baseline: { name: 'b', localRef: 'refs/heads/main' }, refs: [{ name: 'm', localRef: 'refs/heads/main' }] }] }));
    expect(ev.repos[0].shallow).toBe(true);
    expect(ev.complete).toBe(false);
  });

  test('a truncated range is incomplete', async () => {
    const ev = await collect(request({ maxCommits: 1 }));
    expect(ev.repos[0].ranges.find((r) => r.ref === 'source')?.truncated).toBe(true);
    expect(ev.complete).toBe(false);
  });
});

describe('authorization', () => {
  test('an explicit Git read denial blocks collection and discovery before fetching', async () => {
    h.deny.add('git.read');
    await expect(collect()).rejects.toMatchObject({ code: 'git_read_denied' });
    expect(await startCollectorRun(grant(), principal(), request())).toMatchObject({ ok: false, code: 'git_read_denied' });
    expect(await collectorOptions(grant(), principal())).toMatchObject({ ok: false, code: 'git_read_denied' });
    expect(h.fetchCalls).toEqual([]);
    expect(h.httpCalls).toEqual([]);
  });
  test('a folder outside the approved roots, by traversal or symlink, is refused', async () => {
    await expect(collect(request({ repos: [{ ...request().repos[0], path: `${root}/../${outside.split('/').pop()}` }] }))).rejects.toMatchObject({ code: 'repo_not_approved' });
    await expect(collect(request({ repos: [{ ...request().repos[0], path: join(root, 'escape') }] }))).rejects.toMatchObject({ code: 'repo_not_approved' });
    h.settings.collector_roots = join(root, 'elsewhere');
    await expect(collect()).rejects.toMatchObject({ code: 'repo_not_approved' });
  });

  test('another user\'s, a disabled or a non-host environment is refused', async () => {
    await expect(collect(request({ environmentId: 'env-b' }))).rejects.toMatchObject({ code: 'environment_unavailable' });
    await expect(collect(request({ environmentId: 'env-ssh' }))).rejects.toMatchObject({ code: 'environment_backend' });
    h.environments[0].enabled = false;
    await expect(collect()).rejects.toMatchObject({ code: 'environment_unavailable' });
  });

  test('unapproved connections, DENY rules, an unclassified or disabled package are refused', async () => {
    h.settings.collector_connections = 'tracker';
    await expect(collect()).rejects.toMatchObject({ code: 'connection_not_approved' });
    h.settings.collector_connections = 'forge';
    h.deny.add('connections.fetch');
    const ev = await collect();
    expect(ev.complete).toBe(false);
    expect(ev.repos[0].fetches.every((f) => !f.ok)).toBe(true);
    expect(h.fetchCalls).toEqual([]);
    delete h.settings.collector_protection_level;
    await expect(collect()).rejects.toMatchObject({ code: 'not_configured' });
    h.settings.collector_protection_level = '1';
    h.enabled = false;
    await expect(collect()).rejects.toMatchObject({ code: 'plugin_disabled' });
  });

  test('a connection withdrawn between two fetches stops every later authenticated fetch', async () => {
    h.afterFetch = () => { h.settings.collector_connections = 'tracker'; };
    const ev = await collect();
    const fetches = ev.repos[0].fetches;
    expect(h.fetchCalls).toHaveLength(1);
    expect(fetches[0].ok).toBe(true);
    expect(fetches.slice(1).length).toBeGreaterThan(0);
    expect(fetches.slice(1).every((f) => !f.ok && f.error?.includes('not approved'))).toBe(true);
    expect(ev.complete).toBe(false);
  });

  test('the request schema refuses flags, traversal refs and unknown fields', () => {
    for (const bad of ['-x', '--upload-pack=x', 'a..b', 'a//b', 'x.lock', 'a@{1}', 'trailing/']) {
      expect(collectorRequestSchema.safeParse({ environmentId: 'e', repos: [{ key: 'k', path: '/r', baseline: { name: 'b', branch: bad }, refs: [{ name: 'r', branch: 'ok' }] }] }).success).toBe(false);
    }
    expect(collectorRequestSchema.safeParse({ environmentId: 'e', repos: [], http: [], shell: 'ls' }).success).toBe(false);
    expect(collectorRequestSchema.safeParse({ environmentId: 'e', http: [{ id: 'h', connection: 'c', path: 'https://evil.example/x', pagination: { type: 'none', itemsPointer: '' } }] }).success).toBe(false);
    expect(auditRef({ name: 'n', tag: 'v1' })?.dest).toBe('refs/remotes/octipus-audit/tags/v1');
  });

  test('runs: write tool to start, one at a time, owned by user, workspace and plugin', async () => {
    expect((await startCollectorRun(grant({ effect: 'read' }), principal(), request())).ok).toBe(false);
    expect(await startCollectorRun(grant(), principal('user-a', 'space', 'shared'), request())).toMatchObject({ ok: false, code: 'space' });
    const started = await startCollectorRun(grant(), principal(), request());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await startCollectorRun(grant(), principal(), request())).toMatchObject({ ok: false, code: 'too_many_runs' });
    expect(await readCollectorRun(grant({ userId: 'user-b' }), principal('user-b'), started.value.id)).toMatchObject({ ok: false, status: 404 });
    expect(await readCollectorRun(grant(), principal('user-a', 'ws-other'), started.value.id)).toMatchObject({ ok: false, status: 404 });
    expect(await readCollectorRun(grant({ plugin: 'other' }), principal(), started.value.id)).toMatchObject({ ok: false, status: 404 });
    await vi.waitFor(async () => {
      const r = await readCollectorRun(grant({ effect: 'read' }), principal(), started.value.id);
      expect(r.ok && r.value.status).toBe('done');
    }, { timeout: 20_000 });
    const done = await readCollectorRun(grant({ maxProtection: 4 }), principal(), started.value.id);
    expect(done.ok && done.value.evidence?.repos[0].key).toBe('service');
    h.settings.collector_protection_level = '3';
    const again = await startCollectorRun(grant(), principal(), request());
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(await cancelCollectorRun(grant({ userId: 'user-b' }), principal('user-b'), again.value.id)).toMatchObject({ ok: false, status: 404 });
    await vi.waitFor(async () => {
      const r = await readCollectorRun(grant({ maxProtection: 1 }), principal(), again.value.id);
      expect(r.ok && r.value.status).toBe('done');
    }, { timeout: 20_000 });
    // Above the package's maxProtection: withheld, not handed over.
    const withheld = await readCollectorRun(grant({ maxProtection: 1 }), principal(), again.value.id);
    expect(withheld.ok && withheld.value).toMatchObject({ evidence: null, withheld: { protectionLevel: 3 } });
  }, 60_000);

  test('options list only the caller\'s enabled host environments and approved folders', async () => {
    const out = await collectorOptions(grant(), principal());
    expect(out.ok && out.value.environments.map((e) => e.id)).toEqual(['env-a']);
    expect(out.ok && out.value.connections.sort()).toEqual(['forge', 'tracker']);
  });

  test('simultaneous requests admit one run, not one per pending database insert', async () => {
    const started = await Promise.all([startCollectorRun(grant(), principal(), request()), startCollectorRun(grant(), principal(), request())]);
    expect(started.filter(result => result.ok)).toHaveLength(1);
    expect(started.filter(result => !result.ok)).toMatchObject([{ code: 'too_many_runs' }]);
    const accepted = started.find(result => result.ok)!;
    if (accepted.ok) await vi.waitFor(async () => {
      const view = await readCollectorRun(grant(), principal(), accepted.value.id);
      expect(view.ok && view.value.status).toBe('done');
    }, { timeout: 20_000 });
  });
});

describe('key expansion', () => {
  test('keys come from the host pattern of declared projects only', () => {
    expect(issueKeys(['ABC', 'XY'], ['ABC-1: x', 'see XY-22 and ABC-1', 'ZZZ-3 xABC-4 ABC-0 ABC-12345678901', 'MERGE abc-5'])).toEqual(['ABC-1', 'XY-22']);
  });

  test('a request repeats over commit keys, then over keys at a pointer of its items', async () => {
    h.pages.set(`/rest/search?jql=${encodeURIComponent('ABC-1,ABC-2,ABC-3,ABC-9')}`, { status: 200, body: { issues: [{ key: 'ABC-1', parent: { key: 'ABC-50' } }, { key: 'ABC-2' }, { key: 'ABC-3', parent: { key: 'ABC-50' } }] } });
    h.pages.set(`/rest/search?jql=${encodeURIComponent('ABC-50')}`, { status: 200, body: { issues: [{ key: 'ABC-50' }] } });
    const req = request({ http: [
      { id: 'committed', connection: 'tracker', path: '/rest/search?jql={keys}', pagination: { type: 'none', itemsPointer: '/issues' }, expand: { projects: ['ABC'], from: { source: 'commits' } } },
      { id: 'parents', connection: 'tracker', path: '/rest/search?jql={keys}', pagination: { type: 'none', itemsPointer: '/issues' }, expand: { projects: ['ABC'], from: { source: 'http', id: 'committed', pointer: '/parent/key' } } },
    ] });
    const ev = await collect(req);
    expect(ev.http[0]).toMatchObject({ keys: ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-9'], complete: true });
    expect(ev.http[1]).toMatchObject({ keys: ['ABC-50'], items: [{ key: 'ABC-50' }], complete: true });
    expect(collectorRequestSchema.safeParse({ environmentId: 'e', http: [{ id: 'a', connection: 'c', path: '/x?{keys}', pagination: { type: 'none', itemsPointer: '' } }] }).success).toBe(false);
    expect(collectorRequestSchema.safeParse({ environmentId: 'e', http: [{ id: 'a', connection: 'c', path: '/x?{keys}', pagination: { type: 'none', itemsPointer: '' }, expand: { projects: ['A'], from: { source: 'http', id: 'later', pointer: '' } } }] }).success).toBe(false);
  });

  test('keys from incomplete evidence make the expansion incomplete', async () => {
    h.pages.set(`/rest/search?jql=${encodeURIComponent('ABC-1,ABC-2,ABC-3,ABC-9')}`, { status: 200, body: { issues: [] } });
    const req = request({ maxCommits: 1, http: [{ id: 'committed', connection: 'tracker', path: '/rest/search?jql={keys}', pagination: { type: 'none', itemsPointer: '/issues' }, expand: { projects: ['ABC'], from: { source: 'commits' } } }] });
    const ev = await collect(req);
    expect(ev.http[0].complete).toBe(false);
  });
});

describe('pagination', () => {
  const spec = (pagination: unknown, maxPages = 5) => collectorRequestSchema.parse({ environmentId: 'e', http: [{ id: 'h', connection: 'tracker', path: '/api/search?q=x', pagination, maxPages }] }).http[0];
  const pages = (map: Record<string, unknown>) => async (path: string) => { if (!(path in map)) throw new Error(`HTTP 500 at ${path}`); return map[path]; };

  test('offset with total, token with isLast, page by short page', async () => {
    const off = await paginate(spec({ type: 'offset', itemsPointer: '/issues', startParam: 'startAt', limitParam: 'maxResults', limit: 2, totalPointer: '/total' }), pages({
      '/api/search?q=x&startAt=0&maxResults=2': { issues: [1, 2], total: 3 }, '/api/search?q=x&startAt=2&maxResults=2': { issues: [3], total: 3 },
    }));
    expect(off).toMatchObject({ items: [1, 2, 3], complete: true, total: 3, pages: 2 });
    const tok = await paginate(spec({ type: 'token', itemsPointer: '/issues', tokenParam: 'nextPageToken', nextTokenPointer: '/nextPageToken', lastPointer: '/isLast' }), pages({
      '/api/search?q=x': { issues: [1], nextPageToken: 't2', isLast: false }, '/api/search?q=x&nextPageToken=t2': { issues: [2], isLast: true },
    }));
    expect(tok).toMatchObject({ items: [1, 2], complete: true });
    const pg = await paginate(spec({ type: 'page', itemsPointer: '', pageParam: 'page', perPageParam: 'per_page', perPage: 2 }), pages({
      '/api/search?q=x&page=1&per_page=2': [1, 2], '/api/search?q=x&page=2&per_page=2': [],
    }));
    expect(pg).toMatchObject({ items: [1, 2], complete: true });
  });

  test('errors, caps, missing totals and inconsistent pages are incomplete', async () => {
    const failing = await paginate(spec({ type: 'offset', itemsPointer: '/issues', startParam: 's', limitParam: 'l', limit: 1, totalPointer: '/total' }), pages({ '/api/search?q=x&s=0&l=1': { issues: [1], total: 5 } }));
    expect(failing).toMatchObject({ items: [1], complete: false });
    expect(failing.error).toContain('HTTP 500');
    const capped = await paginate(spec({ type: 'token', itemsPointer: '/v', tokenParam: 't', nextTokenPointer: '/n' }, 1), pages({ '/api/search?q=x': { v: [1], n: 'more' } }));
    expect(capped).toMatchObject({ complete: false, error: 'Stopped at 1 pages' });
    const notArray = await paginate(spec({ type: 'none', itemsPointer: '/issues' }), pages({ '/api/search?q=x': { issues: 'x' } }));
    expect(notArray.complete).toBe(false);
    const shrunk = await paginate(spec({ type: 'offset', itemsPointer: '/i', startParam: 's', limitParam: 'l', limit: 2, totalPointer: '/total' }), pages({ '/api/search?q=x&s=0&l=2': { i: [1, 2], total: 4 }, '/api/search?q=x&s=2&l=2': { i: [], total: 4 } }));
    expect(shrunk.complete).toBe(false);
    const noLast = await paginate(spec({ type: 'token', itemsPointer: '/v', tokenParam: 't', nextTokenPointer: '/n', lastPointer: '/last' }), pages({ '/api/search?q=x': { v: [1], last: false } }));
    expect(noLast.complete).toBe(false);
  });

  test('pages that each fit stop at the cumulative budget: no later request, nothing beyond it kept', async () => {
    const item = { key: 'ABC-1', text: 'ä'.repeat(20) }; // 2 bytes per character in UTF-8: not counted as code units
    const size = Buffer.byteLength(JSON.stringify([item]), 'utf8');
    const map: Record<string, unknown> = {};
    for (let i = 1; i <= 10; i++) map[`/api/search?q=x&page=${i}&per_page=1`] = [item];
    const asked: string[] = [];
    const budget = new EvidenceBudget(size * 3 + 1);
    const out = await paginate(spec({ type: 'page', itemsPointer: '', pageParam: 'page', perPageParam: 'per_page', perPage: 1 }, 10), async (path) => { asked.push(path); return map[path]; }, budget);
    expect(out).toMatchObject({ complete: false, error: BUDGET_EXHAUSTED });
    expect(out.items).toHaveLength(3);
    expect(asked).toHaveLength(4);
    expect(budget.exhausted).toBe(true);
    // A UTF-16 count would have let a fourth page in.
    expect(JSON.stringify([item]).length * 4).toBeLessThanOrEqual(size * 3 + 1);
  });

  test('the budget spans expanded batches and requests, and bounds the read of a page', async () => {
    const keys = ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-9'];
    for (const k of keys) h.pages.set(`/rest/search?jql=${encodeURIComponent(k)}`, { status: 200, body: { issues: [{ key: k, pad: 'x'.repeat(200) }] } });
    h.pages.set('/api/later', { status: 200, body: [] });
    const req = request({ http: [
      { id: 'committed', connection: 'tracker', path: '/rest/search?jql={keys}', pagination: { type: 'none', itemsPointer: '/issues' }, expand: { projects: ['ABC'], from: { source: 'commits' }, batch: 1 } },
      { id: 'later', connection: 'tracker', path: '/api/later', pagination: { type: 'none', itemsPointer: '' } },
    ] });
    const probe = new EvidenceBudget();
    const full = await collectEvidence(grant(), 'ws-a', req, new AbortController().signal, undefined, probe);
    expect(full.complete).toBe(true);
    const used = Buffer.byteLength(JSON.stringify(full.repos.flatMap((r) => [...r.ranges, ...r.pairs])), 'utf8');
    h.httpCalls.length = 0;
    // Room for the repositories, the keys and one batch of items: the second batch's read is cut off.
    const budget = new EvidenceBudget(used + 400);
    const ev = await collectEvidence(grant(), 'ws-a', req, new AbortController().signal, undefined, budget);
    expect(budget.exhausted).toBe(true);
    expect(ev.complete).toBe(false);
    expect(ev.http[0]).toMatchObject({ complete: false });
    expect(ev.http[0].items.length).toBeLessThan(keys.length);
    expect(ev.http[1]).toMatchObject({ complete: false, error: BUDGET_EXHAUSTED, items: [] });
    expect(h.httpCalls.length).toBeLessThanOrEqual(2);
    expect(h.httpCalls).not.toContain('/api/later');
    // A repository after the budget ran out is not read at all.
    const none = await collectEvidence(grant(), 'ws-a', request(), new AbortController().signal, undefined, new EvidenceBudget(10));
    expect(none.repos[0]).toMatchObject({ complete: false, ranges: [] });
    expect(none.repos[0].problems.join(' ')).toContain('budget');
  });

  test('an HTTP request through an unapproved connection is refused per page', async () => {
    h.settings.collector_connections = 'forge';
    const ev = await collectEvidence(grant(), 'ws-a', collectorRequestSchema.parse({ environmentId: 'env-a', http: [{ id: 'h', connection: 'tracker', path: '/api/x', pagination: { type: 'none', itemsPointer: '' } }] }), new AbortController().signal);
    expect(ev.http[0]).toMatchObject({ complete: false });
    expect(ev.http[0].error).toContain('not approved');
    h.settings.collector_connections = 'tracker';
    h.pages.set('/api/x', { status: 200, body: [{ key: 'ABC-1' }] });
    const ok = await collectEvidence(grant(), 'ws-a', collectorRequestSchema.parse({ environmentId: 'env-a', http: [{ id: 'h', connection: 'tracker', path: '/api/x', pagination: { type: 'none', itemsPointer: '' } }] }), new AbortController().signal);
    expect(ok.http[0]).toMatchObject({ complete: true, items: [{ key: 'ABC-1' }] });
  });
});

describe('owner-configured Internal destinations',()=>{
 const approval=():PluginProtectionApproval=>({contentHash:`sha256:${'a'.repeat(64)}`,level:2,connections:['forge','tracker'].map(id=>({id,origin:'https://example.com',pathPrefix:'/api'})),approvedBy:'owner',approvedAt:'2026-11-18T00:00:00Z'});
 test('the classification floor and real evidence collection follow approval without changing the package',async()=>{
  const {resolvePolicy,callerOf}=await import('./host-collector');
  const {protectionApprovalStamp}=await import('./protection-policy');
  h.approval=approval();
  expect((await resolvePolicy('release-reconcile',callerOf(grant(),'ws-a','env-a'))).level).toBe(2);
  expect((await collect(request(),grant({dataApproval:protectionApprovalStamp(h.approval),maxProtection:2}))).complete).toBe(true);
 });
 test('a reused connection name with a changed destination never reaches the broker',async()=>{
  const {protectionApprovalStamp}=await import('./protection-policy');
  h.approval=approval();h.approval.connections[0].origin='https://different.example.com';
  const result=await collect(request(),grant({dataApproval:protectionApprovalStamp(h.approval),maxProtection:2}));
  expect(result.complete).toBe(false);expect(h.fetchCalls).toHaveLength(0);
 });
 test('withdrawing Internal approval during a run stops later authenticated fetches',async()=>{
  const {protectionApprovalStamp}=await import('./protection-policy');
  h.approval=approval();const tokenStamp=protectionApprovalStamp(h.approval);
  h.afterFetch=()=>{h.approval={...approval(),level:1};};
  const result=await collect(request(),grant({dataApproval:tokenStamp,maxProtection:2}));
  expect(result.complete).toBe(false);expect(h.fetchCalls).toHaveLength(1);
 });
});
