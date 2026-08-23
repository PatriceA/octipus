import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import { artifactDataSnapshots } from '@/db/schema/artifact-data-snapshots';
import { artifactDataSources } from '@/db/schema/artifact-data-sources';
import { artifactShareLinks } from '@/db/schema/artifact-share-links';
import { artifactVersions } from '@/db/schema/artifact-versions';
import { artifacts } from '@/db/schema/artifacts';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import type { ArtifactsRepository } from './artifacts-repository';

describe.skipIf(!isIntegration)('ArtifactsRepository (Integration)', () => {
  let repo: ArtifactsRepository;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    await setupIntegrationDb();
    const mod = await import('./artifacts-repository');
    repo = new mod.ArtifactsRepository();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables([
      'artifact_share_links',
      'artifact_data_snapshots',
      'artifact_data_sources',
      'artifact_versions',
      'artifacts',
      'workspaces',
      'users',
    ]);
    const db = getDb();
    const u = await db
      .insert(users)
      .values({ username: `u_${randomUUID().slice(0, 8)}` })
      .returning();
    userId = u[0].id;
    const w = await db
      .insert(workspaces)
      .values({ userId, slug: 'default', name: 'Default' })
      .returning();
    workspaceId = w[0].id;
  });

  test('create + getById', async () => {
    const a = await repo.create({
      slug: 'my-dash',
      workspaceId,
      createdByUserId: userId,
      title: 'My Dashboard',
      type: 'dashboard',
    });
    expect(a.id).toBeDefined();
    const found = await repo.getById(a.id);
    expect(found?.title).toBe('My Dashboard');
  });

  test('getBySlug scoped per workspace', async () => {
    await repo.create({
      slug: 'shared',
      workspaceId,
      createdByUserId: userId,
      title: 'A',
      type: 'dashboard',
    });

    const db = getDb();
    const w2 = await db
      .insert(workspaces)
      .values({ userId, slug: 'other', name: 'Other' })
      .returning();
    await repo.create({
      slug: 'shared',
      workspaceId: w2[0].id,
      createdByUserId: userId,
      title: 'B',
      type: 'dashboard',
    });

    const a = await repo.getBySlug(workspaceId, 'shared');
    const b = await repo.getBySlug(w2[0].id, 'shared');
    expect(a?.title).toBe('A');
    expect(b?.title).toBe('B');
  });

  test('softDelete hides from getById', async () => {
    const a = await repo.create({
      slug: 's',
      workspaceId,
      createdByUserId: userId,
      title: 'T',
      type: 'dashboard',
    });
    await repo.softDelete(a.id);
    expect(await repo.getById(a.id)).toBeNull();
  });

  test('cascade: deleting artifact removes versions/sources/snapshots/share-links', async () => {
    const a = await repo.create({
      slug: 'c',
      workspaceId,
      createdByUserId: userId,
      title: 'T',
      type: 'dashboard',
    });
    const v = await repo.createVersion({ artifactId: a.id, htmlTemplate: '<div></div>' });
    await repo.setCurrentVersion(a.id, v.id);
    const s = await repo.createSource({
      artifactId: a.id,
      name: 'src1',
      kind: 'rss',
      configJson: { url: 'https://x' },
      principalId: userId,
    });
    await repo.createSnapshot({ sourceId: s.id, payloadJson: { items: [] } });
    await repo.createShareLink({
      artifactId: a.id,
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60_000),
      createdByUserId: userId,
    });

    const db = getDb();
    await db.delete(artifacts).where(eq(artifacts.id, a.id));

    expect((await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, a.id))).length).toBe(0);
    expect((await db.select().from(artifactDataSources).where(eq(artifactDataSources.artifactId, a.id))).length).toBe(0);
    expect((await db.select().from(artifactDataSnapshots).where(eq(artifactDataSnapshots.sourceId, s.id))).length).toBe(0);
    expect((await db.select().from(artifactShareLinks).where(eq(artifactShareLinks.artifactId, a.id))).length).toBe(0);
  });

  test('pruneSnapshots keeps newest N', async () => {
    const a = await repo.create({
      slug: 'p',
      workspaceId,
      createdByUserId: userId,
      title: 'T',
      type: 'dashboard',
    });
    const s = await repo.createSource({
      artifactId: a.id,
      name: 'src',
      kind: 'tool',
      configJson: {},
      principalId: userId,
    });
    for (let i = 0; i < 10; i++) {
      await repo.createSnapshot({ sourceId: s.id, payloadJson: { i } });
    }
    const deleted = await repo.pruneSnapshots(s.id, 3);
    expect(deleted).toBe(7);
    const remaining = await getDb()
      .select()
      .from(artifactDataSnapshots)
      .where(eq(artifactDataSnapshots.sourceId, s.id));
    expect(remaining.length).toBe(3);
  });

  test('share link revoke + lookup by hash', async () => {
    const a = await repo.create({
      slug: 'sl',
      workspaceId,
      createdByUserId: userId,
      title: 'T',
      type: 'dashboard',
    });
    const link = await repo.createShareLink({
      artifactId: a.id,
      tokenHash: 'abc123',
      expiresAt: new Date(Date.now() + 60_000),
      createdByUserId: userId,
    });
    expect((await repo.findShareLinkByHash('abc123'))?.id).toBe(link.id);
    await repo.revokeShareLink(link.id);
    expect((await repo.findShareLinkByHash('abc123'))?.revokedAt).not.toBeNull();
  });
});
