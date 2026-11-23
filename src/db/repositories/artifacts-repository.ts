import { assertNoCredentialTemplates } from '@/security/credential-boundary';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { revokeArtifactViewers } from '@/core/artifacts/viewer-access';
import { getDb } from '../postgres';
import { workspaces } from '../schema/organizations';
import {
  type Artifact,
  artifacts,
  type NewArtifact,
} from '../schema/artifacts';
import {
  type ArtifactVersion,
  artifactVersions,
  type NewArtifactVersion,
} from '../schema/artifact-versions';
import {
  type ArtifactDataSource,
  artifactDataSources,
  type NewArtifactDataSource,
} from '../schema/artifact-data-sources';
import {
  type ArtifactDataSnapshot,
  artifactDataSnapshots,
  type NewArtifactDataSnapshot,
} from '../schema/artifact-data-snapshots';
import {
  type ArtifactShareLink,
  artifactShareLinks,
  type NewArtifactShareLink,
} from '../schema/artifact-share-links';
import {
  type ArtifactTransform,
  artifactTransforms,
  type NewArtifactTransform,
} from '../schema/artifact-transforms';
import {
  type ArtifactWidget,
  artifactWidgets,
  type NewArtifactWidget,
} from '../schema/artifact-widgets';
import {
  type ArtifactExport,
  artifactExports,
  type NewArtifactExport,
} from '../schema/artifact-exports';

export class ArtifactsRepository {
  private get db() {
    return getDb();
  }

