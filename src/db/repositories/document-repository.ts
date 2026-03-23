import { eq, desc, and } from 'drizzle-orm';
import { getDb } from '../postgres';
import { documents, type DocumentRecord, type NewDocumentRecord } from '../schema/documents';

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

  async findById(id: string): Promise<DocumentRecord | null> {
    const result = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return result[0] ?? null;
  }

  async findByUser(userId: string, limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async findByCategory(category: string, limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(eq(documents.category, category))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async findByUserAndCategory(userId: string, category: string, limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.category, category)))
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(documents).where(eq(documents.id, id)).returning();
    return result.length > 0;
  }

  async listRecent(limit = 50): Promise<DocumentRecord[]> {
    return this.db
      .select()
      .from(documents)
      .orderBy(desc(documents.createdAt))
      .limit(limit);
  }
}

export const documentRepository = new DocumentRepository();
