/**
 * Collapsing a user's open skill proposals, and the daily learning
 * maintenance that runs it for everyone (docs/plans/self-learning-consolidation.md,
 * "Consolidation").
 *
 * `consolidateProposals(userId)`:
 *   1. bring the stored skill and proposal embeddings up to date;
 *   2. greedy clustering of the user's open non-patch proposals, most similar
 *      pair first: a pair at or above `learning.duplicateSimilarity` merges, a
 *      pair in the related band merges unless the merge model says the two
 *      are different skills (remembered for the run, never asked twice). The
 *      target is the pending member with the most observations, else the
 *      oldest; the other is absorbed (`absorbProposal`);
 *   3. candidates not seen for `learning.candidateTtlDays` are deleted;
 *   4. the remaining candidates are promoted when eligible, oldest first.
 *
 * `runDailyLearningMaintenance()` runs that for every user with open
 * proposals and then the skill curator, at most once per 24 hours across all
 * processes: the run is claimed with one conditional upsert of a `kv_store`
 * row, so two processes ticking at once cannot both run it.
 * `startLearningMaintenance()` ticks it hourly (unref'd timer).
 */
import { and, asc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { kvStore } from '@/db/schema/kv';
import { type SkillProposalRecord, skillProposals } from '@/db/schema/skill-proposals';
import { promoteIfEligible } from '@/services/skill-proposal-merge';
import { absorbProposal } from '@/services/skill-proposal-service';
import { ensureProposalEmbeddings, ensureSkillEmbeddings } from '@/skills/embedding-backfill';
import { runSkillCurator } from '@/skills/curator';
import { coreLogger } from '@/utils/logger';

export interface ConsolidationReport {
  /** Proposals absorbed into another. */
  merged: number;
  /** Candidates deleted because they were not seen again in time. */
  expired: number;
  /** Candidates surfaced (pending) by this run. */
  promoted: number;
  /** Skill and proposal embeddings computed. */
  embedded: number;
  /** Merges that only counted because the merge model could not be used. */
  degraded: number;
}

export interface ConsolidationOptions {
  /** Most proposals absorbed in one run (bounds the merge-model calls). Default 20. */
  maxMerges?: number;
}

const OPEN: Array<'pending' | 'candidate'> = ['pending', 'candidate'];

interface Pair { a: string; b: string; similarity: number }

/** Open non-patch proposal pairs of `userId` at or above `threshold`, most similar first. */
async function similarPairs(userId: string, threshold: number): Promise<Pair[]> {
  const res = await getDb().execute(sql`
    SELECT a.id AS a, b.id AS b, 1 - (a.embedding <=> b.embedding) AS similarity
    FROM ${skillProposals} a
    JOIN ${skillProposals} b ON b.user_id = a.user_id AND a.id < b.id
    WHERE a.user_id = ${userId}::uuid
      AND a.status IN ('pending', 'candidate') AND b.status IN ('pending', 'candidate')
      AND a.kind <> 'patch' AND b.kind <> 'patch'
      AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
      AND vector_dims(a.embedding) = vector_dims(b.embedding)
      AND 1 - (a.embedding <=> b.embedding) >= ${threshold}
    ORDER BY similarity DESC, a.id, b.id
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{ a: string; b: string; similarity: number | string }>;
  return rows.map(row => ({ a: row.a, b: row.b, similarity: Number(row.similarity) }));
}

/** The pending member with the most observations, else the oldest. */
function pickTarget(x: SkillProposalRecord, y: SkillProposalRecord): [target: SkillProposalRecord, absorbed: SkillProposalRecord] {
  const older = (p: SkillProposalRecord, q: SkillProposalRecord) =>
    p.createdAt.getTime() !== q.createdAt.getTime() ? p.createdAt < q.createdAt : p.id < q.id;
  const xPending = x.status === 'pending';
  const yPending = y.status === 'pending';
  if (xPending !== yPending) return xPending ? [x, y] : [y, x];
  if (xPending && x.exemplarCount !== y.exemplarCount) return x.exemplarCount > y.exemplarCount ? [x, y] : [y, x];
  return older(x, y) ? [x, y] : [y, x];
}

/**
 * Consolidate `userId`'s open proposals (see the module comment). Throws on
 * database errors; an unavailable embedding or merge model degrades (no
 * clustering, or count-only merges reported in `degraded`).
 */
export async function consolidateProposals(userId: string, opts: ConsolidationOptions = {}): Promise<ConsolidationReport> {
  const maxMerges = opts.maxMerges ?? 20;
  const { duplicateSimilarity, relatedSimilarity, candidateTtlDays } = getConfig().learning;
  const report: ConsolidationReport = { merged: 0, expired: 0, promoted: 0, embedded: 0, degraded: 0 };
  const db = getDb();

  // 1. Embeddings.
  const skillsEmbedded = await ensureSkillEmbeddings();
  const proposalsEmbedded = await ensureProposalEmbeddings(userId);
  report.embedded = skillsEmbedded.embedded + proposalsEmbedded.embedded;

  // 2. Greedy clustering. A merge changes the target's text and embedding,
  // so pairs are re-read after every round that merged something; a pair the
  // model called distinct is not asked again in this run.
  const distinct = new Set<string>();
  const threshold = Math.min(relatedSimilarity, duplicateSimilarity);
  let mergedThisRound = true;
  while (mergedThisRound && report.merged < maxMerges) {
    mergedThisRound = false;
    const pairs = (await similarPairs(userId, threshold)).filter(pair => !distinct.has(`${pair.a}:${pair.b}`));
    if (pairs.length === 0) break;
    const ids = [...new Set(pairs.flatMap(pair => [pair.a, pair.b]))];
    const rows = new Map((await db.select().from(skillProposals)
      .where(and(inArray(skillProposals.id, ids), eq(skillProposals.userId, userId)))).map(row => [row.id, row]));
    // Rows absorbed (or changed) this round wait for the next read.
    const touched = new Set<string>();
    for (const pair of pairs) {
      if (report.merged >= maxMerges) break;
      if (touched.has(pair.a) || touched.has(pair.b)) continue;
      const x = rows.get(pair.a);
      const y = rows.get(pair.b);
      if (!x || !y) continue;
      const [target, absorbed] = pickTarget(x, y);
      const related = pair.similarity < duplicateSimilarity;
      const result = await absorbProposal(absorbed, target, { allowDistinct: related });
      if (result.outcome === 'distinct') {
        distinct.add(`${pair.a}:${pair.b}`);
        continue;
      }
      touched.add(pair.a);
      touched.add(pair.b);
      if (result.outcome === 'not_open') continue;
      report.merged++;
      if (result.mergeDegraded) report.degraded++;
      if (result.promoted) report.promoted++;
      mergedThisRound = true;
    }
  }

  // 3. Expiry: candidates not seen again in time, with the rows merged into them.
  const cutoff = new Date(Date.now() - candidateTtlDays * 24 * 60 * 60 * 1000);
  report.expired = await db.transaction(async (tx) => {
    const expired = await tx.select({ id: skillProposals.id }).from(skillProposals)
      .where(and(eq(skillProposals.userId, userId), eq(skillProposals.status, 'candidate'), lt(skillProposals.lastExemplarAt, cutoff)))
      .for('update');
    const ids = expired.map(row => row.id);
    if (ids.length === 0) return 0;
    await tx.delete(skillProposals).where(and(
      eq(skillProposals.userId, userId),
      or(
        and(inArray(skillProposals.id, ids), eq(skillProposals.status, 'candidate')),
        and(inArray(skillProposals.mergedIntoId, ids), eq(skillProposals.status, 'merged')),
      ),
    ));
    return ids.length;
  });

  // 4. Promotion, oldest first, until a cap is reached.
  const candidates = await db.select({ id: skillProposals.id }).from(skillProposals)
    .where(and(eq(skillProposals.userId, userId), eq(skillProposals.status, 'candidate'), ne(skillProposals.kind, 'patch')))
    .orderBy(asc(skillProposals.createdAt), asc(skillProposals.id));
  for (const candidate of candidates) {
    const result = await promoteIfEligible(candidate);
    if (result.promoted) { report.promoted++; continue; }
    if (result.reason === 'max_pending' || result.reason === 'per_day') break;
  }

  coreLogger.info({ userId, ...report }, 'Skill proposals consolidated');
  return report;
}

// ── daily maintenance ─────────────────────────────────────────────

/** The `kv_store` key holding the last daily run (epoch milliseconds). */
export const MAINTENANCE_KEY = 'learning:maintenance:last-run';
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

/**
 * Claim today's run: write `now` unless the stored last run is less than 24 h
 * old. One statement, so of two processes ticking at once exactly one wins.
 */
async function claimDailyRun(now: number): Promise<boolean> {
  const rows = await getDb().insert(kvStore)
    .values({ key: MAINTENANCE_KEY, value: String(now), expiresAt: null })
    .onConflictDoUpdate({
      target: kvStore.key,
      set: { value: String(now), expiresAt: null },
      // A value that is not a number (hand-edited) counts as never run.
      setWhere: sql`CASE WHEN ${kvStore.value} ~ '^[0-9]+$' THEN ${kvStore.value}::bigint <= ${now - DAY_MS} ELSE true END`,
    })
    .returning({ key: kvStore.key });
  return rows.length > 0;
}

export type MaintenanceResult =
  | { ran: false }
  | { ran: true; users: number; failed: number; report: ConsolidationReport; curator: { archived: number; flagged: number } | null };

/**
 * Consolidate every user with open proposals, then run the skill curator, at
 * most once per 24 hours (claimed in `kv_store`). A failing user or curator
 * is logged and the rest goes on; only the claim itself can throw.
 */
export async function runDailyLearningMaintenance(): Promise<MaintenanceResult> {
  if (!(await claimDailyRun(Date.now()))) return { ran: false };
  const owners = await getDb().selectDistinct({ userId: skillProposals.userId }).from(skillProposals)
    .where(and(inArray(skillProposals.status, OPEN), ne(skillProposals.kind, 'patch')));
  const total: ConsolidationReport = { merged: 0, expired: 0, promoted: 0, embedded: 0, degraded: 0 };
  let failed = 0;
  for (const { userId } of owners) {
    try {
      const report = await consolidateProposals(userId);
      for (const key of Object.keys(total) as Array<keyof ConsolidationReport>) total[key] += report[key];
    } catch (err) {
      failed++;
      coreLogger.error({ err, userId }, 'Daily learning maintenance: consolidating this user\'s skill proposals failed');
    }
  }
  let curator: { archived: number; flagged: number } | null = null;
  try {
    const result = await runSkillCurator();
    curator = { archived: result.archived.length, flagged: result.flagged.length };
  } catch (err) {
    coreLogger.error({ err }, 'Daily learning maintenance: the skill curator failed');
  }
  coreLogger.info({ users: owners.length, failed, ...total, curator }, 'Daily learning maintenance done');
  return { ran: true, users: owners.length, failed, report: total, curator };
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstTick: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runDailyLearningMaintenance();
  } catch (err) {
    coreLogger.error({ err }, 'Daily learning maintenance could not start');
  } finally {
    running = false;
  }
}

/**
 * Tick `runDailyLearningMaintenance` hourly, the first time a minute after
 * boot. The timers are unref'd: they never keep the process alive.
 */
export function startLearningMaintenance(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
  firstTick = setTimeout(() => { void tick(); }, 60_000);
  firstTick.unref();
}

/** Stop the ticks (tests, shutdown). */
export function stopLearningMaintenance(): void {
  if (timer) clearInterval(timer);
  if (firstTick) clearTimeout(firstTick);
  timer = null;
  firstTick = null;
}
