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
import { WORKSPACE_TABLES } from '@/db/workspace-tables';
import type { Principal } from '@/security/principal';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

// ── Grep-driven raw readers ─────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..', '..');

/**
 * The content tables: every table with a `workspace_id` (WORKSPACE_TABLES,
 * kept complete by its own test against the live schema), plus the content
 * tables keyed through another one (messages by session, task comments by
 * task).
 */
const CONTENT_TABLES = [...new Set([...WORKSPACE_TABLES.map((t) => t.table), 'messages', 'task_comments'])];

/** Drizzle export name → table name, read from the schema files. */
function schemaSymbols(): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(ROOT, 'src', 'db', 'schema');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const m of text.matchAll(/export const (\w+) = pgTable\(\s*['"](\w+)['"]/g)) out.set(m[1], m[2]);
  }
  return out;
}

const SYMBOL_TABLE = schemaSymbols();
const CONTENT_SYMBOLS = [...SYMBOL_TABLE].filter(([, table]) => CONTENT_TABLES.includes(table)).map(([symbol]) => symbol);

/**
 * The names a file reads content tables by: the schema exports, their
 * aliases (`import { sessions as sessionRows }`), and drizzle `alias(tasks,
 * …)` bindings.
 */
function contentNamesIn(text: string): string[] {
  const names = new Set(CONTENT_SYMBOLS);
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*schema[^'"]*['"]/g)) {
    for (const part of m[1].split(',')) {
      const alias = /^\s*(?:type\s+)?(\w+)\s+as\s+(\w+)\s*$/.exec(part);
      if (alias && names.has(alias[1])) names.add(alias[2]);
    }
  }
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*alias\(\s*(\w+)\s*,/g)) {
    if (names.has(m[2])) names.add(m[1]);
  }
  return [...names];
}

function rawReadPattern(names: string[]): RegExp {
  const symbols = names.join('|');
  return new RegExp(
    [
      // Drizzle: .from(tasks), .innerJoin(sessionRows, …)
      `(?<!Array)\\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\\(\\s*(?:${symbols})\\b`,
      // Raw SQL, the keyword in any case: FROM tasks, join  notes, from ${sessions}.
      // Table names are lowercase identifiers followed by an alias, a clause
      // or the end of the line — prose ("from hooks, cron", "from AGENTS.md")
      // is not a read.
      `\\b[Ff][Rr][Oo][Mm]\\s+(?:(?:${CONTENT_TABLES.join('|')})(?=\\s|$|\\)|\`)|\\$\\{\\s*(?:${symbols})\\s*\\})`,
      `\\b[Jj][Oo][Ii][Nn]\\s+(?:(?:${CONTENT_TABLES.join('|')})(?=\\s|$|\\)|\`)|\\$\\{\\s*(?:${symbols})\\s*\\})`,
    ].join('|'),
  );
}

/**
 * Files that read content tables directly, and why. `access layer` files
 * are the doors themselves. Files in `MARKED` (the unscoped stores: a
 * blanket entry for one of them hid admins listing every space agent) must
 * also carry an `i2:` comment on each read — on its line or within the three
 * lines above — saying why that read cannot hand a space's rows to a
 * personal caller. "personal reader" files must use `notInSharedWorkspace`
 * (§1.2).
 */
