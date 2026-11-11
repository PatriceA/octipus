import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, test } from 'vitest';

test('manual cleanup removes only generated global chunks and preserves user/workspace documents', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE embeddings (id int, user_id text, workspace_id text, purpose text, metadata jsonb, doc_id text);
      INSERT INTO embeddings VALUES
        (1,NULL,NULL,'document','{"source":"octipus-docs"}',NULL),
        (2,'alice',NULL,'document','{"source":"octipus-docs"}',NULL),
        (3,NULL,'team','document','{"source":"octipus-docs"}',NULL),
        (4,NULL,NULL,'note','{"source":"octipus-docs"}',NULL),
        (5,NULL,NULL,'document','{}',NULL),
        (6,NULL,NULL,'document','{"source":"octipus-docs"}','upload');`);
    const sql = readFileSync(new URL('./migrations/0181_remove_product_doc_embeddings.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // Upgrade cleanup is idempotent.
    expect((await db.query<{ id: number }>('SELECT id FROM embeddings ORDER BY id')).rows.map(r => r.id)).toEqual([2,3,4,5,6]);
  } finally { await db.close(); }
});
