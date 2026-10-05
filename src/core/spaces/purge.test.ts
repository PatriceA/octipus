/**
 * Space purge (docs/plans/coworking-spec.md §5.8, D15, I9).
 *
 *   - Purge, after a real agent turn in the space (only the model call is a
 *     stand-in: the worker, its persistence, events, audit and cost
 *     accounting are real), leaves no row with the space's id in any
 *     `delete` table of WORKSPACE_TABLES, nor any row keyed by the space's
 *     sessions; the `keep` tables (audit, cost, cleanup history) keep theirs.
 *   - When a row survives the deletes, purge aborts and rolls back: the
 *     space and every row of it are still there, and no purge is audited.
 *   - Only an owner, only after `spaces.purgeAfterArchiveDays` of archive.
 *   - The space's directories are removed; the sweep removes leftovers.
 *   - A personal workspace delete still sets NULL, and never deletes a space.
 *   - `assertDeletable` refuses the last owner of a space and the author of
 *     space content; a deletable user leaves their spaces with audit rows.
 *   - Purged sessions (and a deleted user's) are reported to
 *     `sessionsRemoved`, so the gateway drops their replay buffers.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { CompletionResult } from '@/models/litellm-client';

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

/**
 * An archived space with an editor, archived `daysAgo` days ago. `before`
 * runs while the space is still live (an agent turn, say).
 */
