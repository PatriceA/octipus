/**
 * Space purge (docs/plans/coworking-spec.md §5.8, D15, I9).
 *
 *   - Purge leaves no row with the space's id in any `delete` table of
 *     WORKSPACE_TABLES, nor any row keyed by the space's sessions; the `keep`
 *     tables (audit, cost, cleanup history) keep theirs.
 *   - Only an owner, only after `spaces.purgeAfterArchiveDays` of archive.
 *   - The space's directories are removed; the sweep removes leftovers.
 *   - A personal workspace delete still sets NULL, and never deletes a space.
 *   - `assertDeletable` refuses the last owner of a space.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const owner = randomUUID();
const editor = randomUUID();

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-purge-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { getConfig } = await import('@/config');
  const files = mkdtempSync(join(tmpdir(), 'octipus-purge-files-'));
  getConfig().workspace.rootPath = join(files, 'root');
  getConfig().workspace.documentsPath = join(files, 'documents');
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: owner, username: 'owner' }, { id: editor, username: 'editor' }]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/** An archived space with an editor, archived `daysAgo` days ago. */
async function archivedSpace(daysAgo: number): Promise<string> {
  const { createSpace, archiveSpace } = await import('./service');
  const { createInvite, acceptInvite } = await import('./invites');
  const space = await createSpace({ userId: owner }, { name: `Space ${rand(3)}` });
  const invite = await createInvite({ userId: owner }, space.id, { role: 'editor' });
  await acceptInvite({ userId: editor }, invite.token);
  await archiveSpace({ userId: owner }, space.id);
  await q(`UPDATE workspaces SET archived_at = now() - make_interval(days => $2) WHERE id = $1`, [space.id, daysAgo]);
  return space.id;
}

/**
 * One row with the space's id in every `delete` table (keyed by table, so a
 * new `delete` table without a fixture fails the test), rows keyed by the
 * space's session only, and history rows in the `keep` tables.
 */
