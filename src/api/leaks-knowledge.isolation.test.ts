/**
 * Live cross-user leaks L1–L3 (docs/plans/coworking-spec.md §1.1, §4.1):
 * documents, the knowledge base and global search. Two users; B gets nothing
 * of A's through the agent tools or the routes, and an admin reaches the
 * install-wide knowledge base only with `?scope=install`, audited.
 *
 * Drives the real tools and routes against an embedded PGlite. No embedding
 * model is configured: search falls back to full text, which runs the same
 * scope predicate as the vector path.
 *
 * Other leak groups of §4.1 live in their own `src/api/leaks-*.isolation.test.ts`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

// The search routes refuse to run while the embedding stack is down; these
// tests exercise scoping, not the readiness gate.
vi.mock('@/core/rag/health', async (orig) => ({
  ...(await orig<typeof import('@/core/rag/health')>()),
  isKBReady: () => true,
}));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
// biome-ignore lint/suspicious/noExplicitAny: route and tool results are open-shaped
type Json = any;

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const admin = '33333333-3333-4333-8333-333333333333';
const vec = [0.1, 0.2, 0.3];

let aliceDocId: string;
let bobDocId: string;
let bobChunkId: string;
let aliceChunkId: string;
let productChunkId: string;
let installChunkId: string;
let bobShortChunkId: string;
let aliceShortChunkId: string;

function appFor(userId: string, isAdmin: boolean, routes: Parameters<Elysia['use']>[0]): ElysiaLike {
  return new Elysia()
    .derive(async () => {
      const { principalFromUser } = await import('@/security/principal');
      const u = { id: userId, username: userId.slice(0, 5), isAdmin };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    .group('/api', (a) => a.use(routes)) as unknown as ElysiaLike;
}

async function request(app: ElysiaLike, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json() };
}

function ctx(userId: string): AgentContext {
  return {
    id: `agent-${userId.slice(0, 4)}`,
    sessionId: randomUUID(),
    userId,
    role: 'general',
    topic: 'general',
    model: 'test',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  } as AgentContext;
}

let documentsTool: Map<string, ToolHandler>;
let knowledgeTool: Map<string, ToolHandler>;
const run = (tools: Map<string, ToolHandler>, name: string, userId: string, args: Record<string, unknown>) =>
  tools.get(name)!.execute(args, ctx(userId)) as Promise<Json>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-leaks-kb-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedDocument, seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: alice, username: 'alice' },
    { id: bob, username: 'bob' },
    { id: admin, username: 'root', isAdmin: true },
  ]);
  aliceDocId = (await seedDocument({ userId: alice, originalName: 'alice-contract.pdf', status: 'completed' })).id;
  bobDocId = (await seedDocument({ userId: bob, originalName: 'bob-contract.pdf', status: 'completed' })).id;
  await seedSession({ userId: alice, title: 'zephyr planning alice' });
  await seedSession({ userId: bob, title: 'zephyr planning bob' });
  const { executeRaw } = await import('@/db/postgres');
  for (const [owner, name] of [[alice, 'zephyr hook alice'], [bob, 'zephyr hook bob']]) {
    await executeRaw(
      `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config)
       VALUES ('${owner}', '${name}', 'message_received', '{}', 'notify', '{}')`,
    );
  }
  await executeRaw(
    `INSERT INTO skills (id, name, description, is_system, user_id) VALUES
       ('zephyr-alice', 'zephyr deploy alice', 'alice private skill', false, '${alice}'),
       ('zephyr-bob', 'zephyr deploy bob', 'bob private skill', false, '${bob}'),
       ('zephyr-system', 'zephyr deploy system', 'built-in skill', true, NULL)`,
  );

  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  const svc = getEmbeddingService();
  vi.spyOn(svc, 'generateEmbedding').mockRejectedValue(new Error('no embedding model in leak tests'));
  const own = (userId: string) => ({ ownerUserId: userId, workspaceId: null });
  aliceChunkId = await svc.store(own(alice), 'document', `doc:${aliceDocId}`, 'quokka migration plan written by alice for the board', vec, {}, { docId: aliceDocId });
  bobChunkId = await svc.store(own(bob), 'document', `doc:${bobDocId}`, 'quokka salary figures that only bob may ever read', vec, {}, { docId: bobDocId });
  productChunkId = await svc.store({ product: true }, 'document', '/app/docs/QUOKKA.md', 'quokka setup guide from the product manual', vec, { source: 'octipus-docs' });
  installChunkId = await svc.store({ product: true }, 'document', '/legacy/unowned.md', 'quokka legacy unattributed row from before owners', vec, {});
  bobShortChunkId = await svc.store(own(bob), 'note', 'note:bob-short', 'bob tiny', vec, {});
  aliceShortChunkId = await svc.store(own(alice), 'note', 'note:alice-short', 'alice tiny', vec, {});

  const { DocumentsTool } = await import('@/tools/documents');
  const { KnowledgeTool } = await import('@/tools/knowledge');
  const docs = new DocumentsTool();
  await docs.initialize();
  documentsTool = (docs as unknown as { tools: Map<string, ToolHandler> }).tools;
  const kb = new KnowledgeTool();
  await kb.initialize();
  knowledgeTool = (kb as unknown as { tools: Map<string, ToolHandler> }).tools;
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('L1 — documents', () => {
  test('the documents tool lists only the user’s own documents', async () => {
    const res = await run(documentsTool, 'list_documents', alice, {});
    const ids = res.documents.map((d: Json) => d.id);
    expect(ids).toContain(aliceDocId);
    expect(ids).not.toContain(bobDocId);
  });

  test('the documents tool cannot read another user’s document, OCR text included', async () => {
    expect((await run(documentsTool, 'get_document', alice, { id: aliceDocId })).id).toBe(aliceDocId);
    expect(await run(documentsTool, 'get_document', alice, { id: bobDocId })).toEqual({ error: 'Document not found.' });
  });

  test('an admin’s agent does not inherit the admin bypass', async () => {
    expect(await run(documentsTool, 'get_document', admin, { id: bobDocId })).toEqual({ error: 'Document not found.' });
  });

  test('the documents tool searches only the user’s own chunks (and product docs)', async () => {
    const res = await run(documentsTool, 'search_documents', alice, { query: 'quokka', limit: 20 });
    const ids = res.results.map((r: Json) => r.id);
    expect(ids).toContain(aliceChunkId);
    expect(ids).not.toContain(bobChunkId);
    expect(ids).not.toContain(installChunkId);
  });

  test('the documents route answers 404 for another user’s document', async () => {
    const { documentRoutes } = await import('@/api/routes/documents');
    const app = appFor(alice, false, documentRoutes);
    expect((await request(app, 'GET', `/api/documents/${bobDocId}`)).status).toBe(404);
    const list = await request(app, 'GET', '/api/documents');
    expect(list.body.documents.map((d: Json) => d.id)).not.toContain(bobDocId);
  });

  test('the unscoped by-id read has only its system callers', () => {
    const allowed = new Set([
      'src/channels/index.ts',
      'src/core/jobs/recover.ts',
      'src/core/documents/queue.ts',
      'src/core/documents/processor.ts',
      'src/db/repositories/document-repository.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\.ts$/.test(name)) continue;
        const rel = relative(process.cwd(), path).split('\\').join('/');
        const text = readFileSync(path, 'utf8');
        if (/\bfindByIdSystem\(/.test(text) && !allowed.has(rel)) offenders.push(rel);
        // The deleted unscoped listers must not come back.
        if (/documentRepository\.(findByCategory|listRecent|findById)\(/.test(text)) offenders.push(rel);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('L2 — knowledge base routes', () => {
  let aliceApp: ElysiaLike;
  let bobApp: ElysiaLike;
  let adminApp: ElysiaLike;

  beforeAll(async () => {
    const { knowledgeRoutes } = await import('@/api/routes/knowledge');
    aliceApp = appFor(alice, false, knowledgeRoutes);
    bobApp = appFor(bob, false, knowledgeRoutes);
    adminApp = appFor(admin, true, knowledgeRoutes);
  });

  test('list shows own rows and product docs, never another user’s or install rows', async () => {
    const r = await request(aliceApp, 'GET', '/api/knowledge?limit=200');
    expect(r.status).toBe(200);
    const ids = r.body.entries.map((e: Json) => e.id);
    expect(ids).toEqual(expect.arrayContaining([aliceChunkId, productChunkId]));
    expect(ids).not.toContain(bobChunkId);
    expect(ids).not.toContain(installChunkId);
    expect(r.body.total).toBe(ids.length);
  });

  test('read and delete of another user’s entry are 404, and the row stays', async () => {
    expect((await request(aliceApp, 'GET', `/api/knowledge/${bobChunkId}`)).status).toBe(404);
    expect((await request(aliceApp, 'DELETE', `/api/knowledge/${bobChunkId}`)).status).toBe(404);
    expect((await request(bobApp, 'GET', `/api/knowledge/${bobChunkId}`)).status).toBe(200);
  });

  test('a user cannot delete product docs', async () => {
    expect((await request(aliceApp, 'GET', `/api/knowledge/${productChunkId}`)).status).toBe(200);
    expect((await request(aliceApp, 'DELETE', `/api/knowledge/${productChunkId}`)).status).toBe(404);
  });

  test('search returns no other user’s hits', async () => {
    const r = await request(aliceApp, 'POST', '/api/knowledge/search', { query: 'quokka', mode: 'keyword', limit: 20 });
    expect(r.status).toBe(200);
    const ids = r.body.results.map((h: Json) => h.id);
    expect(ids).toEqual(expect.arrayContaining([aliceChunkId, productChunkId]));
    expect(ids).not.toContain(bobChunkId);
  });

  test('stats count only what the caller can see', async () => {
    const mine = await request(aliceApp, 'GET', '/api/knowledge/stats');
    const all = await request(adminApp, 'GET', '/api/knowledge/stats?scope=install');
    expect(mine.status).toBe(200);
    expect(all.status).toBe(200);
    // alice: her chunk, her short note, the product doc.
    expect(mine.body.total).toBe(3);
    expect(all.body.total).toBeGreaterThanOrEqual(6);
  });

  test('cleanup removes the caller’s rows only, and history shows the caller’s runs only', async () => {
    const r = await request(aliceApp, 'POST', '/api/knowledge/cleanup', { minContentLength: 20 });
    expect(r.status).toBe(200);
    expect(r.body.shortEntries).toBe(1);
    expect((await request(aliceApp, 'GET', `/api/knowledge/${aliceShortChunkId}`)).status).toBe(404);
    expect((await request(bobApp, 'GET', `/api/knowledge/${bobShortChunkId}`)).status).toBe(200);

    const mine = await request(aliceApp, 'GET', '/api/knowledge/cleanup-history');
    expect(mine.body.history).toHaveLength(1);
    expect((await request(bobApp, 'GET', '/api/knowledge/cleanup-history')).body.history).toHaveLength(0);
  });

  test('install scope is refused to a non-admin', async () => {
    for (const [method, path] of [
      ['GET', '/api/knowledge?scope=install'],
      ['GET', '/api/knowledge/stats?scope=install'],
      ['GET', `/api/knowledge/${bobChunkId}?scope=install`],
      ['DELETE', `/api/knowledge/${bobChunkId}?scope=install`],
      ['GET', '/api/knowledge/cleanup-history?scope=install'],
    ] as const) {
      expect((await request(aliceApp, method, path)).status).toBe(403);
    }
    expect((await request(aliceApp, 'POST', '/api/knowledge/cleanup?scope=install', { dryRun: true })).status).toBe(403);
  });

  test('an admin sees only their own rows by default, everything with ?scope=install, and it is audited', async () => {
    expect((await request(adminApp, 'GET', `/api/knowledge/${bobChunkId}`)).status).toBe(404);

    const { auditRepository } = await import('@/db/repositories/audit-repository');
    const before = (await auditRepository.findByAction('knowledge_install_access')).length;
    const r = await request(adminApp, 'GET', `/api/knowledge/${bobChunkId}?scope=install`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(bobChunkId);
    const list = await request(adminApp, 'GET', '/api/knowledge?scope=install&limit=200');
    expect(list.body.entries.map((e: Json) => e.id)).toContain(installChunkId);

    const rows = await auditRepository.findByAction('knowledge_install_access');
    expect(rows.length).toBe(before + 2);
    expect(rows.every((row) => row.userId === admin)).toBe(true);
    expect(rows.map((row) => (row.details as { op?: string }).op)).toEqual(expect.arrayContaining(['read', 'list']));
  });
});

describe('L2 — knowledge tool', () => {
  test('search_knowledge returns no other user’s hits', async () => {
    const res = await run(knowledgeTool, 'search_knowledge', alice, { query: 'quokka', mode: 'keyword', limit: 20 });
    const ids = res.results.map((r: Json) => r.id);
    expect(ids).toContain(aliceChunkId);
    expect(ids).not.toContain(bobChunkId);
    expect(ids).not.toContain(installChunkId);
  });

  test('read_knowledge and verify_knowledge miss another user’s entry', async () => {
    expect(await run(knowledgeTool, 'read_knowledge', alice, { id: bobChunkId })).toEqual({ error: 'Knowledge entry not found.' });
    expect((await run(knowledgeTool, 'verify_knowledge', alice, { ids: [bobChunkId] })).verified).toBe(0);
    expect((await run(knowledgeTool, 'verify_knowledge', bob, { ids: [bobChunkId] })).verified).toBe(1);
  });

  test('knowledge_stats and cleanup_knowledge stay in the user’s scope', async () => {
    const bobStats = await run(knowledgeTool, 'knowledge_stats', bob, {});
    // bob: his chunk, his short note, the product doc.
    expect(bobStats.total).toBe(3);
    const dry = await run(knowledgeTool, 'cleanup_knowledge', alice, { min_content_length: 1000, dry_run: true });
    // alice's only remaining row is her long chunk; bob's rows and product docs are not counted.
    expect(dry.shortEntries).toBe(1);
  });

  test('an admin’s agent gets the personal scope too', async () => {
    expect(await run(knowledgeTool, 'read_knowledge', admin, { id: bobChunkId })).toEqual({ error: 'Knowledge entry not found.' });
  });
});

describe('L3 — global search', () => {
  test('returns only the caller’s sessions, hooks and knowledge', async () => {
    const { searchRoutes } = await import('@/api/routes/search');
    const r = await request(appFor(alice, false, searchRoutes), 'GET', '/api/search?q=zephyr&limit=20');
    const titles = r.body.results.map((h: Json) => h.title);
    expect(titles).toEqual(expect.arrayContaining(['zephyr planning alice', 'zephyr hook alice']));
    expect(titles.some((t: string) => t.includes('bob'))).toBe(false);

    const kb = await request(appFor(alice, false, searchRoutes), 'GET', '/api/search?q=quokka&limit=20');
    const ids = kb.body.results.filter((h: Json) => h.type === 'knowledge').map((h: Json) => h.id);
    expect(ids).toContain(aliceChunkId);
    expect(ids).not.toContain(bobChunkId);
  });

  test('returns system skills and the caller’s own, never another user’s private skill', async () => {
    const { searchRoutes } = await import('@/api/routes/search');
    const r = await request(appFor(alice, false, searchRoutes), 'GET', '/api/search?q=zephyr%20deploy&limit=20');
    const skillIds = r.body.results.filter((h: Json) => h.type === 'skill').map((h: Json) => h.id).sort();
    expect(skillIds).toEqual(['zephyr-alice', 'zephyr-system']);

    // Description matches go through the same gate.
    const byDescription = await request(appFor(alice, false, searchRoutes), 'GET', '/api/search?q=bob%20private&limit=20');
    expect(byDescription.body.results.filter((h: Json) => h.type === 'skill')).toEqual([]);

    // An admin is no exception.
    const asAdmin = await request(appFor(admin, true, searchRoutes), 'GET', '/api/search?q=zephyr%20deploy&limit=20');
    expect(asAdmin.body.results.filter((h: Json) => h.type === 'skill').map((h: Json) => h.id)).toEqual(['zephyr-system']);
  });

  test('an admin’s search is not install-wide either', async () => {
    const { searchRoutes } = await import('@/api/routes/search');
    const r = await request(appFor(admin, true, searchRoutes), 'GET', '/api/search?q=zephyr&limit=20');
    expect(r.body.results.filter((h: Json) => h.type === 'session' || h.type === 'hook')).toEqual([]);
  });
});
