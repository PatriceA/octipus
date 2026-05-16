/**
 * RAG retention service — per-purpose cleanup of the embeddings
 * table.
 *
 * Extracted from `rag/embeddings.ts` in the architecture cleanup pass:
 * the embedding/indexing service was a 1000-line god class; retention
 * is its own concern (different test surface, different schedule,
 * different audit log). `EmbeddingService.cleanup` now delegates here
 * so existing callers (cron, knowledge API, knowledge tool) keep
 * working without touching their signatures.
 *
 * Passes, in order:
 *   1. Per-purpose retention from `retention_policies`
 *      (age cap + optional LFU). Runs first so the legacy passes
 *      below see fewer rows.
 *   2. Orphaned `purpose='document'` rows whose `documents` parent
 *      is gone.
 *   3. Legacy `purpose='ephemeral'` / `source_type='agent_output'`
 *      rows older than `maxAgeDays`. Phase B removed the agent-output
 *      write path; steady-state expectation: 0.
 *   4. Very short / low-quality entries.
 *
 * Writes a `cleanup_audit_log` row at the end describing the run.
 */
import { inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { cleanupAuditLog } from '@/db/schema/cleanup-log';
import { embeddings } from '@/db/schema/embeddings';
import { type RetentionPolicy, retentionPolicies } from '@/db/schema/retention-policies';
import { coreLogger } from '@/utils/logger';

export interface CleanupOptions {
  maxAgeDays?: number;
  minContentLength?: number;
  dryRun?: boolean;
  triggeredBy?: string;
}

export interface CleanupResult {
  orphanedDocuments: number;
  staleAgentOutputs: number;
  shortEntries: number;
  duplicates: number;
  byPurpose: Record<string, number>;
  total: number;
}

/**
 * Drizzle's `db.execute(sql\`...\`)` is driver-shape-dependent. This
 * helper flattens the two known shapes (raw array vs `{ rows: T[] }`)
 * so callers can pass the projected row type as the generic.
 */
function unwrapRows<T = Record<string, unknown>>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: T[] }).rows;
  }
  return [];
}

async function deleteIdsInBatches(ids: string[]): Promise<void> {
  const db = getDb();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    await db.delete(embeddings).where(inArray(embeddings.id, batch));
  }
}

/**
 * Apply one retention_policies row to the embeddings table. Returns
 * the number of rows removed (0 in dryRun). Both axes (age, LFU) can
 * be NULL — a row with both NULL is a documentation-only policy
 * (e.g. `document`, which cascade-deletes with its parent).
 */
export async function applyRetentionPolicy(policy: RetentionPolicy, dryRun: boolean): Promise<number> {
  const db = getDb();
  const conditions: ReturnType<typeof sql>[] = [];

  if (policy.maxAgeDays != null) {
    const ageCutoff = new Date(Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000);
    conditions.push(sql`created_at < ${ageCutoff.toISOString()}`);
  }

  if (policy.lfuMinAccess != null && policy.lfuMinAgeDays != null) {
    const lfuCutoff = new Date(Date.now() - policy.lfuMinAgeDays * 24 * 60 * 60 * 1000);
    // OR-combined with the age axis: a row is reaped if EITHER too
    // old OR cold-and-stale.
    conditions.push(
      sql`(access_count < ${policy.lfuMinAccess} AND created_at < ${lfuCutoff.toISOString()})`,
    );
  }

  if (conditions.length === 0) return 0;

  const where = conditions.reduce<ReturnType<typeof sql> | null>(
    (acc, c) => (acc === null ? c : sql`${acc} OR ${c}`),
    null,
  );
  if (where === null) return 0;

  const found = await db.execute(sql`
    SELECT id FROM embeddings
    WHERE purpose = ${policy.purpose}
      AND (${where})
  `);
  const ids = unwrapRows<{ id: string }>(found).map((r) => r.id);
  if (ids.length === 0) return 0;
  if (dryRun) return ids.length;
  await deleteIdsInBatches(ids);
  return ids.length;
}

