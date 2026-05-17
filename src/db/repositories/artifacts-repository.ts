import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
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

export class ArtifactsRepository {
  private get db() {
    return getDb();
  }

  // ── artifacts ────────────────────────────────────────────────
  async create(record: NewArtifact): Promise<Artifact> {
    const result = await this.db.insert(artifacts).values(record).returning();
    return result[0];
  }

  async getById(id: string): Promise<Artifact | null> {
    const result = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, id), isNull(artifacts.deletedAt)))
      .limit(1);
    return result[0] ?? null;
  }

  async getBySlug(workspaceId: string, slug: string): Promise<Artifact | null> {
    const result = await this.db
      .select()
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
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), isNull(artifacts.deletedAt)))
      .orderBy(desc(artifacts.updatedAt))
      .limit(limit);
  }

  async update(id: string, patch: Partial<NewArtifact>): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(artifacts.id, id));
  }

  async setCurrentVersion(id: string, versionId: string): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(artifacts.id, id));
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, id));
  }

  // ── versions ─────────────────────────────────────────────────
  async createVersion(record: NewArtifactVersion): Promise<ArtifactVersion> {
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

  async deleteSource(id: string): Promise<void> {
    await this.db.delete(artifactDataSources).where(eq(artifactDataSources.id, id));
  }

  // ── snapshots ────────────────────────────────────────────────
  async createSnapshot(record: NewArtifactDataSnapshot): Promise<ArtifactDataSnapshot> {
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
      .where(sql`${artifactDataSnapshots.id} = ANY(${toDelete})`);
    return toDelete.length;
  }

  // ── share links ──────────────────────────────────────────────
  async createShareLink(record: NewArtifactShareLink): Promise<ArtifactShareLink> {
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

  async revokeShareLink(id: string): Promise<void> {
    await this.db
      .update(artifactShareLinks)
      .set({ revokedAt: new Date() })
      .where(eq(artifactShareLinks.id, id));
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

  // ── soft-delete cleanup ──────────────────────────────────────
  async purgeSoftDeleted(olderThan: Date): Promise<number> {
    const result = await this.db
      .delete(artifacts)
      .where(and(lt(artifacts.deletedAt, olderThan)))
      .returning({ id: artifacts.id });
    return result.length;
  }
}

export const artifactsRepository = new ArtifactsRepository();
