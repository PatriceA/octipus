/**
 * The hourly artifact cleanup (`runArtifactCleanup`) over embedded PGlite:
 * retention is off unless configured, an inactive artifact goes to the trash
 * first (never straight to deletion), and the trash is emptied after
 * `artifacts.trashDays` with every version, snapshot, share link and bundle
 * file of the artifact.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const policy = vi.hoisted(() => ({ retentionDays: 0, trashDays: 30 }));
vi.mock('@/core/artifacts/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/artifacts/settings')>();
  return { ...actual, resolveArtifactRetention: () => ({ ...policy }) };
});

const DAY = 24 * 60 * 60 * 1000;
const userId = randomUUID();
type App = { handle(request: Request): Promise<Response> };
let app: App;
let token: string;

afterEach(() => {
  policy.retentionDays = 0;
  policy.trashDays = 30;
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-artifact-cleanup-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'cleanup-user' }]);
  const { getSessionManager } = await import('@/security/auth/session');
  token = (await getSessionManager().create(userId)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

/** An artifact with a built bundle, a data source and a share link, last active `ageDays` ago. */
async function seed(slug: string, ageDays: number): Promise<{ id: string; versionId: string; sourceId: string }> {
  const res = await call('POST', '/api/artifacts', {
    slug,
    title: slug,
    type: 'html',
    htmlTemplate: '<button onclick="go()">x</button><script>function go(){ document.title = "y"; }</script>',
  });
  expect(res.status).toBe(201);
  const { artifact } = await res.json();
  expect((await call('POST', `/api/artifacts/${artifact.id}/share-links`, { ttlSeconds: 3600 })).status).toBe(201);
  const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
  const source = await artifactsRepository.createSource({ artifactId: artifact.id, name: 'feed', kind: 'http', configJson: { url: 'https://example.invalid' }, refreshSeconds: 300, principalId: userId });
  await artifactsRepository.createSnapshot({ sourceId: source.id, payloadJson: { n: 1 }, capturedAt: new Date(Date.now() - ageDays * DAY) });
  await setTimes(artifact.id, { updatedAt: new Date(Date.now() - ageDays * DAY) });
  return { id: artifact.id, versionId: artifact.currentVersionId, sourceId: source.id };
}

async function setTimes(id: string, patch: { updatedAt?: Date; deletedAt?: Date }): Promise<void> {
  const { getDb } = await import('@/db/postgres');
  const { artifacts } = await import('@/db/schema/artifacts');
  const { eq } = await import('drizzle-orm');
  await getDb().update(artifacts).set(patch).where(eq(artifacts.id, id));
}

async function row(id: string) {
  const { getDb } = await import('@/db/postgres');
  const { artifacts } = await import('@/db/schema/artifacts');
  const { eq } = await import('drizzle-orm');
  const [r] = await getDb().select().from(artifacts).where(eq(artifacts.id, id));
  return r ?? null;
}

async function hasBundle(artifactId: string, versionId: string): Promise<boolean> {
  const { bundleFilePath } = await import('@/core/artifacts/bundler');
  return existsSync(bundleFilePath(artifactId, versionId));
}

describe('artifact retention and garbage collection', () => {
  test('by default nothing expires, however old: only the trash is emptied', async () => {
    const ancient = await seed('ancient', 3_000);
    const { runArtifactCleanup } = await import('./cleanup');
    const report = await runArtifactCleanup();
    expect(report.expiredArtifacts).toBe(0);
    expect((await row(ancient.id))?.deletedAt).toBeNull();
  });

  test('with a retention policy an inactive artifact goes to the trash, not straight to deletion', async () => {
    const stale = await seed('stale', 100);
    const fresh = await seed('fresh', 10);
    // Not edited for 100 days, but its data refreshed yesterday (someone views it).
    const watched = await seed('watched', 100);
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    await artifactsRepository.createSnapshot({ sourceId: watched.sourceId, payloadJson: { n: 2 } });

    policy.retentionDays = 90;
    const { runArtifactCleanup } = await import('./cleanup');
    const report = await runArtifactCleanup();
    // `ancient` from the first test is inactive too.
    expect(report.expiredArtifacts).toBe(2);
    const trashed = await row(stale.id);
    expect(trashed?.deletedAt).toBeInstanceOf(Date);
    // Still there: versions and bundle kept until the trash window passes.
    expect(await artifactsRepository.getVersion(stale.versionId)).not.toBeNull();
    expect(await hasBundle(stale.id, stale.versionId)).toBe(true);
    expect((await row(fresh.id))?.deletedAt).toBeNull();
    expect((await row(watched.id))?.deletedAt).toBeNull();
    // Gone from the owner's list and pages at once.
    const list = await (await call('GET', '/api/artifacts')).json();
    expect(list.artifacts.map((a: { slug: string }) => a.slug)).not.toContain('stale');
    expect((await call('GET', '/__artifacts__/a/stale/embed')).status).toBe(404);
  });

  test('the trash is emptied after trashDays, with versions, data, share links and bundle files', async () => {
    const old = await seed('old-trash', 1);
    const recent = await seed('recent-trash', 1);
    await setTimes(old.id, { deletedAt: new Date(Date.now() - 8 * DAY) });
    await setTimes(recent.id, { deletedAt: new Date(Date.now() - 2 * DAY) });
    expect(await hasBundle(old.id, old.versionId)).toBe(true);

    policy.trashDays = 7;
    const { runArtifactCleanup } = await import('./cleanup');
    const report = await runArtifactCleanup();
    expect(report.purgedArtifacts).toBeGreaterThanOrEqual(1);
    expect(await row(old.id)).toBeNull();
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    expect(await artifactsRepository.getVersion(old.versionId)).toBeNull();
    expect(await artifactsRepository.getSource(old.sourceId)).toBeNull();
    expect(await artifactsRepository.listShareLinks(old.id)).toEqual([]);
    expect(await hasBundle(old.id, old.versionId)).toBe(false);
    // Inside its window: kept.
    expect(await row(recent.id)).not.toBeNull();
    expect(await hasBundle(recent.id, recent.versionId)).toBe(true);
  });

  test('the default trash window is the 30 days it always was', async () => {
    const day29 = await seed('day-29', 1);
    const day31 = await seed('day-31', 1);
    await setTimes(day29.id, { deletedAt: new Date(Date.now() - 29 * DAY) });
    await setTimes(day31.id, { deletedAt: new Date(Date.now() - 31 * DAY) });
    const { runArtifactCleanup } = await import('./cleanup');
    await runArtifactCleanup();
    expect(await row(day29.id)).not.toBeNull();
    expect(await row(day31.id)).toBeNull();
  });
});