export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  const maxAgeDays = options.maxAgeDays ?? 30;
  const minContentLength = options.minContentLength ?? 50;
  const dryRun = options.dryRun ?? false;
  const triggeredBy = options.triggeredBy ?? 'manual';
  const startTime = Date.now();
  const db = getDb();

  const beforeRes = await db.execute(sql`SELECT count(*)::int AS count FROM embeddings`);
  const totalBefore = (unwrapRows<{ count: number }>(beforeRes)[0]?.count) || 0;

  const results: CleanupResult = {
    orphanedDocuments: 0,
    staleAgentOutputs: 0,
    shortEntries: 0,
    duplicates: 0,
    byPurpose: {},
    total: 0,
  };

  // 0. Per-purpose retention. Runs first so the legacy passes see
  // fewer rows.
  const policies = await db.select().from(retentionPolicies);
  for (const p of policies) {
    const removed = await applyRetentionPolicy(p, dryRun);
    if (removed > 0) results.byPurpose[p.purpose] = removed;
  }

  // 1. Orphaned document rows (parent gone). The Phase 2 cleanup
  // added an FK with ON DELETE CASCADE on `doc_id`; this sweep
  // catches rows that pre-date the FK (`doc_id` NULL, source_id
  // pointing at a deleted document).
  const orphanedRes = await db.execute(sql`
    SELECT e.id FROM embeddings e
    WHERE e.source_type = 'document'
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE CAST(d.id AS text) = e.source_id)
  `);
  const orphaned = unwrapRows<{ id: string }>(orphanedRes);
  results.orphanedDocuments = orphaned.length;
  if (!dryRun && orphaned.length > 0) {
    await deleteIdsInBatches(orphaned.map((r) => r.id));
  }

  // 2. Legacy ephemeral / agent_output sweep. After Phase B these
  // shouldn't exist; sweep catches rows from older deployments and
  // health-probe rows. Steady-state: 0.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const staleRes = await db.execute(sql`
    SELECT id FROM embeddings
    WHERE (purpose = 'ephemeral' OR source_type = 'agent_output')
      AND created_at < ${cutoffDate.toISOString()}
  `);
  const stale = unwrapRows<{ id: string }>(staleRes);
  results.staleAgentOutputs = stale.length;
  if (!dryRun && stale.length > 0) {
    await deleteIdsInBatches(stale.map((r) => r.id));
  }

  // 3. Short / low-quality.
  const shortRes = await db.execute(sql`
    SELECT id FROM embeddings
    WHERE length(content) < ${minContentLength}
      AND content NOT LIKE '[%'
  `);
  const short = unwrapRows<{ id: string }>(shortRes);
  results.shortEntries = short.length;
  if (!dryRun && short.length > 0) {
    await deleteIdsInBatches(short.map((r) => r.id));
  }

  // 4. Duplicates — placeholder kept at 0 so the audit log shape
  // stays back-compat. The Phase A unique index makes duplicate
  // inserts impossible.
  results.duplicates = 0;

  const byPurposeTotal = Object.values(results.byPurpose).reduce((a, b) => a + b, 0);
  results.total =
    results.orphanedDocuments +
    results.staleAgentOutputs +
    results.shortEntries +
    results.duplicates +
    byPurposeTotal;

  const afterRes = await db.execute(sql`SELECT count(*)::int AS count FROM embeddings`);
  const totalAfter = (unwrapRows<{ count: number }>(afterRes)[0]?.count) || 0;
  const durationMs = Date.now() - startTime;

  try {
    await db.insert(cleanupAuditLog).values({
      triggeredBy,
      dryRun,
      maxAgeDays,
      minContentLength,
      orphanedDocuments: results.orphanedDocuments,
      staleAgentOutputs: results.staleAgentOutputs,
      shortEntries: results.shortEntries,
      duplicates: results.duplicates,
      totalRemoved: results.total,
      totalBefore,
      totalAfter,
      durationMs,
    });
  } catch (err) {
    coreLogger.warn({ err }, 'Failed to write cleanup audit log');
  }

  coreLogger.info(
    {
      ...results,
      dryRun,
      maxAgeDays,
      minContentLength,
      durationMs,
      totalBefore,
      totalAfter,
    },
    'Knowledge base cleanup completed',
  );

  return results;
}
