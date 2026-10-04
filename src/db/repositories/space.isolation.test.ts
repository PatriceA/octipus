/**
 * I2 — personal paths never return space rows (docs/plans/coworking-spec.md
 * §3, §5.5, §5.11).
 *
 * Alice is a member of a space and the author of a row in every content
 * table there. Through every personal path — the scoped repositories (with
 * and without a workspace), the singleton note / link repositories, the raw
 * readers of §1.2, knowledge search, global search and the admin bypasses —
 * none of those rows comes back, for Alice or for an admin. Through the
 * space door (`contentRepos` with the space principal) they all do.
 *
 * The raw-reader half is grep-driven: every `.from(<content table>)` (and
 * raw `FROM`/`JOIN` of one) outside the allowlist below fails the suite, so a
 * new raw read has to either carry `notInSharedWorkspace` in a listed file or
 * go through a repository.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Principal } from '@/security/principal';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

// ── Grep-driven raw readers ─────────────────────────────────────────────

const CONTENT_SYMBOLS = ['notes', 'tasks', 'taskComments', 'documents', 'artifacts', 'knowledgeLinks', 'embeddings', 'memories', 'sessions', 'messages', 'agents', 'notifications', 'pipelines'];
const CONTENT_TABLES = ['notes', 'tasks', 'task_comments', 'documents', 'artifacts', 'knowledge_links', 'embeddings', 'memories', 'sessions', 'messages', 'agents', 'notifications', 'pipelines'];
const RAW_READ = new RegExp(
  `(?<!Array)\\.(?:from|innerJoin|leftJoin)\\((?:${CONTENT_SYMBOLS.join('|')})\\b|\\b(?:FROM|JOIN)\\s+(?:${CONTENT_TABLES.join('|')})\\b`,
);

/**
 * Files allowed to read content tables directly, and why. "Personal reader"
 * entries are the §1.2 raw readers: they must carry `notInSharedWorkspace`
 * (checked below).
 */
