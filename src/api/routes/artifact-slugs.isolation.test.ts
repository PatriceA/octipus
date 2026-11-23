/**
 * Slug collisions (`core/artifacts/slug.ts`) through the REST API and the
 * agent tool over embedded PGlite: a taken slug is a typed 409 that offers a
 * free slug, concurrent creates are decided by the unique index (one wins,
 * the rest get the same 409, none a 500), a deleted artifact frees its slug,
 * and a slug another workspace already has public cannot be published again.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

vi.mock('@/security/permissions', () => ({
  getPermissionManager: () => ({
    onRequest: () => () => {},
    onResolved: () => () => {},
    check: async () => ({ level: 'ALLOW', source: 'policy' }),
  }),
}));

const alice = randomUUID();
const bob = randomUUID();
type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};

function call(user: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[user]}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}
const create = (user: string, slug: string, visibility = 'workspace') =>
  call(user, 'POST', '/api/artifacts', { slug, title: slug, type: 'html', visibility });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-artifact-slugs-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'slug-alice' }, { id: bob, username: 'slug-bob' }]);
  const { getSessionManager } = await import('@/security/auth/session');
  tokens.alice = (await getSessionManager().create(alice)).token;
  tokens.bob = (await getSessionManager().create(bob)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

describe('slug collisions in a workspace', () => {
  test('a taken slug is a typed 409 that offers the first free suffix', async () => {
    expect((await create('alice', 'report')).status).toBe(201);
    const second = await create('alice', 'report');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: 'slug "report" is already used in this workspace',
      code: 'slug_taken',
      slug: 'report',
      suggestedSlug: 'report-2',
    });
    expect((await create('alice', 'report-2')).status).toBe(201);
    expect((await (await create('alice', 'report')).json()).suggestedSlug).toBe('report-3');
    // Asking with a suffixed slug suggests from its base.
    expect((await (await create('alice', 'report-2')).json()).suggestedSlug).toBe('report-3');
    // Another workspace may use the same (non-public) slug.
    expect((await create('bob', 'report')).status).toBe(201);
  });

  test('a suggestion fits the 64-character limit', async () => {
    const long = 'a'.repeat(64);
    expect((await create('alice', long)).status).toBe(201);
    const body = await (await create('alice', long)).json();
    expect(body.suggestedSlug).toBe(`${'a'.repeat(62)}-2`);
  });

  test('concurrent creates of one slug: one wins, the others get the same 409, never a 500', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => create('alice', 'race')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect((await r.json()).code).toBe('slug_taken');
  });

  test('a deleted artifact frees its slug', async () => {
    const first = await (await create('alice', 'reused')).json();
    expect((await call('alice', 'DELETE', `/api/artifacts/${first.artifact.id}`)).status).toBe(200);
    const again = await create('alice', 'reused');
    expect(again.status).toBe(201);
    expect((await again.json()).artifact.id).not.toBe(first.artifact.id);
  });
});

describe('public slugs across workspaces', () => {
  test('a slug another workspace has public cannot be published again; the first keeps the link', async () => {
    const bobs = await (await create('bob', 'news', 'public')).json();
    const refused = await create('alice', 'news', 'public');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'public_slug_taken', slug: 'news', suggestedSlug: 'news-2' });

    // Non-public it is fine (its link is the in-app one); publishing it is not.
    const alices = await (await create('alice', 'news')).json();
    const publish = await call('alice', 'PUT', `/api/artifacts/${alices.artifact.id}`, { visibility: 'public' });
    expect(publish.status).toBe(409);
    expect((await publish.json()).code).toBe('public_slug_taken');

    const page = await app.handle(new Request('http://localhost/__artifacts__/a/news/embed'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`content="${bobs.artifact.id}"`);
  });

  test('two public artifacts with one slug (published before the check existed) resolve to the oldest', async () => {
    const older = await (await create('bob', 'legacy', 'public')).json();
    const newer = await (await create('alice', 'legacy')).json();
    // Written straight to the database, as an earlier release could have.
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    await artifactsRepository.update(newer.artifact.id, { visibility: 'public' });
    const found = await artifactsRepository.findPublicBySlug('legacy');
    expect(found?.id).toBe(older.artifact.id);
  });
});

describe('the agent tool reports the same conflicts', () => {
  async function tools() {
    const { ArtifactsTool } = await import('@/tools/artifacts');
    const tool = new ArtifactsTool();
    await tool.initialize();
    return new Map(tool.getToolHandlers().map((h) => [h.name.replace('artifacts__', ''), h]));
  }
  const ctx = (workspaceId: string): AgentContext => ({
    space: null, trigger: 'user', funding: 'own', id: randomUUID(), sessionId: randomUUID(), userId: alice, workspaceId,
    topic: 'test', model: 'test', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
  });

  test('create_live_artifact on a taken slug names the slug and a free one to retry with', async () => {
    const existing = await (await create('alice', 'tool-board')).json();
    const handlers = await tools();
    const result = await handlers.get('create_live_artifact')!.execute(
      { slug: 'tool-board', title: 'Board', type: 'html' },
      ctx(existing.artifact.workspaceId),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ code: 'slug_taken', slug: 'tool-board', suggested_slug: 'tool-board-2' });
    expect(result.error).toMatch(/Retry with slug "tool-board-2"/);

    const retried = await handlers.get('create_live_artifact')!.execute(
      { slug: result.suggested_slug, title: 'Board', type: 'html' },
      ctx(existing.artifact.workspaceId),
    ) as Record<string, unknown>;
    expect(retried.slug).toBe('tool-board-2');
  });

  test('create_live_artifact and update_live_artifact refuse a slug public elsewhere', async () => {
    const mine = await (await create('alice', 'tool-mine')).json();
    const handlers = await tools();
    const created = await handlers.get('create_live_artifact')!.execute(
      { slug: 'news', title: 'News', type: 'html', visibility: 'public' },
      ctx(mine.artifact.workspaceId),
    ) as Record<string, unknown>;
    expect(created).toMatchObject({ code: 'public_slug_taken', suggested_slug: 'news-2' });

    const alicesNews = (await (await call('alice', 'GET', '/api/artifacts')).json()).artifacts.find((a: { slug: string }) => a.slug === 'news');
    const updated = await handlers.get('update_live_artifact')!.execute(
      { id: alicesNews.id, visibility: 'public' },
      ctx(mine.artifact.workspaceId),
    ) as Record<string, unknown>;
    expect(updated).toMatchObject({ code: 'public_slug_taken', slug: 'news' });
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    expect((await artifactsRepository.getById(alicesNews.id))?.visibility).toBe('workspace');
  });
});