async function seedSpaceRows(ws: string, author: string): Promise<{ sessionId: string; tables: string[] }> {
  const seeded = new Set<string>();
  const one = async (table: string, sql: string, params: unknown[]) => {
    await q(sql, params);
    seeded.add(table);
  };
  const [session] = await q(
    `INSERT INTO sessions (user_id, channel_type, channel_id, workspace_id) VALUES ($1, 'web', $2, $3) RETURNING id`,
    [author, `chan-${randomUUID()}`, ws],
  );
  seeded.add('sessions');
  await q(`INSERT INTO messages (session_id, role, content) VALUES ($1, 'user', 'hi')`, [session.id]);
  await one('agent_events', `INSERT INTO agent_events (agent_id, session_id, type, user_id, workspace_id) VALUES ('a1', $1, 'started', $2, $3)`, [session.id, author, ws]);
  await one('agents', `INSERT INTO agents (id, session_id, user_id, workspace_id) VALUES ($1, $2, $3, $4)`, [`agent-${randomUUID()}`, session.id, author, ws]);
  await one('artifacts', `INSERT INTO artifacts (workspace_id, slug, title, type, created_by_user_id) VALUES ($1, $2, 'A', 'html', $3)`, [ws, `a-${rand(3)}`, author]);
  await one('background_jobs', `INSERT INTO background_jobs (kind, user_id, title, workspace_id) VALUES ('research', $1, 'job', $2)`, [author, ws]);
  await one('documents', `INSERT INTO documents (user_id, filename, original_name, mime_type, size, storage_path, workspace_id) VALUES ($1, 'f', 'f', 'text/plain', 1, '/x', $2)`, [author, ws]);
  await one('embeddings', `INSERT INTO embeddings (source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, workspace_id) VALUES ('s', 'c', 'm', '[0.1,0.2,0.3]', 'document', $1, 'm/3', $2, $3)`, [randomUUID(), author, ws]);
  await one('hooks', `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, workspace_id) VALUES ($1, 'h', 'message_received', '{}', 'notify', '{}', $2)`, [author, ws]);
  await one('knowledge_links', `INSERT INTO knowledge_links (user_id, from_type, from_id, to_ref, link_type, origin, workspace_id) VALUES ($1, 'note', $2, 'x', 'references', 'wikilink', $3)`, [author, randomUUID(), ws]);
  await one('memories', `INSERT INTO memories (user_id, fact_type, content, embedding, embedding_version, workspace_id) VALUES ($1, 'fact', 'c', '[0.1,0.2,0.3]', 'm/3', $2)`, [author, ws]);
  await one('notes', `INSERT INTO notes (user_id, slug, title, body_sha256, workspace_id) VALUES ($1, $2, 't', 'sha', $3)`, [author, `n-${randomUUID()}`, ws]);
  await one('notifications', `INSERT INTO notifications (user_id, type, title, workspace_id) VALUES ($1, 'info', 'n', $2)`, [author, ws]);
  await one('permission_requests', `INSERT INTO permission_requests (user_id, agent_id, skill_id, action, context, workspace_id) VALUES ($1, 'a1', 't', 'write', '{"toolName":"t","toolArguments":{}}', $2)`, [author, ws]);
  await one('pipelines', `INSERT INTO pipelines (root_agent_id, session_id, user_id, title, type, workspace_id) VALUES ('a1', $1, $2, 'p', 'plan', $3)`, [session.id, author, ws]);
  await one('swarm_nodes', `INSERT INTO swarm_nodes (id, root_session_id, depth, kind, role, topic_path, model, token_cap, wall_clock_cap_ms, fan_out_cap, brief_hash, user_id, workspace_id) VALUES ($1, $2, 0, 'root', 'general', 't', 'm', 1, 1, 1, 'h', $3, $4)`, [`node-${randomUUID()}`, session.id, author, ws]);
  await one('task_state', `INSERT INTO task_state (session_id, user_id, owner_agent, task_kind, status, workspace_id) VALUES ($1, $2, 'a1', 'k', 'open', $3)`, [session.id, author, ws]);
  await one('tasks', `INSERT INTO tasks (user_id, title, workspace_id) VALUES ($1, 't', $2)`, [author, ws]);
  await one('trajectory_runs', `INSERT INTO trajectory_runs (user_id, root_session_id, outcome, started_at, ended_at, jsonl_path, jsonl_line, workspace_id) VALUES ($1, $2, 'success', now(), now(), '/t.jsonl', 1, $3)`, [author, session.id, ws]);
  await one('workspace_repos', `INSERT INTO workspace_repos (user_id, name, root_path, workspace_id) VALUES ($1, 'r', $2, $3)`, [author, `/repo/${randomUUID()}`, ws]);
  const { getVault } = await import('@/security/vault');
  await getVault().store(author, `ws_token_${rand(3)}`, 'secret', { credentialType: 'api_key', scope: 'workspace', workspaceId: ws });
  seeded.add('vault');
  // Created with the space by `archivedSpace` (owner, editor, the invite).
  seeded.add('workspace_members');
  seeded.add('workspace_invites');

  // Keyed by the session only: no workspace_id of their own (or a wrong one).
  await q(`INSERT INTO agents (id, session_id, user_id) VALUES ($1, $2, $3)`, [`agent-${randomUUID()}`, session.id, author]);
  await q(`INSERT INTO tool_actions (id, user_id, session_id, agent_id, tool_id, tool_name, argument_hash, status) VALUES ($1, $2, $3, 'a1', 't', 't', 'h', 'completed')`, [randomUUID(), author, session.id]);
  await q(`INSERT INTO run_events (run_id, subject_id, event) VALUES ($1, 'n1', 'spawn')`, [session.id]);
  await q(`INSERT INTO agent_approvals (id, user_id, session_id, agent_id, boot_id, summary, question) VALUES ($1, $2, $3, 'a1', 'b', 's', 'q')`, [randomUUID(), author, session.id]);
  await q(`INSERT INTO verification_evidence (session_id, kind, passed) VALUES ($1, 'side_effect', true)`, [session.id]);

  // History that outlives the space.
  await q(`INSERT INTO audit_log (user_id, action, workspace_id) VALUES ($1, 'task_mutated', $2)`, [author, ws]);
  await q(`INSERT INTO cost_log (user_id, session_id, model_name, input_tokens, output_tokens, total_cost, workspace_id) VALUES ($1, $2, 'm', 1, 1, 0.01, $3)`, [author, session.id, ws]);
  await q(`INSERT INTO cleanup_audit_log (user_id, workspace_id) VALUES ($1, $2)`, [author, ws]);
  return { sessionId: session.id, tables: [...seeded].sort() };
}