const ALLOWLIST: Record<string, string> = {
  // The access layer itself.
  'src/db/repositories/scoped.ts': 'personal repositories (RepoScope)',
  'src/db/repositories/space.ts': 'space repositories (RepoScope, artifacts by membership)',
  'src/db/repositories/note-repository.ts': 'notes by NoteScope (personal predicate or space)',
  'src/db/repositories/knowledge-link-repository.ts': 'links by NoteScope; writes and cleanup by entity id',
  'src/core/rag/embeddings.ts': 'every read through scopePredicate (KnowledgeScope)',
  'src/core/rag/retention-service.ts': 'every pass through scopePredicate (KnowledgeScope)',
  'src/security/workspace-resolver.ts': 'workspace of a session/agent/pipeline the caller owns, by id',
  // Unscoped repositories keyed by an id the caller already holds (a session, an agent run).
  'src/db/repositories/session-repository.ts': 'system-side session store, keyed by session id',
  'src/db/repositories/message-repository.ts': 'system-side message store, keyed by session id',
  'src/db/repositories/agent-repository.ts': 'system-side agent store, keyed by agent id',
  'src/db/repositories/document-repository.ts': 'document processor store, keyed by document id',
  'src/db/repositories/artifacts-repository.ts': 'artifact rows by id or workspace id',
  'src/db/repositories/pipeline-repository.ts': 'pipeline run state, keyed by pipeline id',
  'src/db/repositories/task-state-repository.ts': 'session task state, keyed by session id',
  'src/db/repositories/work-plan-repository.ts': "a session's plan, keyed by session id and owner",
  'src/core/agent/pipeline-manager.ts': 'pipeline run state, keyed by pipeline id',
  'src/core/learning/evidence.ts': "a session's own messages, keyed by session id",
  'src/core/invariants.ts': 'system invariant checks',
  'src/core/artifacts/cleanup.ts': 'system cleanup job',
  'src/core/spaces/membership.ts': "a member's rows in one space, after a membership change",
  'src/core/spaces/purge.ts': "a space's rows, by its id",
  'src/security/orgs.ts': 'workspace transfer/delete, by workspace id',
  'src/security/permissions.ts': "a workspace's permission requests, by workspace id",
  'src/security/quotas.ts': 'counts for quota enforcement',
  'src/security/spend-budgets.ts': 'cost attribution joins',
  'src/core/notification-service.ts': "a user's own inbox (every notification of a user is theirs)",
  'src/core/memory/repository.ts': 'personal memories by MemoryAccessScope (space memory is S2)',
  // §1.2 personal raw readers: each carries notInSharedWorkspace.
  'src/api/routes/graph.ts': 'personal reader',
  'src/api/routes/memory.ts': 'personal reader',
  'src/api/routes/search.ts': 'personal reader',
  'src/core/heartbeat.ts': 'personal reader',
  'src/core/tasks/role-agents.ts': 'personal reader',
  'src/core/tasks/wakeup-bridge.ts': 'personal reader',
  'src/core/channels/taken-tasks.ts': 'personal reader',
  'src/core/knowledge/weekly-review.ts': 'personal reader',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'test-helpers' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('raw readers of content tables (grep-driven)', () => {
  const root = join(__dirname, '..', '..', '..');
  const readers = new Map<string, string[]>();
  for (const file of sourceFiles(join(root, 'src'))) {
    const rel = relative(root, file).split('\\').join('/');
    if (rel.startsWith('src/db/schema/') || rel.startsWith('src/db/migrations/')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const hits = lines
      .map((line, i) => [line, i + 1] as const)
      .filter(([line]) => RAW_READ.test(line) && !/^\s*(\/\/|\*)/.test(line))
      .map(([line, n]) => `${n}: ${line.trim()}`);
    if (hits.length > 0) readers.set(rel, hits);
  }

  test('every raw read of a content table is in an allowlisted file', () => {
    const unlisted = [...readers.entries()].filter(([file]) => !(file in ALLOWLIST)).map(([file, hits]) => `${file}\n  ${hits.join('\n  ')}`);
    expect(unlisted, 'add notInSharedWorkspace and list the file, or move the read to a repository').toEqual([]);
  });

  test('the allowlist has no stale entry', () => {
    expect(Object.keys(ALLOWLIST).filter((f) => !readers.has(f))).toEqual([]);
  });

  test('every personal raw reader carries the personal predicate', () => {
    for (const [file, why] of Object.entries(ALLOWLIST)) {
      if (why !== 'personal reader') continue;
      expect(readFileSync(join(root, file), 'utf8'), file).toMatch(/notInSharedWorkspace\(/);
    }
  });
});

// ── Data: every content table, through every personal path ──────────────

const alice = randomUUID();
const bob = randomUUID();
const admin = randomUUID();
let spaceId: string;
const ids: Record<string, string> = {};
let spaceTaskId: string;

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

async function principal(userId: string, header: string | null, isAdmin = false): Promise<Principal> {
  const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  return resolvedPrincipal(userId, header, { isAdmin });
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-isolation-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'i-alice' }, { id: bob, username: 'i-bob' }, { id: admin, username: 'i-admin', isAdmin: true }]);
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(bob, [[alice, 'editor']]);

  // Alice authors one row of every content table in the space.
  const ws = spaceId;
  const [session] = await q(`INSERT INTO sessions (user_id, channel_type, channel_id, title, workspace_id) VALUES ($1, 'webchat', $2, 'spacesecret chat', $3) RETURNING id`, [alice, `c-${rand(4)}`, ws]);
  ids.sessions = session.id;
  const one = async (table: string, sql: string, params: unknown[]) => {
    const [row] = await q(sql, params);
    ids[table] = String(row.id);
  };
  await one('messages', `INSERT INTO messages (session_id, role, content) VALUES ($1, 'user', 'spacesecret message') RETURNING id`, [session.id]);
  await one('agents', `INSERT INTO agents (id, session_id, user_id, workspace_id, role) VALUES ($1, $2, $3, $4, 'research') RETURNING id`, [`agent-${randomUUID()}`, session.id, alice, ws]);
  await one('documents', `INSERT INTO documents (user_id, filename, original_name, mime_type, size, storage_path, workspace_id) VALUES ($1, 'f', 'spacesecret.txt', 'text/plain', 1, '/x', $2) RETURNING id`, [alice, ws]);
  await one('embeddings', `INSERT INTO embeddings (source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, workspace_id) VALUES ($1, 'spacesecret knowledge', 'm', '[0.1,0.2,0.3]', 'note', $2, 'm/3', $3, $4) RETURNING id`, [`note:${randomUUID()}`, randomUUID(), alice, ws]);
  await one('memories', `INSERT INTO memories (user_id, fact_type, content, embedding, embedding_version, workspace_id) VALUES ($1, 'fact', 'spacesecret memory', '[0.1,0.2,0.3]', 'm/3', $2) RETURNING id`, [alice, ws]);
  await one('notes', `INSERT INTO notes (user_id, slug, title, body_sha256, workspace_id) VALUES ($1, 'spacesecret', 'spacesecret note', 'sha', $2) RETURNING id`, [alice, ws]);
  await one('knowledge_links', `INSERT INTO knowledge_links (user_id, from_type, from_id, to_type, to_id, to_ref, link_type, origin, workspace_id) VALUES ($1, 'note', $2::uuid, 'note', $2::uuid, 'spacesecret', 'references', 'wikilink', $3) RETURNING id`, [alice, ids.notes, ws]);
  await one('pipelines', `INSERT INTO pipelines (root_agent_id, session_id, user_id, title, type, workspace_id) VALUES ('a1', $1, $2, 'spacesecret pipeline', 'plan', $3) RETURNING id`, [session.id, alice, ws]);
  await one('notifications', `INSERT INTO notifications (user_id, type, title, workspace_id) VALUES ($1, 'task_unblocked', 'spacesecret notification', $2) RETURNING id`, [alice, ws]);
  await one('tasks', `INSERT INTO tasks (user_id, title, workspace_id, assignee_kind, assignee_ref, source, source_ref, status) VALUES ($1, 'spacesecret task', $2, 'role', 'research', 'channel', $3::jsonb, 'open') RETURNING id`, [alice, ws, JSON.stringify({ sessionId: session.id })]);
  spaceTaskId = ids.tasks;
  await one('task_comments', `INSERT INTO task_comments (task_id, user_id, author_kind, author_ref, body) VALUES ($1, $2::uuid, 'user', $2::text, 'spacesecret comment') RETURNING id`, [spaceTaskId, alice]);
  await one('artifacts', `INSERT INTO artifacts (slug, workspace_id, created_by_user_id, title, type) VALUES ('spacesecret', $1, $2, 'spacesecret artifact', 'html') RETURNING id`, [ws, alice]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/** Every value reachable in `rows` (ids, nested ids), as strings. */
function idsIn(rows: unknown): string[] {
  return JSON.stringify(rows ?? null).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agent-[0-9a-f-]{36}/g) ?? [];
}

function expectNoSpaceRow(rows: unknown, what: string): void {
  const seen = new Set(idsIn(rows));
  const leaked = Object.entries(ids).filter(([, id]) => seen.has(id)).map(([t]) => t);
  expect(leaked, what).toEqual([]);
}

describe('personal repositories (I2)', () => {
  test('the author reaches none of the space rows through scopedRepos, with or without a workspace', async () => {
    const { scopedRepos } = await import('./scoped');
    const withWs = await principal(alice, null);
    const { workspaceId: _ws, workspaceKind: _k, ...noWs } = withWs;
    void _ws; void _k;
    for (const p of [withWs, noWs as Principal]) {
      const r = scopedRepos(p);
      expectNoSpaceRow(await r.sessions.listOwn(), 'sessions.listOwn');
      expect(await r.sessions.findById(ids.sessions)).toBeNull();
      expectNoSpaceRow(await r.messages.findBySession(ids.sessions), 'messages.findBySession');
      expectNoSpaceRow(await r.agents.listOwn(), 'agents.listOwn');
      expect(await r.agents.findById(ids.agents)).toBeNull();
      expectNoSpaceRow(await r.documents.listOwn(), 'documents.listOwn');
      expect(await r.documents.findById(ids.documents)).toBeNull();
      expectNoSpaceRow(await r.notifications.list(), 'notifications.list');
      expect(await r.notifications.markRead(ids.notifications)).toBe(false);
      expectNoSpaceRow(await r.tasks.listOwn(), 'tasks.listOwn');
      expectNoSpaceRow(await r.tasks.createdSince(new Date(0)), 'tasks.createdSince');
      expect(await r.tasks.findById(spaceTaskId)).toBeNull();
      expect(await r.tasks.listComments(spaceTaskId)).toBeNull();
      expect(await r.tasks.update(spaceTaskId, { title: 'hijacked' })).toBeNull();
      expect(await r.pipelines.findById(ids.pipelines)).toBeNull();
    }
  });

  test('admin bypasses never reach a space: by-id session and message reads, listAllAdmin', async () => {
    const { scopedRepos } = await import('./scoped');
    const r = scopedRepos(await principal(admin, null, true));
    expect(await r.sessions.findById(ids.sessions)).toBeNull();
    expect(await r.messages.findBySession(ids.sessions)).toEqual([]);
    expectNoSpaceRow(await r.sessions.listAllAdmin(500), 'sessions.listAllAdmin');
    expect(await r.agents.findById(ids.agents)).toBeNull();
    expect(await r.documents.findById(ids.documents)).toBeNull();
    expect(await r.tasks.findById(spaceTaskId)).toBeNull();
    expect(await r.pipelines.findById(ids.pipelines)).toBeNull();
  });

  test('a space principal at the personal door is a wiring error, not a read', async () => {
    const { scopedRepos } = await import('./scoped');
    expect(() => scopedRepos({ ...({} as Principal), kind: 'user', userId: alice, username: 'a', isAdmin: false, workspaceId: spaceId, workspaceKind: 'shared', spaceRole: 'editor' })).toThrow(/contentRepos/);
  });

  test('singleton note and link repositories with a user id exclude the space', async () => {
    const { getNoteRepository } = await import('./note-repository');
    const { getKnowledgeLinkRepository } = await import('./knowledge-link-repository');
    const notes = getNoteRepository();
    expectNoSpaceRow(await notes.list(alice, { limit: 500 }), 'notes.list');
    expect(await notes.getById(alice, ids.notes)).toBeNull();
    expect(await notes.getBySlug(alice, null, 'spacesecret')).toBeNull();
    expectNoSpaceRow(await notes.listIndex(alice), 'notes.listIndex');
    expect(await notes.archive(alice, ids.notes)).toBe(false);
    const links = getKnowledgeLinkRepository();
    expectNoSpaceRow(await links.getOutgoing(alice, 'note', ids.notes), 'links.getOutgoing');
    expectNoSpaceRow(await links.getBacklinks(alice, 'note', ids.notes), 'links.getBacklinks');
    expectNoSpaceRow(await links.getBacklinksByRef(alice, 'spacesecret'), 'links.getBacklinksByRef');
    expectNoSpaceRow(await links.outgoingForIds(alice, 'note', [ids.notes]), 'links.outgoingForIds');
    expect(await links.resolveTo({ scope: alice, toRef: 'spacesecret', toType: 'note', toId: randomUUID() })).toBe(0);
  });

  test('the §1.2 raw readers exclude the space', async () => {
    const { listRoleAgents } = await import('@/core/tasks/role-agents');
    const roles = await listRoleAgents(alice);
    expect(JSON.stringify(roles)).not.toMatch(/"research".*"total":[1-9]/);
    const { probeRoleWork } = await import('@/core/heartbeat');
    expectNoSpaceRow(await probeRoleWork(alice, 'research'), 'probeRoleWork');
    const { markRoleHeartbeatDue } = await import('@/core/heartbeat');
    expect(await markRoleHeartbeatDue(alice, spaceTaskId)).toEqual([]);
    const { openTakenTasks } = await import('@/core/channels/taken-tasks');
    expectNoSpaceRow(await openTakenTasks(alice, ids.sessions), 'openTakenTasks');
    const { assembleReviewContext } = await import('@/core/knowledge/weekly-review');
    const review = await assembleReviewContext(alice);
    expect(JSON.stringify(review)).not.toContain('spacesecret');
    const { defaultResolveTitles } = await import('@/core/tasks/wakeup-bridge');
    expect((await defaultResolveTitles([{ taskId: spaceTaskId, userId: alice, workspaceId: null }])).size).toBe(0);
  });

  test('knowledge search: the personal scope never returns space chunks; the space scope does', async () => {
    const { EmbeddingService } = await import('@/core/rag/embeddings');
    const { principalKnowledgeScope } = await import('@/core/rag/knowledge-scope');
    const svc = new EmbeddingService('test-model');
    const personal = principalKnowledgeScope(await principal(alice, null));
    expect(await svc.ftsSearch(personal, 'spacesecret', 10)).toEqual([]);
    expect(await svc.ftsSearch({ kind: 'personal', userId: alice, workspaceId: null }, 'spacesecret', 10)).toEqual([]);
    expect((await svc.listAll(personal, 100)).entries.map((e) => e.id)).not.toContain(ids.embeddings);
    const inSpace = principalKnowledgeScope(await principal(alice, spaceId));
    expect(inSpace).toEqual({ kind: 'space', workspaceId: spaceId });
    expect((await svc.ftsSearch(inSpace, 'spacesecret', 10)).map((r) => r.id)).toEqual([ids.embeddings]);
  });

  test('the space door reaches the same rows, by the member’s role', async () => {
    const { contentRepos } = await import('./content');
    const r = contentRepos(await principal(bob, spaceId));
    expect(r.kind).toBe('space');
    // Shared rows: every member's.
    expect((await r.tasks.findById(spaceTaskId))?.id).toBe(spaceTaskId);
    expect((await r.documents.findById(ids.documents))?.id).toBe(ids.documents);
    expect((await r.notes.getById(ids.notes))?.id).toBe(ids.notes);
    expect((await r.artifacts.findById(ids.artifacts))?.id).toBe(ids.artifacts);
    expect((await r.tasks.listComments(spaceTaskId))?.comments.map((c) => c.id)).toEqual([ids.task_comments]);
    // Private rows: Alice's chat, agents, pipelines and inbox are hers even in the space.
    expect(await r.sessions.findById(ids.sessions)).toBeNull();
    expect(await r.agents.findById(ids.agents)).toBeNull();
    expect(await r.pipelines.findById(ids.pipelines)).toBeNull();
    expect(await r.notifications.list()).toEqual([]);
    const asAlice = contentRepos(await principal(alice, spaceId));
    expect((await asAlice.sessions.findById(ids.sessions))?.id).toBe(ids.sessions);
    expect((await asAlice.messages.findBySession(ids.sessions)).map((m) => m.id)).toEqual([ids.messages]);
    expect((await asAlice.notifications.list()).map((n) => n.id)).toEqual([ids.notifications]);
  });
});

describe('global search and the REST raw readers (I2)', () => {
  test('search, graph and memory routes return nothing of the space', async () => {
    const { getSessionManager } = await import('@/security/auth/session');
    const token = (await getSessionManager().create(alice)).token;
    const { createServer } = await import('@/api/server');
    const app = createServer();
    const get = async (path: string) => {
      const res = await app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status, path).toBe(200);
      return res.json();
    };
    expect(JSON.stringify(await get('/api/search?q=spacesecret'))).not.toContain('spacesecret');
    expectNoSpaceRow(await get('/api/graph'), 'graph');
    expect(JSON.stringify(await get('/api/memory'))).not.toContain('spacesecret');
    // A space header on a personal route still runs personal.
    const res = await app.handle(new Request('http://localhost/api/search?q=spacesecret', { headers: { authorization: `Bearer ${token}`, 'x-octipus-workspace': spaceId } }));
    expect(JSON.stringify(await res.json())).not.toContain('spacesecret');
  }, 60_000);
});