const ACCESS_LAYER = 'access layer';
const PERSONAL_READER = 'personal reader';
const ALLOWLIST: Record<string, string> = {
  // The access layer itself.
  'src/db/repositories/scoped.ts': ACCESS_LAYER,
  'src/db/repositories/space.ts': ACCESS_LAYER,
  'src/db/repositories/note-repository.ts': ACCESS_LAYER,
  'src/db/repositories/knowledge-link-repository.ts': ACCESS_LAYER,
  'src/core/rag/embeddings.ts': ACCESS_LAYER,
  'src/core/rag/retention-service.ts': ACCESS_LAYER,
  'src/core/memory/repository.ts': ACCESS_LAYER,
  'src/core/spaces/service.ts': ACCESS_LAYER,
  'src/core/spaces/invites.ts': ACCESS_LAYER,
  'src/core/spaces/membership.ts': ACCESS_LAYER,
  'src/core/spaces/purge.ts': ACCESS_LAYER,
  'src/db/repositories/live-documents.ts': ACCESS_LAYER,
  // Rooms (S2): every read follows `roomAccess` / the membership read.
  'src/core/rooms/access.ts': ACCESS_LAYER,
  'src/core/rooms/service.ts': ACCESS_LAYER,
  'src/core/rooms/membership.ts': 'pending requests of one room, for an access change',
  'src/core/spaces/memory.ts': ACCESS_LAYER,
  // S5: the listen gate reads rooms in listen mode and their recent posts for
  // no caller; room settings and feedback follow `requireRoom`.
  'src/core/rooms/listen.ts': ACCESS_LAYER,
  // S5 "My work": tasks assigned to the caller, in spaces joined through
  // their membership in the same query, and their own personal workspaces.
  'src/core/tasks/team.ts': 'my tasks across my memberships, by assignee',
  'src/db/repositories/session-kind.ts': 'the kind of one session by id (no content)',
  'src/security/workspace-resolver.ts': 'workspace of a session/agent/pipeline the caller owns, by id',
  // Unscoped stores keyed by an id the caller already holds (MARKED: per read).
  'src/db/repositories/session-repository.ts': 'system-side session store',
  'src/db/repositories/message-repository.ts': 'system-side message store',
  'src/db/repositories/agent-repository.ts': 'system-side agent store',
  'src/db/repositories/agent-event-repository.ts': 'agent event stream, by agent id',
  'src/db/repositories/document-repository.ts': 'document processor store',
  'src/db/repositories/artifacts-repository.ts': 'artifact rows by id or workspace id',
  'src/db/repositories/pipeline-repository.ts': 'pipeline run state',
  'src/db/repositories/task-state-repository.ts': 'session task state',
  'src/db/repositories/background-job-repository.ts': 'background job queue',
  // Other system readers.
  'src/db/repositories/work-plan-repository.ts': "a session's plan, keyed by session id and owner",
  'src/db/repositories/trajectory-repository.ts': 'trajectory runs, by run id (personal lists go through ScopedTrajectoryRepo)',
  'src/db/repositories/repo-registry-repository.ts': "a user's repository registry (workspace_repos), never a space's",
  'src/db/repositories/audit-repository.ts': 'audit log (kept history; space activity reads go through the space service)',
  'src/core/agent/pipeline-manager.ts': 'pipeline run state by id; the personal list route drops space rows (withoutSpaceRows)',
  'src/core/agent-manager.ts': 'swarm run state, keyed by run',
  'src/core/swarm/node-repository.ts': 'swarm run state, keyed by run',
  'src/core/invariants.ts': 'system invariant checks',
  'src/core/artifacts/cleanup.ts': 'system cleanup job',
  'src/core/learning/evidence.ts': "a session's own messages and events, keyed by session id",
  'src/core/learning/queue.ts': "a session's learning jobs and events, keyed by session id",
  'src/api/routes/sessions.ts': "a session's learning jobs, after the scoped session lookup",
  'src/core/notification-service.ts': "a user's own inbox (every notification of a user is theirs)",
  'src/security/orgs.ts': 'workspace transfer/delete, by workspace id',
  'src/security/permissions.ts': "a workspace's permission requests, by workspace id",
  'src/security/quotas.ts': 'counts for quota enforcement',
  'src/security/user-deletion.ts': 'spaces a user authored content in, by user id (ids and names only)',
  // Billing history (cost_log is a keep table): a user's own spend.
  'src/security/spend-budgets.ts': 'cost attribution joins',
  'src/models/cost-tracker.ts': "a user's own spend",
  'src/api/routes/runs.ts': "a run's cost, after the scoped run lookup",
  'src/api/routes/orgs.ts': 'org spend, admin billing',
  // The vault: a user's secrets; workspace-scoped secrets follow transfer.
  'src/security/vault.ts': 'secret store',
  'src/security/oauth.ts': "a user's OAuth tokens in the secret store",
  // Group channels (enrolments, not content): a bound one names its space (§9.4).
  'src/channels/group-channels.ts': "channel enrolments; a binding grants nothing to the channel's owner",
  'src/channels/group-bridge.ts': 'the bridge: bindings checked against the space membership',
  // Hooks are personal automation: never offered in space sessions (§5.6).
  'src/hooks/manager.ts': 'hooks, personal automation',
  'src/hooks/actions.ts': 'hooks, personal automation',
  'src/api/routes/hooks.ts': 'hooks, personal automation',
  'src/api/routes/webhook-incoming.ts': 'hooks, personal automation',
  'src/core/cron-runner.ts': 'hooks, personal automation',
  'src/core/briefing.ts': 'hooks, personal automation',
  // §1.2 personal raw readers: each carries notInSharedWorkspace.
  'src/api/routes/graph.ts': PERSONAL_READER,
  'src/api/routes/memory.ts': PERSONAL_READER,
  'src/api/routes/search.ts': PERSONAL_READER,
  'src/core/heartbeat.ts': PERSONAL_READER,
  'src/core/tasks/role-agents.ts': PERSONAL_READER,
  'src/core/tasks/wakeup-bridge.ts': PERSONAL_READER,
  'src/core/channels/taken-tasks.ts': PERSONAL_READER,
  'src/core/knowledge/weekly-review.ts': PERSONAL_READER,
};