  // ── artifacts ────────────────────────────────────────────────
  async create(record: NewArtifact): Promise<Artifact> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifacts).values(record).returning();
    return result[0];
  }

  async getById(id: string): Promise<Artifact | null> {
    const result = await this.db
      .select()
      // i2: by id, for the artifact runtime that already resolved access (ArtifactStore / share link)
      .from(artifacts)
      .where(and(eq(artifacts.id, id), isNull(artifacts.deletedAt)))
      .limit(1);
    return result[0] ?? null;
  }

  /**
   * The live public artifact with this slug, in whichever workspace (slugs
   * are unique per workspace only). Publishing refuses a slug another
   * workspace already has public (`publicSlugConflict`); should two exist all
   * the same (published concurrently, or before that check), the oldest
   * keeps the link, never whichever row the database happens to return.
   */
  async findPublicBySlug(slug: string): Promise<Artifact | null> {
    const result = await this.db
      .select()
      // i2: public artifacts only, the visibility is the access rule
      .from(artifacts)
      .where(and(eq(artifacts.slug, slug), eq(artifacts.visibility, 'public'), isNull(artifacts.deletedAt)))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .limit(1);
    return result[0] ?? null;
  }

  /** Whether a live public artifact of another workspace than `workspaceId` holds this slug. */
  async publicSlugHeldElsewhere(slug: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .select({ id: artifacts.id })
      // i2: public artifacts only, ids only
      .from(artifacts)
      .where(and(
        eq(artifacts.slug, slug),
        eq(artifacts.visibility, 'public'),
        isNull(artifacts.deletedAt),
        ne(artifacts.workspaceId, workspaceId),
      ))
      .limit(1);
    return result.length > 0;
  }

  /** The live slugs of a workspace that are `base` or start with `base-` (a slug never holds `%` or `_`). */
  async slugsWithBase(workspaceId: string, base: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: artifacts.slug })
      // i2: by workspace id the caller resolved, slugs only
      .from(artifacts)
      .where(and(
        eq(artifacts.workspaceId, workspaceId),
        isNull(artifacts.deletedAt),
        or(eq(artifacts.slug, base), like(artifacts.slug, base + '-%')),
      ));
    return rows.map((r) => r.slug);
  }

  async getBySlug(workspaceId: string, slug: string): Promise<Artifact | null> {
    const result = await this.db
      .select()
      // i2: by workspace id and slug, the caller names the workspace it resolved
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, workspaceId),
          eq(artifacts.slug, slug),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1);
    return result[0] ?? null;
  }

  async listByWorkspace(workspaceId: string, limit = 200): Promise<Artifact[]> {
    return this.db
      .select()
      // i2: by workspace id the caller resolved
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), isNull(artifacts.deletedAt)))
      .orderBy(desc(artifacts.updatedAt))
      .limit(limit);
  }

  /**
   * A visibility change ends the live embed viewers of the artifact
   * (`revokeArtifactViewers`): their tokens were minted under the old one.
   */
  async update(id: string, patch: Partial<NewArtifact>): Promise<void> {
    assertNoCredentialTemplates(patch);
    const before = patch.visibility !== undefined ? await this.getById(id) : null;
    await this.db
      .update(artifacts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(artifacts.id, id));
    if (before && before.visibility !== patch.visibility) {
      await revokeArtifactViewers(id, 'Artifact visibility changed');
    }
  }

  async setCurrentVersion(id: string, versionId: string): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(artifacts.id, id));
  }

  /**
   * Point a live artifact at `versionId` only while its current version is
   * still `expected` (null: it has none). False when the artifact was edited,
   * restored or deleted meanwhile — the caller's version is then not shown.
   * `updatedAt` is left alone: this is an agent refresh, not a person's edit,
   * and retention must not count it as activity (docs/ARTIFACTS.md).
   */
  async setCurrentVersionIf(id: string, expected: string | null, versionId: string): Promise<boolean> {
    const rows = await this.db
      .update(artifacts)
      .set({ currentVersionId: versionId })
      .where(and(
        eq(artifacts.id, id),
        isNull(artifacts.deletedAt),
        expected === null ? isNull(artifacts.currentVersionId) : eq(artifacts.currentVersionId, expected),
      ))
      .returning({ id: artifacts.id });
    return rows.length > 0;
  }

  /** Remove a version that never became current (a refresh that did not land). */
  async deleteVersion(id: string): Promise<void> {
    await this.db.delete(artifactVersions).where(eq(artifactVersions.id, id));
  }

  /**
   * Keep the newest `keep` versions of `artifactId` whose `schemaJson` is
   * `marker` (an agent refresh's) and delete the older ones — never the
   * current version, never a version a person wrote. Returns how many went.
   */
  async pruneMarkedVersions(artifactId: string, marker: string, keep: number): Promise<number> {
    const marked = await this.db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.schemaJson, marker)))
      .orderBy(desc(artifactVersions.createdAt))
      .offset(keep);
    if (marked.length === 0) return 0;
    const current = (await this.getById(artifactId))?.currentVersionId ?? null;
    const ids = marked.map((v) => v.id).filter((v) => v !== current);
    if (ids.length === 0) return 0;
    const removed = await this.db.delete(artifactVersions).where(inArray(artifactVersions.id, ids)).returning({ id: artifactVersions.id });
    return removed.length;
  }

  /** Also ends the artifact's live embed viewers. */
  async softDelete(id: string): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, id));
    await revokeArtifactViewers(id, 'Artifact deleted');
  }

  // ── versions ─────────────────────────────────────────────────
  async createVersion(record: NewArtifactVersion): Promise<ArtifactVersion> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactVersions).values(record).returning();
    return result[0];
  }

  async getVersion(id: string): Promise<ArtifactVersion | null> {
    const result = await this.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async listVersions(artifactId: string, limit = 100): Promise<ArtifactVersion[]> {
    return this.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId))
      .orderBy(desc(artifactVersions.createdAt))
      .limit(limit);
  }

  // ── sources ──────────────────────────────────────────────────
  async createSource(record: NewArtifactDataSource): Promise<ArtifactDataSource> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactDataSources).values(record).returning();
    return result[0];
  }

  async getSource(id: string): Promise<ArtifactDataSource | null> {
    const result = await this.db
      .select()
      .from(artifactDataSources)
      .where(eq(artifactDataSources.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async getSourceByName(artifactId: string, name: string): Promise<ArtifactDataSource | null> {
    const result = await this.db
      .select()
      .from(artifactDataSources)
      .where(
        and(eq(artifactDataSources.artifactId, artifactId), eq(artifactDataSources.name, name)),
      )
      .limit(1);
    return result[0] ?? null;
  }

  async listSources(artifactId: string): Promise<ArtifactDataSource[]> {
    return this.db
      .select()
      .from(artifactDataSources)
      .where(eq(artifactDataSources.artifactId, artifactId));
  }

  async updateSourceStatus(
    id: string,
    update: { status: 'ok' | 'error' | 'pending'; error?: string | null },
  ): Promise<void> {
    await this.db
      .update(artifactDataSources)
      .set({
        lastStatus: update.status,
        lastError: update.error ?? null,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(artifactDataSources.id, id));
  }

  /** Whether the source's artifact belongs to an archived shared workspace. */
  async isSourceInArchivedSpace(sourceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: artifactDataSources.id })
      .from(artifactDataSources)
      // i2: a data source's space, for the refresh scheduler
      .innerJoin(artifacts, eq(artifacts.id, artifactDataSources.artifactId))
      .innerJoin(workspaces, eq(workspaces.id, artifacts.workspaceId))
      .where(and(eq(artifactDataSources.id, sourceId), eq(workspaces.kind, 'shared'), isNotNull(workspaces.archivedAt)))
      .limit(1);
    return row !== undefined;
  }

  /** The shared workspace (space) the source's artifact belongs to; null for a personal artifact. */
  async spaceOfSource(sourceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(artifactDataSources)
      // i2: a data source's space, for the refresh scheduler
      .innerJoin(artifacts, eq(artifacts.id, artifactDataSources.artifactId))
      .innerJoin(workspaces, eq(workspaces.id, artifacts.workspaceId))
      .where(and(eq(artifactDataSources.id, sourceId), eq(workspaces.kind, 'shared')))
      .limit(1);
    return row?.id ?? null;
  }

  async deleteSource(id: string): Promise<void> {
    await this.db.delete(artifactDataSources).where(eq(artifactDataSources.id, id));
  }

  // ── snapshots ────────────────────────────────────────────────
  async createSnapshot(record: NewArtifactDataSnapshot): Promise<ArtifactDataSnapshot> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactDataSnapshots).values(record).returning();
    return result[0];
  }

  async getLatestSnapshot(sourceId: string): Promise<ArtifactDataSnapshot | null> {
    const result = await this.db
      .select()
      .from(artifactDataSnapshots)
      .where(eq(artifactDataSnapshots.sourceId, sourceId))
      .orderBy(desc(artifactDataSnapshots.capturedAt))
      .limit(1);
    return result[0] ?? null;
  }

  /** Latest N snapshots, newest first. Used by diff-style transforms. */
  async getRecentSnapshots(sourceId: string, n: number): Promise<ArtifactDataSnapshot[]> {
    return this.db
      .select()
      .from(artifactDataSnapshots)
      .where(eq(artifactDataSnapshots.sourceId, sourceId))
      .orderBy(desc(artifactDataSnapshots.capturedAt))
      .limit(n);
  }

  /** Delete snapshots beyond `keep` newest per source. Returns deleted count. */
  async pruneSnapshots(sourceId: string, keep: number): Promise<number> {
    const all = await this.db
      .select({ id: artifactDataSnapshots.id })
      .from(artifactDataSnapshots)
      .where(eq(artifactDataSnapshots.sourceId, sourceId))
      .orderBy(desc(artifactDataSnapshots.capturedAt));

    const toDelete = all.slice(keep).map((r) => r.id);
    if (toDelete.length === 0) return 0;

    await this.db
      .delete(artifactDataSnapshots)
      .where(inArray(artifactDataSnapshots.id, toDelete));
    return toDelete.length;
  }

  // ── share links ──────────────────────────────────────────────
  async createShareLink(record: NewArtifactShareLink): Promise<ArtifactShareLink> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactShareLinks).values(record).returning();
    return result[0];
  }

  async findShareLinkByHash(tokenHash: string): Promise<ArtifactShareLink | null> {
    const result = await this.db
      .select()
      .from(artifactShareLinks)
      .where(eq(artifactShareLinks.tokenHash, tokenHash))
      .limit(1);
    return result[0] ?? null;
  }

  async listShareLinks(artifactId: string): Promise<ArtifactShareLink[]> {
    return this.db
      .select()
      .from(artifactShareLinks)
      .where(eq(artifactShareLinks.artifactId, artifactId))
      .orderBy(desc(artifactShareLinks.createdAt));
  }

  async getShareLink(id: string): Promise<ArtifactShareLink | null> {
    const result = await this.db
      .select()
      .from(artifactShareLinks)
      .where(eq(artifactShareLinks.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  /**
   * Also ends the artifact's live embed viewers: a page opened through the
   * link holds a viewer token minted from it. Viewers who reach the artifact
   * another way reload and get a fresh token.
   */
  async revokeShareLink(id: string): Promise<void> {
    const [revoked] = await this.db
      .update(artifactShareLinks)
      .set({ revokedAt: new Date() })
      .where(eq(artifactShareLinks.id, id))
      .returning({ artifactId: artifactShareLinks.artifactId });
    if (revoked) await revokeArtifactViewers(revoked.artifactId, 'Share link revoked');
  }

  async deleteExpiredShareLinks(now: Date): Promise<number> {
    const result = await this.db
      .delete(artifactShareLinks)
      .where(lt(artifactShareLinks.expiresAt, now))
      .returning({ id: artifactShareLinks.id });
    return result.length;
  }

  // ── transforms ───────────────────────────────────────────────
  async createTransform(record: NewArtifactTransform): Promise<ArtifactTransform> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactTransforms).values(record).returning();
    return result[0];
  }

  async listTransforms(artifactId: string): Promise<ArtifactTransform[]> {
    return this.db
      .select()
      .from(artifactTransforms)
      .where(eq(artifactTransforms.artifactId, artifactId))
      .orderBy(artifactTransforms.position, artifactTransforms.createdAt);
  }

  async deleteTransform(id: string): Promise<void> {
    await this.db.delete(artifactTransforms).where(eq(artifactTransforms.id, id));
  }

  async deleteTransformByName(artifactId: string, name: string): Promise<void> {
    await this.db
      .delete(artifactTransforms)
      .where(and(eq(artifactTransforms.artifactId, artifactId), eq(artifactTransforms.name, name)));
  }

  // ── widgets ──────────────────────────────────────────────────
  async createWidget(record: NewArtifactWidget): Promise<ArtifactWidget> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactWidgets).values(record).returning();
    return result[0];
  }

  async listWidgets(artifactId: string): Promise<ArtifactWidget[]> {
    return this.db
      .select()
      .from(artifactWidgets)
      .where(eq(artifactWidgets.artifactId, artifactId))
      .orderBy(artifactWidgets.position, artifactWidgets.createdAt);
  }

  async deleteWidget(id: string): Promise<void> {
    await this.db.delete(artifactWidgets).where(eq(artifactWidgets.id, id));
  }

  async deleteWidgetBySlot(artifactId: string, slot: string): Promise<void> {
    await this.db
      .delete(artifactWidgets)
      .where(and(eq(artifactWidgets.artifactId, artifactId), eq(artifactWidgets.slot, slot)));
  }

  // ── exports ──────────────────────────────────────────────────
  async createExport(record: NewArtifactExport): Promise<ArtifactExport> {
    assertNoCredentialTemplates(record);
    const result = await this.db.insert(artifactExports).values(record).returning();
    return result[0];
  }

  async listExports(artifactId: string): Promise<ArtifactExport[]> {
    return this.db
      .select()
      .from(artifactExports)
      .where(eq(artifactExports.artifactId, artifactId))
      .orderBy(artifactExports.createdAt);
  }

  async getExportByPublicId(artifactId: string, exportId: string): Promise<ArtifactExport | null> {
    const result = await this.db
      .select()
      .from(artifactExports)
      .where(and(eq(artifactExports.artifactId, artifactId), eq(artifactExports.exportId, exportId)))
      .limit(1);
    return result[0] ?? null;
  }

  async deleteExportByPublicId(artifactId: string, exportId: string): Promise<void> {
    await this.db
      .delete(artifactExports)
      .where(and(eq(artifactExports.artifactId, artifactId), eq(artifactExports.exportId, exportId)));
  }

  // ── retention ────────────────────────────────────────────────
  /**
   * Record a view: sets `last_viewed_at` unless it is already newer than
   * `unlessAfter` (the caller's throttle, so a busy artifact is not written on
   * every render). Leaves `updated_at` alone: a view is not an edit.
   */
  async markViewed(id: string, now: Date, unlessAfter: Date): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ lastViewedAt: now })
      .where(and(eq(artifacts.id, id), or(isNull(artifacts.lastViewedAt), lt(artifacts.lastViewedAt, unlessAfter))));
  }

  /**
   * Live artifacts with no activity since `cutoff`: not edited (`updated_at`,
   * which a version or settings change bumps), not viewed (`last_viewed_at`)
   * and no snapshot captured (a refresh, or a manual one). Oldest first, at
   * most `limit`.
   */
  async listInactiveSince(cutoff: Date, limit: number): Promise<Array<Pick<Artifact, 'id' | 'workspaceId' | 'slug' | 'updatedAt'>>> {
    const recentSnapshot = this.db
      .select({ one: sql`1` })
      .from(artifactDataSnapshots)
      .innerJoin(artifactDataSources, eq(artifactDataSources.id, artifactDataSnapshots.sourceId))
      .where(and(eq(artifactDataSources.artifactId, artifacts.id), gte(artifactDataSnapshots.capturedAt, cutoff)));
    return this.db
      .select({ id: artifacts.id, workspaceId: artifacts.workspaceId, slug: artifacts.slug, updatedAt: artifacts.updatedAt })
      // i2: retention sweep across workspaces, ids only
      .from(artifacts)
      .where(and(
        isNull(artifacts.deletedAt),
        lt(artifacts.updatedAt, cutoff),
        or(isNull(artifacts.lastViewedAt), lt(artifacts.lastViewedAt, cutoff)),
        notExists(recentSnapshot),
      ))
      .orderBy(asc(artifacts.updatedAt))
      .limit(limit);
  }

  // ── soft-delete cleanup ──────────────────────────────────────
  /** Returns the ids purged — the caller also has on-disk bundles to drop. */
  async purgeSoftDeleted(olderThan: Date): Promise<string[]> {
    const result = await this.db
      .delete(artifacts)
      .where(and(lt(artifacts.deletedAt, olderThan)))
      .returning({ id: artifacts.id });
    return result.map((r) => r.id);
  }
}

export const artifactsRepository = new ArtifactsRepository();
