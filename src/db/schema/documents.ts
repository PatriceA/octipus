import { pgTable, text, timestamp, uuid, jsonb, integer, index, pgEnum } from 'drizzle-orm/pg-core';

export const documentStatusEnum = pgEnum('document_status', [
  'queued',
  'processing',
  'completed',
  'failed',
]);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  category: text('category'),
  ocrText: text('ocr_text'),
  summary: text('summary'),
  status: documentStatusEnum('status').notNull().default('queued'),
  storagePath: text('storage_path').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  processedAt: timestamp('processed_at'),
}, (table) => ({
  userIdx: index('documents_user_id_idx').on(table.userId),
  statusIdx: index('documents_status_idx').on(table.status),
  categoryIdx: index('documents_category_idx').on(table.category),
  createdAtIdx: index('documents_created_at_idx').on(table.createdAt),
}));

export type DocumentRecord = typeof documents.$inferSelect;
export type NewDocumentRecord = typeof documents.$inferInsert;
