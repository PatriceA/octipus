/**
 * Knowledge-base startup self-check + readiness gate.
 *
 * Philosophy: FAIL LOUD. If KB cannot write, fail fast with a clear reason and
 * make every KB endpoint return 503 until the problem is resolved. Never let an
 * upload look successful while silently dropping content.
 */

import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
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

// The probe writes a row with purpose='ephemeral' and a unique sourceId
// so the cleanup pass at delete time picks up any stragglers from
// crashed prior runs without colliding with real ephemeral rows.
const PROBE_SOURCE_ID = '__kb_health_probe_id__';

let cached: KBReadiness | null = null;
/** The self-check running now; concurrent callers share it. */
let inFlight: Promise<KBReadiness> | null = null;

export interface KBSelfCheckOptions {
  /**
   * Stop waiting on the embedding call after this long and report it failed
   * (the boot check). Unbounded when unset (`/knowledge/readiness`).
   */
  embedTimeoutMs?: number;
}

/** Return the last computed readiness (does not re-check). */
export function getKBReadiness(): KBReadiness | null {
  return cached;
}

/** Is KB currently ready per the last self-check? */
export function isKBReady(): boolean {
  return cached?.ready === true;
}

/**
 * Whether the KB is ready, waiting (at most `maxWaitMs`) for a self-check
 * that is still running when none has finished yet — at boot the check runs
 * off the critical path, and a request in that window gets its verdict
 * rather than a 503 for a check that was about to pass.
 */
export async function awaitKBReadiness(maxWaitMs = 30_000): Promise<boolean> {
  const pending = inFlight;
  if (!cached && pending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending.then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); }),
    ]);
    clearTimeout(timer);
  }
  return isKBReady();
}

/** `promise`, or a rejection once `ms` have passed (when set). */
function withTimeout<T>(promise: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The call itself is not cancelled; a late failure is logged by its own path.
  promise.catch((err: unknown) => logger.debug({ err }, `${what} failed after the check stopped waiting`));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run the full KB self-check: DB reachable, embedding model resolvable+callable,
 * vector store accepts insert+delete of a probe row. Loud log on any failure.
 *
 * Returns the readiness report. Also caches it for isKBReady()/getKBReadiness().
 * A call while one runs shares it.
 */
export function runKBSelfCheck(opts: KBSelfCheckOptions = {}): Promise<KBReadiness> {
  if (inFlight) return inFlight;
  const run = selfCheck(opts).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function selfCheck(opts: KBSelfCheckOptions): Promise<KBReadiness> {
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
    probeVector = await withTimeout(service.generateEmbedding('kb health probe'), opts.embedTimeoutMs, 'embedding provider');
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
      const probeContent = 'kb health probe';
      const probeModel = resolvedModelId || 'probe';
      const inserted = await db.insert(embeddings).values({
        sourceId: PROBE_SOURCE_ID,
        content: probeContent,
        embedding: probeVector,
        model: probeModel,
        metadata: {},
        purpose: 'ephemeral',
        contentSha256: createHash('sha256').update(probeContent, 'utf8').digest('hex'),
        embeddingVersion: `${probeModel}/${probeVector.length}`,
      }).returning({ id: embeddings.id });

      const insertedId = inserted[0]?.id;
      if (!insertedId) {
        throw new Error('vector insert returned no row');
      }

      // Delete the probe row (and any stragglers from prior runs).
      // Match by purpose+sourceId since both columns combine into the
      // unique dedup index — finds every probe row even across restarts.
      await db
        .delete(embeddings)
        .where(and(eq(embeddings.purpose, 'ephemeral'), eq(embeddings.sourceId, PROBE_SOURCE_ID)));
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
      error: `${baseMsg}: ${inFlight ? 'self-check is still running — retry shortly' : 'self-check has not run yet'}`,
      kb: null,
    };
  }
  return {
    error: `${baseMsg}: ${report.reason || 'unknown reason'}`,
    kb: report,
  };
}
