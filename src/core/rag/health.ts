/**
 * Knowledge-base startup self-check + readiness gate.
 *
 * Philosophy: FAIL LOUD. If KB cannot write, fail fast with a clear reason and
 * make every KB endpoint return 503 until the problem is resolved. Never let an
 * upload look successful while silently dropping content.
 */

import { eq, } from 'drizzle-orm';
import { checkDbHealth, getDb } from '@/db/postgres';
import { embeddings } from '@/db/schema/embeddings';
import { coreLogger } from '@/utils/logger';
import { getEmbeddingService } from './embeddings';

export interface KBReadiness {
  ready: boolean;
  reason?: string;
  checks: {
    db: { ok: boolean; detail?: string };
    embeddingModel: { ok: boolean; detail?: string; modelId?: string };
    vectorWrite: { ok: boolean; detail?: string };
  };
  lastCheckedAt: Date;
}

const logger = coreLogger.child({ component: 'kb-health' });

const PROBE_SOURCE_TYPE = '__kb_health_probe__';
const PROBE_SOURCE_ID = '__kb_health_probe_id__';

let cached: KBReadiness | null = null;

/** Return the last computed readiness (does not re-check). */
export function getKBReadiness(): KBReadiness | null {
  return cached;
}

/** Is KB currently ready per the last self-check? */
export function isKBReady(): boolean {
  return cached?.ready === true;
}

/**
 * Run the full KB self-check: DB reachable, embedding model resolvable+callable,
 * vector store accepts insert+delete of a probe row. Loud log on any failure.
 *
 * Returns the readiness report. Also caches it for isKBReady()/getKBReadiness().
 */
export async function runKBSelfCheck(): Promise<KBReadiness> {
  const checks: KBReadiness['checks'] = {
    db: { ok: false },
    embeddingModel: { ok: false },
    vectorWrite: { ok: false },
  };

  // 1. DB reachable?
  const dbHealth = await checkDbHealth();
  if (dbHealth.healthy) {
    checks.db.ok = true;
  } else {
    checks.db.detail = dbHealth.error || 'unknown db health error';
  }

  // 2. Embedding model: resolvable and the provider accepts an embed call?
  let probeVector: number[] | null = null;
  let resolvedModelId: string | undefined;
  try {
    const service = getEmbeddingService();
    // generateEmbedding() both resolves the model from the registry AND issues
    // the provider call — so a single call here proves the whole path works.
    probeVector = await service.generateEmbedding('kb health probe');
    if (!Array.isArray(probeVector) || probeVector.length === 0) {
      throw new Error('embedding provider returned empty vector');
    }
    // Best-effort resolve for reporting
    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const m = await getModelRegistry().getModelForTopic('embedding');
      resolvedModelId = m?.modelId;
    } catch { /* non-fatal for the check itself */ }

    checks.embeddingModel = {
      ok: true,
      modelId: resolvedModelId,
      detail: `vector length ${probeVector.length}`,
    };
  } catch (err) {
    checks.embeddingModel = {
      ok: false,
      modelId: resolvedModelId,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Vector store writable? (only attempt if DB + embedding check passed)
  if (checks.db.ok && checks.embeddingModel.ok && probeVector) {
    try {
      const db = getDb();
      const inserted = await db.insert(embeddings).values({
        sourceType: PROBE_SOURCE_TYPE,
        sourceId: PROBE_SOURCE_ID,
        content: 'kb health probe',
        embedding: probeVector,
        model: resolvedModelId || 'probe',
        metadata: {},
      }).returning({ id: embeddings.id });

      const insertedId = inserted[0]?.id;
      if (!insertedId) {
        throw new Error('vector insert returned no row');
      }

      // Delete the probe row (and any stragglers from prior runs)
      await db.delete(embeddings).where(eq(embeddings.sourceType, PROBE_SOURCE_TYPE));
      checks.vectorWrite.ok = true;
      checks.vectorWrite.detail = 'insert+delete probe round-tripped';
    } catch (err) {
      checks.vectorWrite = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  } else if (!checks.db.ok) {
    checks.vectorWrite.detail = 'skipped: db not healthy';
  } else {
    checks.vectorWrite.detail = 'skipped: embedding provider not ready';
  }

  const ready = checks.db.ok && checks.embeddingModel.ok && checks.vectorWrite.ok;
  let reason: string | undefined;
  if (!ready) {
    const failed: string[] = [];
    if (!checks.db.ok) failed.push(`db(${checks.db.detail})`);
    if (!checks.embeddingModel.ok) failed.push(`embedding(${checks.embeddingModel.detail})`);
    if (!checks.vectorWrite.ok) failed.push(`vectorWrite(${checks.vectorWrite.detail})`);
    reason = failed.join(' | ');
  }

  const report: KBReadiness = {
    ready,
    reason,
    checks,
    lastCheckedAt: new Date(),
  };

  const storageMode = process.env.STORAGE_MODE || 'external';
  const logPayload = {
    storageMode,
    ready,
    reason,
    db: checks.db,
    embeddingModel: checks.embeddingModel,
    vectorWrite: checks.vectorWrite,
  };

  if (ready) {
    logger.info(logPayload, 'Knowledge base self-check PASSED');
  } else {
    // LOUD — error level. The KB is broken; uploads will now 503 until fixed.
    logger.error(
      logPayload,
      'Knowledge base self-check FAILED — KB endpoints will return 503 until configuration is fixed. ' +
        'Common fixes: (1) assign an embedding model in Models page (topic="embedding"), ' +
        '(2) ensure the selected provider is reachable (Ollama running, API key set), ' +
        '(3) verify pgvector extension is enabled.',
    );
  }

  cached = report;
  return report;
}

/**
 * Force-invalidate cached readiness so the next isKBReady() check re-runs.
 * Use after the user updates the model registry so they don't have to restart.
 */
export function invalidateKBReadiness(): void {
  cached = null;
}

/**
 * Build a 503 response body describing why KB isn't ready.
 * Use this in any KB route handler to fail loud with a clear message.
 */
export function kbNotReadyResponse(): { error: string; kb: KBReadiness | null } {
  const report = cached;
  const baseMsg = 'Knowledge base is not ready';
  if (!report) {
    return {
      error: `${baseMsg}: self-check has not run yet`,
      kb: null,
    };
  }
  return {
    error: `${baseMsg}: ${report.reason || 'unknown reason'}`,
    kb: report,
  };
}
