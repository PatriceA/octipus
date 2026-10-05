/**
 * WORKSPACE_TABLES (docs/plans/coworking-spec.md §4.3, S0c): the list names
 * every table with a `workspace_id` column, and workspace transfer moves the
 * rows of every `move` table — re-encrypting workspace secrets under the
 * recipient's key so they still decrypt.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const alice = randomUUID();
const bob = randomUUID();

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-ws-tables-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'alice' }, { id: bob, username: 'bob' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('WORKSPACE_TABLES', () => {
  test('lists exactly the tables that have a workspace_id column', async () => {
    const { WORKSPACE_TABLES } = await import('./workspace-tables');
    const rows = await q(
      `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND t.table_type = 'BASE TABLE'
       ORDER BY 1`,
    );
    const inDb = rows.map((r) => r.table_name as string);
    const listed = WORKSPACE_TABLES.map((t) => t.table).sort();
    // A table with a workspace_id that is missing here is a table transfer
    // and purge would silently skip.
    expect(listed).toEqual(inDb);
  });

  test('every owner column exists on its table', async () => {
    const { WORKSPACE_TABLES } = await import('./workspace-tables');
    for (const t of WORKSPACE_TABLES) {
      if (t.ownerColumn === null) continue;
      const rows = await q(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [t.table, t.ownerColumn],
      );
      expect(rows.length, `${t.table}.${t.ownerColumn}`).toBe(1);
    }
  });

  test('history tables are kept on purge, everything else deleted', async () => {
    const { WORKSPACE_TABLES } = await import('./workspace-tables');
    const kept = WORKSPACE_TABLES.filter((t) => t.purge === 'keep').map((t) => t.table);
    expect(kept).toEqual(['audit_log', 'cleanup_audit_log', 'cost_log']);
    expect(WORKSPACE_TABLES.find((t) => t.table === 'permission_requests')?.purge).toBe('delete');
    expect(WORKSPACE_TABLES.find((t) => t.table === 'notifications')?.purge).toBe('delete');
  });
});

describe('workspace transfer', () => {
  /**
   * One row per `move` table, owned by `owner` and stamped with `ws`.
   * Keyed by table so the test fails when a new `move` table has no fixture.
   */
  async function seedMoveRows(owner: string, ws: string): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    const [session] = await q(
      `INSERT INTO sessions (user_id, channel_type, channel_id, workspace_id) VALUES ($1, 'web', $2, $3) RETURNING id`,
      [owner, `chan-${randomUUID()}`, ws],
    );
    ids.sessions = session.id;
    const one = async (table: string, sql: string, params: unknown[]) => {
      const [row] = await q(sql, params);
      ids[table] = String(row.id);
    };
    await one('agent_events', `INSERT INTO agent_events (agent_id, session_id, type, user_id, workspace_id) VALUES ('a1', $1, 'started', $2, $3) RETURNING id`, [session.id, owner, ws]);
    await one('agents', `INSERT INTO agents (id, session_id, user_id, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [`agent-${randomUUID()}`, session.id, owner, ws]);
    await one('background_jobs', `INSERT INTO background_jobs (kind, user_id, title, workspace_id) VALUES ('research', $1, 'job', $2) RETURNING id`, [owner, ws]);
    await one('documents', `INSERT INTO documents (user_id, filename, original_name, mime_type, size, storage_path, workspace_id) VALUES ($1, 'f', 'f', 'text/plain', 1, '/x', $2) RETURNING id`, [owner, ws]);
    await one('embeddings', `INSERT INTO embeddings (source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, workspace_id) VALUES ('s', 'c', 'm', '[0.1,0.2,0.3]', 'document', $1, 'm/3', $2, $3) RETURNING id`, [randomUUID(), owner, ws]);
    await one('hooks', `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, workspace_id) VALUES ($1, 'h', 'message_received', '{}', 'notify', '{}', $2) RETURNING id`, [owner, ws]);
    await one('knowledge_links', `INSERT INTO knowledge_links (user_id, from_type, from_id, to_ref, link_type, origin, workspace_id) VALUES ($1, 'note', $2, 'x', 'references', 'wikilink', $3) RETURNING id`, [owner, randomUUID(), ws]);
    await one('memories', `INSERT INTO memories (user_id, fact_type, content, embedding, embedding_version, workspace_id) VALUES ($1, 'fact', 'c', '[0.1,0.2,0.3]', 'm/3', $2) RETURNING id`, [owner, ws]);
    await one('notes', `INSERT INTO notes (user_id, slug, title, body_sha256, workspace_id) VALUES ($1, $2, 't', 'sha', $3) RETURNING id`, [owner, `n-${randomUUID()}`, ws]);
    await one('pipelines', `INSERT INTO pipelines (root_agent_id, session_id, user_id, title, type, workspace_id) VALUES ('a1', $1, $2, 'p', 'plan', $3) RETURNING id`, [session.id, owner, ws]);
    await one('swarm_nodes', `INSERT INTO swarm_nodes (id, root_session_id, depth, kind, role, topic_path, model, token_cap, wall_clock_cap_ms, fan_out_cap, brief_hash, user_id, workspace_id) VALUES ($1, $2, 0, 'root', 'general', 't', 'm', 1, 1, 1, 'h', $3, $4) RETURNING id`, [`node-${randomUUID()}`, session.id, owner, ws]);
    await one('task_state', `INSERT INTO task_state (session_id, user_id, owner_agent, task_kind, status, workspace_id) VALUES ($1, $2, 'a1', 'k', 'open', $3) RETURNING id`, [session.id, owner, ws]);
    await one('tasks', `INSERT INTO tasks (user_id, title, workspace_id) VALUES ($1, 't', $2) RETURNING id`, [owner, ws]);
    await one('trajectory_runs', `INSERT INTO trajectory_runs (user_id, root_session_id, outcome, started_at, ended_at, jsonl_path, jsonl_line, workspace_id) VALUES ($1, $2, 'success', now(), now(), '/t.jsonl', 1, $3) RETURNING id`, [owner, session.id, ws]);
    await one('workspace_repos', `INSERT INTO workspace_repos (user_id, name, root_path, workspace_id) VALUES ($1, 'r', $2, $3) RETURNING id`, [owner, `/repo/${randomUUID()}`, ws]);
    const { getVault } = await import('@/security/vault');
    const secret = await getVault().store(owner, 'ws_token', 'ws-secret-value', { credentialType: 'api_key', scope: 'workspace', workspaceId: ws });
    ids.vault = secret.id;
    return ids;
  }

  test('moves every move table, leaves n/a tables and other workspaces alone', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const { workspaceMoveTables } = await import('./workspace-tables');
    const mgr = getOrgWorkspaceManager();
    const ws = await mgr.createWorkspace(alice, { slug: `xfer-${rand(3)}`, name: 'Transfer' });
    const other = await mgr.createWorkspace(alice, { slug: `stay-${rand(3)}`, name: 'Stays' });

    const moved = await seedMoveRows(alice, ws.id);
    const control = await seedMoveRows(alice, other.id);
    expect(Object.keys(moved).sort()).toEqual(workspaceMoveTables().map((t) => t.table).sort());

    const [notification] = await q(
      `INSERT INTO notifications (user_id, type, title, workspace_id) VALUES ($1, 'info', 'n', $2) RETURNING id`,
      [alice, ws.id],
    );
    const [userSecret] = await q(`SELECT id FROM vault WHERE id = $1`, [
      (await (await import('@/security/vault')).getVault().store(alice, 'personal_token', 'mine', { credentialType: 'api_key' })).id,
    ]);

    await mgr.transfer(alice, ws.id, bob);

    for (const t of workspaceMoveTables()) {
      const [row] = await q(`SELECT ${t.ownerColumn}::text AS owner FROM ${t.table} WHERE id::text = $1`, [moved[t.table]]);
      expect(row.owner, `${t.table} row of the transferred workspace`).toBe(bob);
      const [kept] = await q(`SELECT ${t.ownerColumn}::text AS owner FROM ${t.table} WHERE id::text = $1`, [control[t.table]]);
      expect(kept.owner, `${t.table} row of another workspace`).toBe(alice);
    }
    const [n] = await q(`SELECT user_id::text AS owner FROM notifications WHERE id = $1`, [notification.id]);
    expect(n.owner).toBe(alice);
    const [s] = await q(`SELECT user_id FROM vault WHERE id = $1`, [userSecret.id]);
    expect(s.user_id).toBe(alice);
  });

  test('a transferred workspace secret decrypts for the recipient, not for the previous owner', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const { getVault } = await import('@/security/vault');
    const mgr = getOrgWorkspaceManager();
    const ws = await mgr.createWorkspace(alice, { slug: `vault-${rand(3)}`, name: 'Vault' });
    await getVault().store(alice, 'deploy_key', 'swordfish', { credentialType: 'api_key', scope: 'workspace', workspaceId: ws.id });

    // Before: the owner reads the workspace secret by name in that workspace.
    expect(await getVault().getByName(alice, 'deploy_key', { workspaceId: ws.id })).toBe('swordfish');

    await mgr.transfer(alice, ws.id, bob);

    expect(await getVault().getByName(bob, 'deploy_key', { workspaceId: ws.id })).toBe('swordfish');
    expect(await getVault().getByName(alice, 'deploy_key', { workspaceId: ws.id })).toBeNull();
  });
});

describe('vault getByName', () => {
  test('a workspace secret wins over a user secret of the same name, only in its workspace', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const { getVault } = await import('@/security/vault');
    const mgr = getOrgWorkspaceManager();
    const ws = await mgr.createWorkspace(alice, { slug: `byname-${rand(3)}`, name: 'By name' });
    const elsewhere = await mgr.createWorkspace(alice, { slug: `elsewhere-${rand(3)}`, name: 'Elsewhere' });
    await getVault().store(alice, 'api_token', 'user-level', { credentialType: 'api_key' });
    await getVault().store(alice, 'api_token', 'workspace-level', { credentialType: 'api_key', scope: 'workspace', workspaceId: ws.id });

    expect(await getVault().getByName(alice, 'api_token', { workspaceId: ws.id })).toBe('workspace-level');
    expect(await getVault().getByName(alice, 'api_token', { workspaceId: elsewhere.id })).toBe('user-level');
    expect(await getVault().getByName(alice, 'api_token')).toBe('user-level');
  });

  test('a workspace secret bound to no workspace is not returned in any workspace', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const { getVault } = await import('@/security/vault');
    const ws = await getOrgWorkspaceManager().createWorkspace(alice, { slug: `unbound-${rand(3)}`, name: 'Unbound' });
    await getVault().store(alice, 'unbound_token', 'nowhere', { credentialType: 'api_key', scope: 'workspace', workspaceId: null });
    expect(await getVault().getByName(alice, 'unbound_token', { workspaceId: ws.id })).toBeNull();
    const listed = await getVault().list(alice, { workspaceId: ws.id });
    expect(listed.find((e) => e.name === 'unbound_token')).toBeUndefined();
  });
});
