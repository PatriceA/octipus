/**
 * Security regression: POST /api/knowledge/index must sandbox the
 * caller-supplied `path` to the caller's workspace.
 *
 * Before the fix the route passed `body.path` straight to
 * `FileIndexer.indexFile`, which does `Bun.file(path).text()` on ANY absolute
 * path. An authenticated user (via the MCP `octipus_upload_document` tool or
 * REST directly) could index `/etc/passwd`, app secrets, or another tenant's
 * workspace into their own knowledge base and read it back through search —
 * arbitrary file read + cross-tenant exfiltration.
 *
 * The fix resolves `path` through `WorkspaceFS.forAgent({ userId })` and
 * rejects anything outside the workspace with 400, BEFORE the KB-readiness
 * gate. These tests need no DB and no embedding stack: a hostile path is
 * rejected at the sandbox; a legitimate in-workspace path falls through to the
 * KB-readiness gate (503 here), which proves it cleared the sandbox.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const USER = '11111111-1111-1111-1111-111111111111';

let app: ElysiaLike;
let dataRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

async function post(path: string, body: unknown) {
  const res = await app.handle(
    new Request('http://localhost/api/knowledge/index', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed as { error?: string } };
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'octipus-kb-sandbox-'));
  setEnv('WORKSPACE_PATH', dataRoot);
  setEnv('MULTIUSER', 'true');
  setEnv('LOG_LEVEL', 'error');

  const { resetConfig, loadConfig } = await import('@/config');
  resetConfig();
  loadConfig();

  const { knowledgeRoutes } = await import('./knowledge');
  const { principalFromUser } = await import('@/security/principal');
  const u = { id: USER, username: 'alice', isAdmin: false };

  app = new Elysia()
    .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
    .group('/api', (a) => a.use(knowledgeRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { resetConfig } = await import('@/config');
  resetConfig();
  for (const [k, v] of Object.entries(savedEnv)) setEnv(k, v);
});

describe('POST /api/knowledge/index — path sandbox', () => {
  test('absolute path outside the workspace is rejected 400 (the vuln)', async () => {
    const r = await post('/api/knowledge/index', { path: '/etc/passwd' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outside allowed workspace directories/);
  });

  test('parent traversal is rejected 400', async () => {
    const r = await post('/api/knowledge/index', { path: '../../../../etc/passwd' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outside allowed workspace directories/);
  });

  test('another tenant\'s workspace path is rejected 400 (cross-tenant)', async () => {
    const bobPath = resolve(dataRoot, 'users', '22222222-2222-2222-2222-222222222222', 'workspaces', 'default', 'files', 'secret.md');
    const r = await post('/api/knowledge/index', { path: bobPath });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outside allowed workspace directories/);
  });

  test('directory index of an out-of-workspace dir is rejected 400', async () => {
    const r = await post('/api/knowledge/index', { path: '/tmp', type: 'directory' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outside allowed workspace directories/);
  });

  test('a legitimate in-workspace path clears the sandbox (no 400)', async () => {
    // Per-user root for this user under multiuser. The path need not exist —
    // it passes the sandbox, then hits the downstream KB-readiness gate.
    const inside = resolve(dataRoot, 'users', USER, 'workspaces', 'default', 'files', 'notes.md');
    const r = await post('/api/knowledge/index', { path: inside });
    expect(r.status).not.toBe(400);
    expect(r.body.error ?? '').not.toMatch(/outside allowed workspace directories/);
  });
});
