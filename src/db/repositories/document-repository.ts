import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../postgres';
import { type DocumentRecord, documents, type NewDocumentRecord } from '../schema/documents';

export class DocumentRepository {
  private get db() { return getDb(); }

  async create(record: NewDocumentRecord): Promise<DocumentRecord> {
    const result = await this.db.insert(documents).values(record).returning();
    return result[0];
  }

  async updateStatus(id: string, status: DocumentRecord['status'], error?: string): Promise<void> {
    await this.db.update(documents).set({
      status,
      ...(error ? { metadata: { error } } : {}),
    }).where(eq(documents.id, id));
  }

  async updateProcessed(
    id: string,
    update: {
      category: string;
      ocrText: string | null;
      summary: string | null;
      status: DocumentRecord['status'];
      storagePath?: string;
    },
  ): Promise<void> {
    await this.db.update(documents).set({
      category: update.category,
      ocrText: update.ocrText,
      summary: update.summary,
      status: update.status,
      ...(update.storagePath ? { storagePath: update.storagePath } : {}),
      processedAt: new Date(),
    }).where(eq(documents.id, id));
  }

  /**
   * Unscoped read by id, for system callers only: job recovery, the document
   * queue and processor, and channel delivery (which checks the owner itself).
   * Anything acting for a user goes through `scopedRepos(principal).documents`.
   * The leaks isolation suite fails when a caller outside that list appears.
   */
  async findByIdSystem(id: string): Promise<DocumentRecord | null> {
    // i2: by id for system callers only (queue, processor, recovery)
    const result = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return result[0] ?? null;
  }

  /**
   * The stored protection levels of documents whose content an agent was
   * handed (a search hit, a recalled passage): system lookup, the content
   * already reached the agent through its own scope. Missing ids are absent.
   */
  async protectionLevelsSystem(ids: readonly string[]): Promise<Map<string, number | null>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select({ id: documents.id, level: documents.protectionLevel }).from(documents).where(inArray(documents.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.level]));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(documents).where(eq(documents.id, id)).returning();
    return result.length > 0;
  }
}

export const documentRepository = new DocumentRepository();
