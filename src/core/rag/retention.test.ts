import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { getDb } from '@/db/postgres';
import { embeddings } from '@/db/schema/embeddings';
import { retentionPolicies } from '@/db/schema/retention-policies';
import { eq, sql } from 'drizzle-orm';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import { EmbeddingService } from './embeddings';

describe.skipIf(!isIntegration)('RAG cleanup with retention_policies (Integration)', () => {
  let service: EmbeddingService;

  beforeAll(async () => {
    await setupIntegrationDb();
    service = new EmbeddingService('test-embed-model');
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables(['embeddings', 'retention_policies', 'cleanup_audit_log']);
    // Re-seed the policies the migration would have written. Tests own
    // these rows so the assertions can change defaults without
    // touching the migration.
    await getDb().insert(retentionPolicies).values([
      { purpose: 'ephemeral', maxAgeDays: 7 },
      { purpose: 'message', maxAgeDays: 90 },
      { purpose: 'knowledge_artifact', maxAgeDays: 365, lfuMinAccess: 1, lfuMinAgeDays: 180 },
      { purpose: 'document', maxAgeDays: null, lfuMinAccess: null, lfuMinAgeDays: null },
    ]);
  });

  async function insertRow(args: { purpose: string; ageDays: number; accessCount?: number }): Promise<string> {
    const id = randomUUID();
    const created = new Date(Date.now() - args.ageDays * 24 * 60 * 60 * 1000);
    // Insert directly so we can backdate `created_at` (the schema
    // default is now()).
    // Content must exceed minContentLength (default 50) so the
    // "short entries" pass doesn't reap it before the per-purpose
    // policy gets a chance.
    const content = `fixture content for retention test — purpose=${args.purpose} ageDays=${args.ageDays} accessCount=${args.accessCount ?? 0}`;
    await getDb().execute(sql`
      INSERT INTO embeddings (id, source_id, content, embedding, model, purpose, content_sha256, embedding_version, access_count, created_at)
      VALUES (
        ${id}, ${randomUUID()}, ${content}, '[0.1,0.2,0.3]'::vector,
        'test-embed-model', ${args.purpose}, ${randomUUID().replace(/-/g, '')},
        'test/3', ${args.accessCount ?? 0}, ${created.toISOString()}
      )
    `);
    return id;
  }

  test('age-only policy reaps rows older than max_age_days', async () => {
    const oldId = await insertRow({ purpose: 'ephemeral', ageDays: 14 });
    const freshId = await insertRow({ purpose: 'ephemeral', ageDays: 1 });

    const result = await service.cleanup({ dryRun: false, triggeredBy: 'test' });
    expect(result.byPurpose.ephemeral).toBe(1);

    const remaining = await getDb().select().from(embeddings).where(eq(embeddings.id, oldId));
    expect(remaining.length).toBe(0);
    const surv = await getDb().select().from(embeddings).where(eq(embeddings.id, freshId));
    expect(surv.length).toBe(1);
  });

  test('LFU policy reaps cold + old rows; warm rows survive', async () => {
    const coldOld = await insertRow({ purpose: 'knowledge_artifact', ageDays: 200, accessCount: 0 });
    const warmOld = await insertRow({ purpose: 'knowledge_artifact', ageDays: 200, accessCount: 5 });
    const coldFresh = await insertRow({ purpose: 'knowledge_artifact', ageDays: 30, accessCount: 0 });

    const result = await service.cleanup({ dryRun: false, triggeredBy: 'test' });
    expect(result.byPurpose.knowledge_artifact).toBe(1);

    const ids = (await getDb().select({ id: embeddings.id }).from(embeddings)).map((r) => r.id);
    expect(ids).not.toContain(coldOld);
    expect(ids).toContain(warmOld);
    expect(ids).toContain(coldFresh);
  });

  test('purpose with all-NULL policy is left alone', async () => {
    await insertRow({ purpose: 'document', ageDays: 5000 });
    const result = await service.cleanup({ dryRun: false, triggeredBy: 'test' });
    expect(result.byPurpose.document ?? 0).toBe(0);
  });

  test('dryRun reports counts without deleting', async () => {
    await insertRow({ purpose: 'ephemeral', ageDays: 14 });
    const result = await service.cleanup({ dryRun: true, triggeredBy: 'test' });
    expect(result.byPurpose.ephemeral).toBe(1);
    const surviving = await getDb().select().from(embeddings);
    expect(surviving.length).toBe(1);
  });
});