async function archivedSpace(daysAgo: number, before?: (id: string) => Promise<void>): Promise<string> {
  const { createSpace, archiveSpace } = await import('./service');
  const { createInvite, acceptInvite } = await import('./invites');
  const space = await createSpace({ userId: owner }, { name: `Space ${rand(3)}` });
  const invite = await createInvite({ userId: owner }, space.id, { role: 'editor' });
  await acceptInvite({ userId: editor }, invite.token);
  if (before) await before(space.id);
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
  const [note] = await q(`INSERT INTO notes (user_id, slug, title, body_sha256, workspace_id) VALUES ($1, $2, 't', 'sha', $3) RETURNING id`, [author, `n-${randomUUID()}`, ws]);
  seeded.add('notes');
  await one('note_revisions', `INSERT INTO note_revisions (note_id, workspace_id, body, body_sha256, authors, origin) VALUES ($1, $2, '', 'sha', ARRAY[$3::uuid], 'live')`, [note.id, ws, author]);
  await one('note_edit_proposals', `INSERT INTO note_edit_proposals (note_id, workspace_id, user_id, base_body, base_sha256, body) VALUES ($1, $2, $3, '', 'sha', 'x')`, [note.id, ws, author]);
  await one('file_leases', `INSERT INTO file_leases (workspace_id, path, holder_user_id, holder_kind, expires_at) VALUES ($1, 'a.md', $2, 'human', now() + interval '1 hour')`, [ws, author]);
  await one('notifications', `INSERT INTO notifications (user_id, type, title, workspace_id) VALUES ($1, 'info', 'n', $2)`, [author, ws]);
  await one('permission_requests', `INSERT INTO permission_requests (user_id, agent_id, skill_id, action, context, workspace_id) VALUES ($1, 'a1', 't', 'write', '{"toolName":"t","toolArguments":{}}', $2)`, [author, ws]);
  await one('pipelines', `INSERT INTO pipelines (root_agent_id, session_id, user_id, title, type, workspace_id) VALUES ('a1', $1, $2, 'p', 'plan', $3)`, [session.id, author, ws]);
  await one('swarm_nodes', `INSERT INTO swarm_nodes (id, root_session_id, depth, kind, role, topic_path, model, token_cap, wall_clock_cap_ms, fan_out_cap, brief_hash, user_id, workspace_id) VALUES ($1, $2, 0, 'root', 'general', 't', 'm', 1, 1, 1, 'h', $3, $4)`, [`node-${randomUUID()}`, session.id, author, ws]);
  await one('task_state', `INSERT INTO task_state (session_id, user_id, owner_agent, task_kind, status, workspace_id) VALUES ($1, $2, 'a1', 'k', 'open', $3)`, [session.id, author, ws]);
  await one('tasks', `INSERT INTO tasks (user_id, title, workspace_id) VALUES ($1, 't', $2)`, [author, ws]);
  await one('trajectory_runs', `INSERT INTO trajectory_runs (user_id, root_session_id, outcome, started_at, ended_at, jsonl_path, jsonl_line, workspace_id) VALUES ($1, $2, 'success', now(), now(), '/t.jsonl', 1, $3)`, [author, session.id, ws]);
  await one('workspace_repos', `INSERT INTO workspace_repos (user_id, name, root_path, workspace_id) VALUES ($1, 'r', $2, $3)`, [author, `/repo/${randomUUID()}`, ws]);
  await one('space_memory', `INSERT INTO space_memory (workspace_id, body, author_kind, author_user_id) VALUES ($1, 'fact', 'member', $2)`, [ws, author]);
  await one('space_member_notices', `INSERT INTO space_member_notices (workspace_id, user_id, period, warned_at) VALUES ($1, $2, 'day', now())`, [ws, author]);
  // The space's budget is keyed by scope_ref, not workspace_id: purged with it.
  await q(`INSERT INTO spend_budgets (user_id, scope_kind, scope_ref, period, limit_usd) VALUES ($1, 'space', $2, 'day', 5)`, [author, ws]);
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

/**
 * A real agent turn of `userId` in a private chat of the space: the chat is
 * created through the space door, the agent spawned by the agent manager and
 * run by the real worker. Only the model is a stand-in — it answers, and its
 * usage goes through the real provider accounting into `cost_log`.
 */
async function agentTurnIn(ws: string, userId: string): Promise<{ sessionId: string; agentId: string }> {
  const { contentRepos } = await import('@/db/repositories/content');
  const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  const session = await contentRepos(await resolvedPrincipal(userId, ws)).sessions.create({ channelType: 'web', channelId: `space-chat-${rand(4)}` });
  const { getAgentManager } = await import('@/core/agent-manager');
  const { resolveAgentScope } = await import('@/core/agent/context');
  const scope = await resolveAgentScope({ session, userId, trigger: 'user' });
  const worker = await getAgentManager().spawn({ sessionId: session.id, userId, ...scope, topic: 'general', model: 'test-model', role: 'general' });
  const agentId = worker.getContext().id;
  const answer: CompletionResult = {
    content: 'The launch plan is drafted.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    model: 'test-model',
    latencyMs: 1,
  };
  const { recordProviderUsage } = await import('@/models/providers/instrumented');
  vi.spyOn(worker as unknown as { getCompletion(): Promise<CompletionResult> }, 'getCompletion').mockImplementation(async () => {
    await recordProviderUsage({ model: 'test-model', messages: [], userId, sessionId: session.id, agentId }, 'stub', answer);
    return answer;
  });
  await worker.run('Draft the launch plan');
  // The worker's completion bookkeeping is fire-and-forget; wait for its row.
  await vi.waitFor(async () => {
    const [row] = await q(`SELECT status FROM agents WHERE id = $1`, [agentId]);
    expect(row?.status).toBe('completed');
  });
  return { sessionId: session.id, agentId };
}

describe('purgeSpace', () => {
  test('deletes every delete-table row and session-keyed row, keeps history, removes files', async () => {
    const { purgeSpace } = await import('./purge');
    const { WORKSPACE_TABLES } = await import('@/db/workspace-tables');
    const { spaceDirectories } = await import('@/security/workspace-fs');
    let turn: { sessionId: string; agentId: string } | undefined;
    const id = await archivedSpace(30, async (ws) => { turn = await agentTurnIn(ws, editor); });
    if (!turn) throw new Error('no agent turn');
    // What the turn left in the space: its chat, agent, events, audit and cost.
    expect(await q(`SELECT 1 FROM agents WHERE id = $1 AND workspace_id = $2`, [turn.agentId, id])).toHaveLength(1);
    expect((await q(`SELECT 1 FROM agent_events WHERE agent_id = $1`, [turn.agentId])).length).toBeGreaterThan(0);
    const [turnCost] = await q(`SELECT count(*)::int AS n FROM cost_log WHERE agent_id = $1`, [turn.agentId]);
    expect(turnCost.n).toBeGreaterThan(0);
    const [turnAudit] = await q(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1`, [turn.agentId]);
    expect(turnAudit.n).toBeGreaterThan(0);
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

    // A group channel bound to the space (§9.4): it stays enrolled, unbound.
    const [bound] = await q(
      `INSERT INTO group_channels (channel_type, channel_id, owner_user_id, workspace_id) VALUES ('slack', $1, $2, $3) RETURNING id`,
      [`C-${id.slice(0, 8)}`, owner, id],
    );
    await q(`INSERT INTO group_channels (channel_type, channel_id, owner_user_id, workspace_id) VALUES ('slack', $1, $2, $3)`,
      [`C-${control.slice(0, 8)}`, owner, control]);

    // The gateway hears which sessions went, to drop their replay buffers.
    const { onSessionsRemoved } = await import('@/db/repositories/session-lifecycle');
    const removed: string[] = [];
    const stopListening = onSessionsRemoved((ids) => removed.push(...ids));
    const result = await purgeSpace({ userId: owner }, id).finally(stopListening);
    expect(result.leftoverDirectories).toEqual([]);
    expect(removed).toContain(sessionId);
    expect(removed).not.toContain(controlRows.sessionId);
    expect(removed).toHaveLength(result.deleted.sessions);

    const [channel] = await q('SELECT workspace_id FROM group_channels WHERE id = $1', [bound.id]);
    expect(channel).toEqual({ workspace_id: null });
    for (const t of WORKSPACE_TABLES) {
      const [row] = await q(`SELECT count(*)::int AS n FROM ${t.table} WHERE workspace_id = $1`, [id]);
      // `detach` rows (a bound group channel) outlive the space without naming it.
      if (t.purge === 'delete' || t.purge === 'detach') expect(row.n, `${t.table} rows of the purged space`).toBe(0);
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
    expect(await q(`SELECT 1 FROM spend_budgets WHERE scope_ref = $1`, [id])).toEqual([]);
    expect(await q(`SELECT 1 FROM spend_budgets WHERE scope_ref = $1`, [control])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM workspaces WHERE id = $1`, [id])).toEqual([]);
    expect(await q(`SELECT 1 FROM workspace_members WHERE workspace_id = $1`, [id])).toEqual([]);
    expect(await q(`SELECT 1 FROM workspace_invites WHERE workspace_id = $1`, [id])).toEqual([]);
    const [audit] = await q(`SELECT user_id FROM audit_log WHERE workspace_id = $1 AND action = 'space_purged'`, [id]);
    expect(audit.user_id).toBe(owner);

    expect(existsSync(dirs.root)).toBe(false);
    expect(existsSync(dirs.documents)).toBe(false);

    // The turn's rows went with the space; its cost and audit history stay.
    for (const [table, column, value] of [
      ['agents', 'id', turn.agentId], ['agent_events', 'agent_id', turn.agentId],
      ['sessions', 'id', turn.sessionId],
    ]) {
      expect(await q(`SELECT 1 FROM ${table} WHERE ${column}::text = $1`, [value]), `${table} of the turn`).toEqual([]);
    }
    const [costAfter] = await q(`SELECT count(*)::int AS n FROM cost_log WHERE agent_id = $1`, [turn.agentId]);
    expect(costAfter.n).toBe(turnCost.n);
    const [auditAfter] = await q(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1`, [turn.agentId]);
    expect(auditAfter.n).toBe(turnAudit.n);
  });

  test('a row that survives the deletes aborts the purge and rolls everything back', async () => {
    const { purgeSpace } = await import('./purge');
    const id = await archivedSpace(30);
    await seedSpaceRows(id, editor);
    const [before] = await q(`SELECT count(*)::int AS n FROM notes WHERE workspace_id = $1`, [id]);
    // A row the delete cannot remove (as one written by something racing the purge would be).
    await q(`CREATE OR REPLACE FUNCTION keep_purge_test_notes() RETURNS trigger AS $fn$
      BEGIN IF OLD.workspace_id = '${id}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $fn$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER keep_purge_test_notes BEFORE DELETE ON notes FOR EACH ROW EXECUTE FUNCTION keep_purge_test_notes()`);
    try {
      await expect(purgeSpace({ userId: owner }, id)).rejects.toThrow(/notes still name space .*aborting/);
    } finally {
      await q(`DROP TRIGGER keep_purge_test_notes ON notes`);
      await q(`DROP FUNCTION keep_purge_test_notes()`);
    }
    // Rolled back: the space, its members and every row are still there, and no purge is on record.
    expect(await q(`SELECT 1 FROM workspaces WHERE id = $1`, [id])).toHaveLength(1);
    expect((await q(`SELECT 1 FROM workspace_members WHERE workspace_id = $1`, [id])).length).toBe(2);
    const [after] = await q(`SELECT count(*)::int AS n FROM notes WHERE workspace_id = $1`, [id]);
    expect(after.n).toBe(before.n);
    for (const table of ['sessions', 'tasks', 'documents', 'agents']) {
      const [row] = await q(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [id]);
      expect(row.n, table).toBeGreaterThan(0);
    }
    expect(await q(`SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'space_purged'`, [id])).toEqual([]);
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

  test('assertDeletable refuses the last owner of a space, and the author of space content', async () => {
    const { assertDeletable } = await import('@/security/user-deletion');
    const { userRepository } = await import('@/db/repositories/user-repository');
    await expect(assertDeletable(owner)).rejects.toMatchObject({ code: 'last_space_owner' });
    await expect(userRepository.delete(owner)).rejects.toMatchObject({ code: 'last_space_owner' });
    // The editor owns no space alone, but authored space tasks and notes:
    // the account cascade would destroy them (and others' comments on them).
    await expect(assertDeletable(editor)).rejects.toMatchObject({ code: 'space_author' });
    expect(await q(`SELECT 1 FROM users WHERE id = $1`, [editor])).toHaveLength(1);
  });

  test('a deletable member leaves their spaces with audit rows before the account goes', async () => {
    const { userRepository } = await import('@/db/repositories/user-repository');
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    const { createInvite, acceptInvite } = await import('./invites');
    const { createSpace, setRole } = await import('./service');
    const member = randomUUID();
    await seedUsers([{ id: member, username: `m-${rand(3)}` }]);
    const space = await createSpace({ userId: owner }, { name: `Leavers ${rand(3)}` });
    const invite = await createInvite({ userId: owner }, space.id, { role: 'editor' });
    await acceptInvite({ userId: member }, invite.token);
    // A co-owner (not the last one): leaving is allowed.
    await setRole({ userId: owner }, space.id, member, { role: 'owner' });

    expect(await userRepository.delete(member)).toBe(true);
    const [left] = await q(`SELECT user_id, details FROM audit_log WHERE workspace_id = $1 AND action = 'space_member_removed' AND resource_id = $2`, [space.id, member]);
    expect(left.details).toMatchObject({ left: true, accountDeleted: true, previousValue: 'owner' });
  });

  test('a user deletion reports only sessions that are actually gone', async () => {
    const { userRepository } = await import('@/db/repositories/user-repository');
    const { onSessionsRemoved } = await import('@/db/repositories/session-lifecycle');
    const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    const withSession = randomUUID();
    const without = randomUUID();
    await seedUsers([{ id: withSession, username: `u-${rand(3)}` }, { id: without, username: `u-${rand(3)}` }]);
    const { id: sessionId } = await seedSession({ userId: withSession });
    const removed: string[] = [];
    const stopListening = onSessionsRemoved((ids) => removed.push(...ids));
    try {
      // `sessions.user_id` does not cascade: the database refuses, and the
      // session (still there, still replayable) is not reported gone.
      await expect(userRepository.delete(withSession)).rejects.toThrow();
      expect(await q(`SELECT 1 FROM sessions WHERE id = $1`, [sessionId])).toHaveLength(1);
      expect(await userRepository.delete(without)).toBe(true);
      expect(removed).toEqual([]);
    } finally {
      stopListening();
    }
  });
});