/** Unscoped stores whose every read must carry an `i2:` marker. */
const MARKED = new Set([
  'src/db/repositories/session-repository.ts',
  'src/db/repositories/message-repository.ts',
  'src/db/repositories/agent-repository.ts',
  'src/db/repositories/agent-event-repository.ts',
  'src/db/repositories/document-repository.ts',
  'src/db/repositories/artifacts-repository.ts',
  'src/db/repositories/pipeline-repository.ts',
  'src/db/repositories/task-state-repository.ts',
  'src/db/repositories/background-job-repository.ts',
]);

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
  /** File → hits, each with whether an `i2:` marker covers it. */
  const readers = new Map<string, Array<{ hit: string; marked: boolean }>>();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel.startsWith('src/db/schema/') || rel.startsWith('src/db/migrations/')) continue;
    const text = readFileSync(file, 'utf8');
    const pattern = rawReadPattern(contentNamesIn(text));
    const lines = text.split('\n');
    const hits = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => pattern.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map(({ line, i }) => ({
        hit: `${i + 1}: ${line.trim()}`,
        marked: lines.slice(Math.max(0, i - 3), i + 1).some((l) => /\bi2:\s*\S/.test(l)),
      }));
    if (hits.length > 0) readers.set(rel, hits);
  }

  test('the grep sees the tables of WORKSPACE_TABLES and aliased imports', () => {
    for (const table of ['hooks', 'background_jobs', 'trajectory_runs', 'task_state', 'swarm_nodes', 'agent_events', 'vault', 'sessions']) {
      expect(CONTENT_TABLES, table).toContain(table);
    }
    const pattern = rawReadPattern(contentNamesIn(`import { sessions as sessionRows } from '@/db/schema/sessions';`));
    expect(pattern.test('db.select().from(sessionRows)')).toBe(true);
    expect(pattern.test('select id from tasks where x')).toBe(true);
    expect(pattern.test('LEFT JOIN background_jobs j ON')).toBe(true);
    expect(pattern.test('FROM ${hooks} h')).toBe(true);
    expect(pattern.test('join notes n on n.id = x')).toBe(true);
    expect(pattern.test('Array.from(tasks)')).toBe(false);
    expect(pattern.test("'Imported notes from vault'")).toBe(false);
    expect(pattern.test('split from Agents so they')).toBe(false);
    expect(pattern.test('(never from hooks, cron or heartbeat runs)')).toBe(false);
  });

  test('every raw read of a content table is in an allowlisted file', () => {
    const unlisted = [...readers.entries()].filter(([file]) => !(file in ALLOWLIST)).map(([file, hits]) => `${file}\n  ${hits.map((h) => h.hit).join('\n  ')}`);
    expect(unlisted, 'add notInSharedWorkspace and list the file, or move the read to a repository').toEqual([]);
  });

  test('every read of an unscoped store carries an i2: marker', () => {
    const unmarked = [...readers.entries()]
      .filter(([file]) => MARKED.has(file))
      .flatMap(([file, hits]) => hits.filter((h) => !h.marked).map((h) => `${file}:${h.hit}`));
    expect(unmarked, 'say on the read (`// i2: …`) why it cannot return a space row to a personal caller').toEqual([]);
  });

  test('the allowlist has no stale entry', () => {
    expect(Object.keys(ALLOWLIST).filter((f) => !readers.has(f))).toEqual([]);
  });

  test('every personal raw reader carries the personal predicate', () => {
    for (const [file, why] of Object.entries(ALLOWLIST)) {
      if (why !== PERSONAL_READER) continue;
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(/notInSharedWorkspace\(/);
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

describe('admin bypasses on agents (I2, review finding 2)', () => {
  test('an admin who is not a member sees no space agent: history list, live list, live by-id, live events, stop', async () => {
    const { getSessionManager } = await import('@/security/auth/session');
    const { createServer } = await import('@/api/server');
    const { getAgentManager } = await import('@/core/agent-manager');
    const app = createServer();
    const adminToken = (await getSessionManager().create(admin)).token;
    const aliceToken = (await getSessionManager().create(alice)).token;
    const { resolveAgentScope } = await import('@/core/agent/context');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const scope = await resolveAgentScope({ session: await sessionRepository.findById(ids.sessions), userId: alice, trigger: 'user' });
    const live = await getAgentManager().spawn({ sessionId: ids.sessions, userId: alice, ...scope, topic: 'general', model: 'test-model', role: 'general' });
    const liveId = live.getContext().id;
    const call = async (token: string, method: string, path: string, header?: string) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (header) headers['x-octipus-workspace'] = header;
      return app.handle(new Request(`http://localhost${path}`, { method, headers }));
    };
    try {
      const list = await (await call(adminToken, 'GET', '/api/agents?limit=200')).json();
      expect(list.agents.map((a: { id: string }) => a.id)).not.toContain(ids.agents);
      expect(list.agents.map((a: { id: string }) => a.id)).not.toContain(liveId);
      expect(await (await call(adminToken, 'GET', `/api/agents/${liveId}`)).json()).toEqual({ error: 'Agent not found' });
      expect(await (await call(adminToken, 'GET', `/api/agents/${liveId}/events`)).json()).toEqual({ error: 'Agent not found' });
      expect(await (await call(adminToken, 'GET', `/api/agents/${ids.agents}`)).json()).toEqual({ error: 'Agent not found' });
      expect(await (await call(adminToken, 'POST', `/api/agents/${liveId}/stop`)).json()).toEqual({ error: 'Agent not found' });
      expect(live.getStatus()).not.toBe('stopped');
      // Its owner, a member, reaches it from the space.
      const own = await (await call(aliceToken, 'GET', `/api/agents/${liveId}`, spaceId)).json();
      expect(own.id).toBe(liveId);
    } finally {
      getAgentManager().remove(liveId);
    }
  }, 60_000);
});

describe('the personal door never writes into a space (D3, review finding 6)', () => {
  test('personal-scope creates handed a space id are refused, through every store', async () => {
    const { scopedRepos } = await import('./scoped');
    const { contentRepos } = await import('./content');
    const { agentPrincipal } = await import('@/security/principal');
    const { personalNoteScope, PersonalNoteRepo } = await import('./note-repository');
    // What an agent context inside the space hands the personal door today.
    const inSpace = agentPrincipal({ userId: alice, workspaceId: spaceId });
    const r = scopedRepos(inSpace);
    await expect(r.tasks.create({ title: 'smuggled', source: 'user' })).rejects.toThrow(/shared workspace/);
    await expect(r.sessions.create({ channelType: 'api', channelId: `x-${rand(3)}` })).rejects.toThrow(/shared workspace/);
    await expect(r.agents.create({ id: `agent-${randomUUID()}`, sessionId: ids.sessions, role: 'general' })).rejects.toThrow(/shared workspace/);
    await expect(r.documents.create({ filename: 'f', originalName: 'f', mimeType: 'text/plain', size: 1, storagePath: '/x' })).rejects.toThrow(/shared workspace/);
    // A caller's explicit workspace id is refused the same way.
    const personal = scopedRepos(await principal(alice, null));
    await expect(personal.sessions.create({ channelType: 'api', channelId: `y-${rand(3)}`, workspaceId: spaceId })).rejects.toThrow(/shared workspace/);
    await expect(personal.documents.create({ filename: 'f', originalName: 'f', mimeType: 'text/plain', size: 1, storagePath: '/x', workspaceId: spaceId })).rejects.toThrow(/shared workspace/);
    // Notes: the scope itself refuses a known space; the write refuses any.
    expect(() => personalNoteScope(alice, spaceId)).toThrow(/shared workspace/);
    const unchecked = new PersonalNoteRepo({ kind: 'personal', userId: alice, workspaceId: spaceId });
    await expect(unchecked.create({ slug: `s-${rand(3)}`, title: 't', bodySha256: 'x' })).rejects.toThrow(/shared workspace/);
    // Artifacts: refused before any read or write.
    await expect(contentRepos(inSpace).artifacts.list()).rejects.toThrow(/shared workspace/);
    await expect(contentRepos(inSpace).artifacts.create({ slug: `s-${rand(3)}`, title: 't', type: 'html' })).rejects.toThrow(/shared workspace/);
    const [count] = await q(`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = $1 AND title = 'smuggled'`, [spaceId]);
    expect(count.n).toBe(0);
  });

  test('the personal predicate is positive: a row naming no live workspace is nobody’s personal row (review finding 8)', async () => {
    const { getDb } = await import('@/db/postgres');
    const { sql } = await import('drizzle-orm');
    const { notInSharedWorkspace } = await import('./scoped');
    const [personalWs] = await q(`SELECT id FROM workspaces WHERE user_id = $1 AND kind = 'personal' LIMIT 1`, [alice]);
    const personalOf = async (id: string | null) => {
      const result = await getDb().execute(sql`SELECT ${notInSharedWorkspace(id === null ? sql`NULL::uuid` : sql`${id}::uuid`)} AS personal`);
      const rows = (Array.isArray(result) ? result : (result as { rows: Array<{ personal: boolean }> }).rows) as Array<{ personal: boolean }>;
      return rows[0].personal;
    };
    expect(await personalOf(null)).toBe(true);
    expect(await personalOf(personalWs.id)).toBe(true);
    expect(await personalOf(spaceId)).toBe(false);
    expect(await personalOf(randomUUID())).toBe(false);
  });
});

describe('artifact reach through the gateway and public pages (review findings 15, 17)', () => {
  test('a member subscribes to a space artifact; a non-member admin does not; private stays its creator’s', async () => {
    const { canSubscribeToResource } = await import('@/core/gateway/resource-access');
    const ctx = (userId: string) => ({ userId, resources: new Set<string>() }) as unknown as import('@/core/gateway/protocol').ConnectionContext;
    expect(await canSubscribeToResource(ctx(bob), `artifact:${ids.artifacts}`)).toBe(true);
    expect(await canSubscribeToResource(ctx(alice), `artifact:${ids.artifacts}`)).toBe(true);
    expect(await canSubscribeToResource(ctx(admin), `artifact:${ids.artifacts}`)).toBe(false);
    const [priv] = await q(`INSERT INTO artifacts (slug, workspace_id, created_by_user_id, title, type, visibility) VALUES ($1, $2, $3, 'p', 'html', 'private') RETURNING id`, [`priv-${rand(3)}`, spaceId, alice]);
    expect(await canSubscribeToResource(ctx(alice), `artifact:${priv.id}`)).toBe(true);
    expect(await canSubscribeToResource(ctx(bob), `artifact:${priv.id}`)).toBe(false);
  });

  test('a page slug prefers the viewer’s personal artifact, and guests get no space page', async () => {
    const { findViewableArtifactBySlug } = await import('./space');
    const slug = `shared-${rand(3)}`;
    const [inSpace] = await q(`INSERT INTO artifacts (slug, workspace_id, created_by_user_id, title, type, updated_at) VALUES ($1, $2, $3, 's', 'html', now() + interval '1 hour') RETURNING id`, [slug, spaceId, bob]);
    expect((await findViewableArtifactBySlug(alice, slug))?.id).toBe(inSpace.id);
    const [personalWs] = await q(`SELECT id FROM workspaces WHERE user_id = $1 AND kind = 'personal' LIMIT 1`, [alice]);
    const [mine] = await q(`INSERT INTO artifacts (slug, workspace_id, created_by_user_id, title, type) VALUES ($1, $2, $3, 'p', 'html') RETURNING id`, [slug, personalWs.id, alice]);
    // The space's row is newer, the personal one still wins.
    expect((await findViewableArtifactBySlug(alice, slug))?.id).toBe(mine.id);
    // A guest of the space sees no space page.
    const guest = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: guest, username: `i-guest-${rand(3)}` }]);
    await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'guest')`, [spaceId, guest]);
    expect(await findViewableArtifactBySlug(guest, slug)).toBeNull();
    await q(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [spaceId, guest]);
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
