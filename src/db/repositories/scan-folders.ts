/**
 * Scan folders through one `RepoScope` (docs/SCAN-FOLDERS.md). Only admins
 * set them up (the path is the server's file system): every write checks the
 * principal is an admin, and in a space that they may write there. Reads go
 * through the scope's filter like any content; a guest reaches none.
 * The sweep (core/scan-folders/sweep.ts) reads folders outside any scope.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { isAdmin } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { getDb } from '../postgres';
import { type NewScanFolder, type ScanFolder, scanFolders } from '../schema/scan-folders';
import { isUuid, type RepoScope } from './scoped';

/** A folder write: the author, workspace, scan state and timestamps are the repository's. */
export type ScanFolderWrite = Pick<NewScanFolder, 'label' | 'path' | 'enabled' | 'defaultProtectionLevel'>;

export class ScanFolderRepo {
  constructor(private readonly scope: RepoScope) {}

  private get db() { return getDb(); }

  private rows(): SQL[] {
    return this.scope.shared(scanFolders);
  }

  /** Setting a folder up: an admin, who may write in the scope. Throws `SpaceError`. */
  assertManage(): void {
    if (!isAdmin(this.scope.principal)) throw new SpaceError('forbidden_role', 'Only an admin can set up scan folders');
    this.scope.can('write');
  }

  async list(): Promise<ScanFolder[]> {
    return this.db.select().from(scanFolders).where(and(...this.rows())).orderBy(scanFolders.label);
  }

  async findById(id: string): Promise<ScanFolder | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(scanFolders).where(and(eq(scanFolders.id, id), ...this.rows())).limit(1);
    return row ?? null;
  }

  async create(data: ScanFolderWrite): Promise<ScanFolder> {
    this.assertManage();
    const stamp = { userId: this.scope.stamp().userId, workspaceId: await this.scope.writeWorkspace() };
    const [row] = await this.db.insert(scanFolders).values({ ...data, ...stamp }).returning();
    return row;
  }

  async update(id: string, patch: Partial<ScanFolderWrite>): Promise<ScanFolder | null> {
    this.assertManage();
    if (!isUuid(id)) return null;
    const [row] = await this.db
      .update(scanFolders)
      .set({ ...patch, ...(patch.path ? { lastError: null } : {}), updatedAt: new Date() })
      .where(and(eq(scanFolders.id, id), ...this.rows()))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    this.assertManage();
    if (!isUuid(id)) return false;
    const rows = await this.db.delete(scanFolders).where(and(eq(scanFolders.id, id), ...this.rows())).returning({ id: scanFolders.id });
    return rows.length > 0;
  }
}