describe('purgeSpace', () => {
  test('deletes every delete-table row and session-keyed row, keeps history, removes files', async () => {
    const { purgeSpace } = await import('./purge');
    const { WORKSPACE_TABLES } = await import('@/db/workspace-tables');
    const { spaceDirectories } = await import('@/security/workspace-fs');
    const id = await archivedSpace(30);
    const { sessionId, tables } = await seedSpaceRows(id, editor);
    expect(tables).toEqual(WORKSPACE_TABLES.filter((t) => t.purge === 'delete').map((t) => t.table).sort());

    // A control space whose rows must survive.
    const control = await archivedSpace(30);
    const controlRows = await seedSpaceRows(control, editor);

    const dirs = spaceDirectories(id);
    mkdirSync(join(dirs.root, 'files'), { recursive: true });
    writeFileSync(join(dirs.root, 'files', 'plan.md'), '# plan');
    mkdirSync(dirs.documents, { recursive: true });
    writeFileSync(join(dirs.documents, 'upload.pdf'), 'pdf');

    const result = await purgeSpace({ userId: owner }, id);
    expect(result.leftoverDirectories).toEqual([]);

    for (const t of WORKSPACE_TABLES) {
      const [row] = await q(`SELECT count(*)::int AS n FROM ${t.table} WHERE workspace_id = $1`, [id]);
      if (t.purge === 'delete') expect(row.n, `${t.table} rows of the purged space`).toBe(0);
      else expect(row.n, `${t.table} history of the purged space`).toBeGreaterThan(0);
      const [kept] = await q(`SELECT count(*)::int AS n FROM ${t.table} WHERE workspace_id = $1`, [control]);
      expect(kept.n, `${t.table} rows of another space`).toBeGreaterThan(0);
    }
    for (const [table, column] of [
      ['agents', 'session_id'], ['tool_actions', 'session_id'], ['run_events', 'run_id'],
      ['agent_approvals', 'session_id'], ['verification_evidence', 'session_id'], ['messages', 'session_id'],
    ]) {
      const [row] = await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text = $1`, [sessionId]);
      expect(row.n, `${table} rows of the purged space's session`).toBe(0);
      const [kept] = await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text = $1`, [controlRows.sessionId]);
      expect(kept.n, `${table} rows of another space's session`).toBeGreaterThan(0);
    }
    expect(await q(`SELECT 1 FROM workspaces WHERE id = $1`, [id])).toEqual([]);
    expect(await q(`SELECT 1 FROM workspace_members WHERE workspace_id = $1`, [id])).toEqual([]);
    expect(await q(`SELECT 1 FROM workspace_invites WHERE workspace_id = $1`, [id])).toEqual([]);
    const [audit] = await q(`SELECT user_id FROM audit_log WHERE workspace_id = $1 AND action = 'space_purged'`, [id]);
    expect(audit.user_id).toBe(owner);

    expect(existsSync(dirs.root)).toBe(false);
    expect(existsSync(dirs.documents)).toBe(false);
  });

  test('only an owner, only an archived space, only after the waiting period', async () => {
    const { purgeSpace } = await import('./purge');
    const { createSpace } = await import('./service');
    const live = await createSpace({ userId: owner }, { name: 'Live' });
    await expect(purgeSpace({ userId: owner }, live.id)).rejects.toMatchObject({ code: 'not_purgeable' });
    const fresh = await archivedSpace(1);
    await expect(purgeSpace({ userId: owner }, fresh)).rejects.toMatchObject({ code: 'not_purgeable' });
    const old = await archivedSpace(30);
    await expect(purgeSpace({ userId: editor }, old)).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(purgeSpace({ userId: randomUUID() }, old)).rejects.toMatchObject({ code: 'not_found' });
    expect(await q(`SELECT 1 FROM workspaces WHERE id = ANY($1::uuid[])`, [[live.id, fresh, old]])).toHaveLength(3);
  });

  test('the sweep removes directories of spaces that no longer exist, and only those', async () => {
    const { sweepPurgedSpaceFiles } = await import('./purge');
    const { spaceDirectories } = await import('@/security/workspace-fs');
    const alive = await archivedSpace(0);
    const gone = randomUUID();
    for (const ws of [alive, gone]) {
      const dirs = spaceDirectories(ws);
      mkdirSync(dirs.root, { recursive: true });
      mkdirSync(dirs.documents, { recursive: true });
    }
    const removed = await sweepPurgedSpaceFiles();
    expect(removed.sort()).toEqual([spaceDirectories(gone).root, spaceDirectories(gone).documents].sort());
    expect(existsSync(spaceDirectories(alive).root)).toBe(true);
  });
});

describe('personal workspaces and user deletion', () => {
  test('a personal workspace delete still sets NULL, and never deletes a space', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const mgr = getOrgWorkspaceManager();
    const ws = await mgr.createWorkspace(editor, { slug: `side-${rand(3)}`, name: 'Side' });
    const [note] = await q(`INSERT INTO notes (user_id, slug, title, body_sha256, workspace_id) VALUES ($1, $2, 't', 'sha', $3) RETURNING id`, [editor, `n-${rand(4)}`, ws.id]);
    expect(await mgr.delete(editor, ws.id)).toBe(true);
    const [after] = await q(`SELECT workspace_id FROM notes WHERE id = $1`, [note.id]);
    expect(after.workspace_id).toBeNull();

    const space = await archivedSpace(30);
    expect(await mgr.delete(owner, space)).toBe(false);
    expect(await mgr.delete(editor, space)).toBe(false);
    expect(await q(`SELECT 1 FROM workspaces WHERE id = $1`, [space])).toHaveLength(1);
  });

  test('assertDeletable refuses the last owner of a space', async () => {
    const { assertDeletable } = await import('@/security/user-deletion');
    const { userRepository } = await import('@/db/repositories/user-repository');
    await expect(assertDeletable(owner)).rejects.toMatchObject({ code: 'last_space_owner' });
    await expect(userRepository.delete(owner)).rejects.toMatchObject({ code: 'last_space_owner' });
    // The editor owns no space alone.
    await expect(assertDeletable(editor)).resolves.toBeUndefined();
  });
});
