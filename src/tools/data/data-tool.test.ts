/**
 * Tool-level tests for the `data` group.
 *
 * The point of most of these is the authorisation boundary: `sql_query` takes
 * a connection NAME, and only a vault entry the user tagged `database` can be
 * named. A secret that exists but is untagged — an API key, say — must be
 * invisible here, or the read tool becomes a way to exfiltrate credentials by
 * pointing it somewhere it was never meant to reach.
 *
 * Invocations use role:'general' (an autonomous worker) so the base-tool
 * permission gate is skipped exactly as it is for spawned workers in
 * production.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext, ToolManifest } from '@/core/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import { CONNECTION_TAG, DataTool } from './index';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let tool: DataTool;
let handlers: Map<string, ToolHandler>;

function ctx(userId: string): AgentContext {
  return {
    id: 'agent-1',
    sessionId: 'sess-1',
    userId,
    role: 'general',
    topic: 'data',
    model: 'test',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  } as AgentContext;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are open-shaped by design
const call = (name: string, args: Record<string, unknown>, userId: string) =>
  handlers.get(name)!.execute(args, ctx(userId)) as Promise<any>;

/** Write a file into the caller's own workspace root, the way an agent would. */
function writeWorkspaceFile(userId: string, name: string, body: string): string {
  const fs = WorkspaceFS.forAgent({ userId });
  fs.ensureRootSync();
  writeFileSync(join(fs.root, name), body);
  return name;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-data-tool-'));
  process.env.WORKSPACE_ROOT ??= mkdtempSync(join(tmpdir(), 'octipus-data-ws-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false), ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  const { initializeVault, getVault } = await import('@/security/vault');
  await initializeVault();
  const vault = getVault();
  await vault.store(aliceId, 'analytics', 'postgres://user:pw@localhost:1/analytics', {
    credentialType: 'other',
    description: 'Analytics replica',
    tags: [CONNECTION_TAG],
  });
  // Deliberately untagged: this one must never show up as a connection.
  await vault.store(aliceId, 'stripe_key', 'sk_live_not_a_dsn', {
    credentialType: 'api_key',
    description: 'Stripe',
  });

  tool = new DataTool();
  await tool.initialize();
  handlers = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('manifest', () => {
  test('declares the three actions the handlers ask for', () => {
    const manifest: ToolManifest = tool.getManifest();
    const levels = Object.fromEntries(manifest.permissions.map((p) => [p.action, p.defaultLevel]));
    expect(levels).toEqual({ query: 'ALLOW', read: 'ALLOW', list: 'ALLOW' });
    expect(manifest.tools.map((t) => t.name).sort())
      .toEqual(['csv_query', 'list_connections', 'sql_query']);
  });
});

describe('list_connections', () => {
  test('lists only the vault entries tagged as connections', async () => {
    const res = await call('list_connections', {}, aliceId);
    expect(res.connections.map((c: { name: string }) => c.name)).toEqual(['analytics']);
    expect(res.connections[0].description).toBe('Analytics replica');
  });

  test('another user sees none of them', async () => {
    const res = await call('list_connections', {}, bobId);
    expect(res.connections).toEqual([]);
    expect(res.hint).toContain(CONNECTION_TAG);
  });
});

describe('sql_query', () => {
  test('refuses a connection name that is not registered', async () => {
    const res = await call('sql_query', { connection: 'nope', query: 'SELECT 1' }, aliceId);
    expect(res.error).toContain('Unknown connection "nope"');
    expect(res.error).toContain('analytics');
  });

  test('refuses to open an untagged secret', async () => {
    // `stripe_key` exists in Alice's vault, so this is the case that matters:
    // the tag, not the existence of the secret, is what makes it reachable.
    const res = await call('sql_query', { connection: 'stripe_key', query: 'SELECT 1' }, aliceId);
    expect(res.error).toContain('Unknown connection "stripe_key"');
  });

  test('a registered connection is invisible to another user', async () => {
    const res = await call('sql_query', { connection: 'analytics', query: 'SELECT 1' }, bobId);
    expect(res.error).toContain('No database connections are registered');
  });

  test('rejects a write before it opens a connection', async () => {
    // The DSN points nowhere, so a connection attempt would fail with a
    // network error. Getting the guard's message back proves the statement was
    // refused first.
    const res = await call('sql_query', { connection: 'analytics', query: 'DELETE FROM orders' }, aliceId);
    expect(res.error).toMatch(/Read-only queries only/);
    expect(res.error).toContain('DELETE');
  });
});

describe('csv_query', () => {
  test('returns the schema when no query is given', async () => {
    const path = writeWorkspaceFile(aliceId, 'sales.csv', 'Region,Amount\nEMEA,10\nAPAC,20\n');
    const res = await call('csv_query', { path }, aliceId);
    expect(res.columns.map((c: { name: string }) => c.name)).toEqual(['region', 'amount']);
    expect(res.rows).toBe(2);
    expect(res.hint).toContain('SELECT * FROM data');
  });

  test('runs SQL over the loaded file', async () => {
    const path = writeWorkspaceFile(aliceId, 'totals.csv', 'Region,Amount\nEMEA,10\nAPAC,20\nEMEA,5\n');
    const res = await call('csv_query', {
      path,
      query: 'SELECT region, sum(amount) AS total FROM data GROUP BY region ORDER BY region',
    }, aliceId);
    expect(res.columns).toEqual(['region', 'total']);
    expect(res.rows).toEqual([['APAC', 20], ['EMEA', 15]]);
  }, 60_000);

  test('honours a custom table name', async () => {
    const path = writeWorkspaceFile(aliceId, 'named.csv', 'a\n1\n2\n');
    const res = await call('csv_query', { path, table: 'orders', query: 'SELECT count(*) AS n FROM orders' }, aliceId);
    expect(res.rows).toEqual([[2]]);
  }, 60_000);

  test('refuses a path outside the workspace', async () => {
    const res = await call('csv_query', { path: '../../../etc/passwd' }, aliceId);
    expect(res.error).toContain('outside the allowed workspace');
  });

  test('refuses a file it cannot read as a table', async () => {
    const path = writeWorkspaceFile(aliceId, 'notes.md', '# hello');
    const res = await call('csv_query', { path }, aliceId);
    expect(res.error).toContain('not a CSV, TSV or spreadsheet');
  });

  test('refuses an unsafe table name', async () => {
    const path = writeWorkspaceFile(aliceId, 'inject.csv', 'a\n1\n');
    const res = await call('csv_query', { path, table: 'x"; DROP TABLE y; --' }, aliceId);
    expect(res.error).toContain('Invalid table name');
  });
});
