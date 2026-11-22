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
 *      are different skills, or cannot judge them (remembered for this run
 *      only, never asked twice in it; the next run asks again). The
 *      target is the pending member with the most observations, else the
 *      oldest; the other is absorbed (`absorbProposal`);
 *   3. candidates not seen for `learning.candidateTtlDays` are deleted,
 *      unless they already recurred (they only wait for a cap);
 *   4. the remaining candidates are promoted when eligible, oldest first;
 *   5. the user's near-duplicate lesson notes (personal workspaces only, never
 *      a space; pairs within one workspace) merge pairwise like proposals,
 *      within what is left of `maxMerges`: the target is the pinned one, then
 *      the one seen more often (`sightings`), then the older; the other is
 *      archived with `frontmatter.mergedInto` (`absorbLessonNote`);
 *   6. lesson notes not pinned and neither updated (`updated_at`) nor shown
 *      to an agent (`last_accessed_at` of their chunks) within
 *      `learning.lessonTtlDays` are archived. 0 days archives none.
 *
 * `runDailyLearningMaintenance()` runs that for every user with open
 * proposals or live lesson notes and then the skill curator, at most once per 24 hours across all
 * processes: the run is claimed with one conditional upsert of a `kv_store`
 * row, so two processes ticking at once cannot both run it. The claim is a
 * 2-hour lease; finishing records the real run, so a run cut short by a
 * restart is retried after the lease rather than a day later.
 * `startLearningMaintenance()` ticks it hourly (unref'd timer).
 */
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { notInSharedWorkspace } from '@/db/repositories/scoped';
import { embeddings } from '@/db/schema/embeddings';
import { kvStore } from '@/db/schema/kv';
import { type Note, notes } from '@/db/schema/notes';
import type { ConsolidationReport } from '@/shared/learning';
import { type SkillProposalRecord, skillProposals } from '@/db/schema/skill-proposals';
import { candidateIsRecurring, promoteIfEligible } from '@/services/skill-proposal-merge';
import { absorbProposal } from '@/services/skill-proposal-service';
import { ensureProposalEmbeddings, ensureSkillEmbeddings } from '@/skills/embedding-backfill';
import { runSkillCurator } from '@/skills/curator';
import { coreLogger } from '@/utils/logger';
import { decideLessonMerge, lessonFrontmatterOf, stripEvidenceFooter, writeLessonMerge, mergedFrontmatter } from './lesson-notes';

export type { ConsolidationReport };

export interface ConsolidationOptions {
  /** Most proposals and lesson notes absorbed in one run, together (bounds the merge-model calls). Default 20. */
  maxMerges?: number;
}

const emptyReport = (): ConsolidationReport => ({ merged: 0, expired: 0, promoted: 0, embedded: 0, degraded: 0, notesMerged: 0, notesArchived: 0 });

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

/**
 * Whether `p` is the better merge target: a pending row before a candidate,
 * then the one with more observations, then the older (ids break a tie).
 */
function betterTarget(p: SkillProposalRecord, q: SkillProposalRecord): boolean {
  if ((p.status === 'pending') !== (q.status === 'pending')) return p.status === 'pending';
  if (p.status === 'pending' && p.exemplarCount !== q.exemplarCount) return p.exemplarCount > q.exemplarCount;
  return p.createdAt.getTime() !== q.createdAt.getTime() ? p.createdAt < q.createdAt : p.id < q.id;
}

/** The pending member with the most observations, else the oldest. */
function pickTarget(x: SkillProposalRecord, y: SkillProposalRecord): [target: SkillProposalRecord, absorbed: SkillProposalRecord] {
  return betterTarget(x, y) ? [x, y] : [y, x];
}

/**
 * Consolidate `userId`'s open proposals (see the module comment). Throws on
 * database errors; an unavailable embedding or merge model degrades (no
 * clustering, or count-only merges reported in `degraded`).
 */
export async function consolidateProposals(userId: string, opts: ConsolidationOptions = {}): Promise<ConsolidationReport> {
  const maxMerges = opts.maxMerges ?? 20;
  const { duplicateSimilarity, relatedSimilarity, candidateTtlDays, recurrenceSessions } = getConfig().learning;
  const report = emptyReport();
  const db = getDb();

  // 1. Embeddings.
  const skillsEmbedded = await ensureSkillEmbeddings();
  const proposalsEmbedded = await ensureProposalEmbeddings(userId);
  report.embedded = skillsEmbedded.embedded + proposalsEmbedded.embedded;

  // 2. Greedy clustering. A merge changes the target's text and embedding,
  // so pairs are re-read after every round that merged something; a pair the
  // model called distinct (or could not judge, in the related band) is not
  // asked again in this run and costs no merge budget; a later run asks again.
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
    // The pair holding the best target of all goes first. Taken in the
    // order of the query (similarity, then ids), two lesser rows of a
    // cluster could merge first and outgrow the row that should have kept
    // the cluster, so which proposal survived depended on its random id.
    const best = (pair: Pair): SkillProposalRecord | undefined => {
      const x = rows.get(pair.a);
      const y = rows.get(pair.b);
      return x && y ? pickTarget(x, y)[0] : x ?? y;
    };
    pairs.sort((p, q) => {
      const bp = best(p);
      const bq = best(q);
      if (bp && bq && bp.id !== bq.id) return betterTarget(bp, bq) ? -1 : 1;
      return q.similarity - p.similarity;
    });
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

  // 3. Expiry: candidates never seen again in time, with the rows merged into
  // them. One that already recurred (or rests on a correction) only waits for
  // a cap to free up: it is kept.
  const cutoff = new Date(Date.now() - candidateTtlDays * 24 * 60 * 60 * 1000);
  report.expired = await db.transaction(async (tx) => {
    const stale = await tx.select({ id: skillProposals.id, sourceRefs: skillProposals.sourceRefs, signal: skillProposals.signal }).from(skillProposals)
      .where(and(eq(skillProposals.userId, userId), eq(skillProposals.status, 'candidate'), lt(skillProposals.lastExemplarAt, cutoff)))
      .for('update');
    const ids = stale.filter(row => !candidateIsRecurring(row, recurrenceSessions)).map(row => row.id);
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

  // 5. and 6. Lesson notes.
  const lessons = await consolidateLessonNotes(userId, { maxMerges: Math.max(0, maxMerges - report.merged) });
  report.notesMerged = lessons.merged;
  report.degraded += lessons.degraded;
  report.notesArchived = await expireLessonNotes(userId);

  coreLogger.info({ userId, ...report }, 'Skill proposals and lesson notes consolidated');
  return report;
}

// ── lesson notes ──────────────────────────────────────────────────

/** The user's live lesson notes in their personal workspaces (or user level), never a space's. */
const liveLessonsOf = (userId: string) => and(eq(notes.userId, userId), eq(notes.noteKind, 'lesson'), isNull(notes.archivedAt),
  notInSharedWorkspace(notes.workspaceId));

/**
 * Pairs of `userId`'s live lesson notes in one workspace at or above
 * `threshold`, by their best pair of `purpose = 'lesson'` chunks, most similar first.
 */
async function similarLessonPairs(userId: string, threshold: number): Promise<Pair[]> {
  const res = await getDb().execute(sql`
    WITH live AS (
      SELECT n.id, n.workspace_id FROM ${notes} n
      WHERE n.user_id = ${userId}::uuid AND n.note_kind = 'lesson' AND n.archived_at IS NULL
        AND ${notInSharedWorkspace(sql`n.workspace_id`)}
    ),
    chunks AS (
      SELECT l.id, l.workspace_id, e.embedding FROM live l
      JOIN ${embeddings} e ON e.source_id = 'note:' || l.id::text AND e.purpose = 'lesson' AND e.user_id = ${userId}::uuid
    )
    SELECT a.id AS a, b.id AS b, max(1 - (a.embedding <=> b.embedding)) AS similarity
    FROM chunks a
    JOIN chunks b ON a.id < b.id AND a.workspace_id IS NOT DISTINCT FROM b.workspace_id
      AND vector_dims(a.embedding) = vector_dims(b.embedding)
    GROUP BY a.id, b.id
    HAVING max(1 - (a.embedding <=> b.embedding)) >= ${threshold}
    ORDER BY similarity DESC, a.id, b.id
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{ a: string; b: string; similarity: number | string }>;
  return rows.map(row => ({ a: row.a, b: row.b, similarity: Number(row.similarity) }));
}

/** Whether lesson note `p` is the better merge target: pinned, then seen more often, then older (ids break a tie). */
function betterLessonTarget(p: Note, q: Note): boolean {
  if (p.pinned !== q.pinned) return p.pinned;
  const sp = lessonFrontmatterOf(p.frontmatter).sightings;
  const sq = lessonFrontmatterOf(q.frontmatter).sightings;
  if (sp !== sq) return sp > sq;
  return p.createdAt.getTime() !== q.createdAt.getTime() ? p.createdAt < q.createdAt : p.id < q.id;
}

export type AbsorbLessonResult = { outcome: 'distinct' } | { outcome: 'not_live' } | { outcome: 'merged'; mergeDegraded: boolean };

/**
 * Merge lesson note `absorbed` into `target` (both of one user): one
 * merge-model call (`allowDistinct` in the related band); the target gets the
 * combined text (or, count-only, its own without the legacy evidence footer),
 * both notes' evidence lists and the sum of their sightings; `absorbed` is
 * archived with `frontmatter.mergedInto = target.id`. `not_live` when either
 * was archived or removed meanwhile.
 */
export async function absorbLessonNote(absorbed: Note, target: Note, opts: { allowDistinct: boolean }): Promise<AbsorbLessonResult> {
  const kindOf = (note: Note) => lessonFrontmatterOf(note.frontmatter).lessonKind;
  const decision = await decideLessonMerge(
    { title: target.title, content: stripEvidenceFooter(target.body), kind: kindOf(target) },
    { title: absorbed.title, content: stripEvidenceFooter(absorbed.body), kind: kindOf(absorbed) },
    { userId: target.userId, noteId: target.id, allowDistinct: opts.allowDistinct });
  if (decision.verdict === 'distinct') return { outcome: 'distinct' };
  const db = getDb();
  // Archive the absorbed note first, conditionally: a note the user archived
  // or deleted meanwhile is left alone, and is never counted twice.
  const incoming = lessonFrontmatterOf(absorbed.frontmatter);
  const [gone] = await db.update(notes).set({
    archivedAt: new Date(), updatedAt: new Date(),
    frontmatter: { ...absorbed.frontmatter, mergedInto: target.id },
  }).where(and(eq(notes.id, absorbed.id), eq(notes.userId, absorbed.userId), isNull(notes.archivedAt))).returning({ id: notes.id });
  if (!gone) return { outcome: 'not_live' };
  const [live] = await db.select().from(notes).where(and(eq(notes.id, target.id), liveLessonsOf(target.userId)));
  if (!live) {
    // The target went meanwhile: the absorbed note stays as it was.
    await db.update(notes).set({ archivedAt: null, frontmatter: absorbed.frontmatter }).where(eq(notes.id, absorbed.id));
    return { outcome: 'not_live' };
  }
  const written = await writeLessonMerge(target, decision.verdict === 'merged' ? decision : null, mergedFrontmatter(live.frontmatter, {
    lessonKind: incoming.lessonKind, sightings: incoming.sightings, sessions: incoming.sessions,
    learningJobIds: incoming.learningJobIds, sources: incoming.sources }));
  const mergeDegraded = (decision.verdict === 'unchanged' && decision.degradedReason !== undefined) || written.concurrent;
  coreLogger.info({ noteId: target.id, absorbed: absorbed.id, rewritten: written.rewritten, mergeDegraded }, 'Lesson note absorbed into another');
  return { outcome: 'merged', mergeDegraded };
}

/**
 * Step 5: greedy pairwise merging of `userId`'s near-duplicate lesson notes,
 * as for proposals (a pair the model calls distinct, or cannot judge in the
 * related band, is not asked again this run and costs no budget). Returns
 * the notes absorbed and how many of those merges only counted.
 */
export async function consolidateLessonNotes(userId: string, opts: { maxMerges: number }): Promise<{ merged: number; degraded: number }> {
  const { duplicateSimilarity, relatedSimilarity } = getConfig().learning;
  const out = { merged: 0, degraded: 0 };
  const distinct = new Set<string>();
  const threshold = Math.min(relatedSimilarity, duplicateSimilarity);
  let mergedThisRound = true;
  while (mergedThisRound && out.merged < opts.maxMerges) {
    mergedThisRound = false;
    const pairs = (await similarLessonPairs(userId, threshold)).filter(pair => !distinct.has(`${pair.a}:${pair.b}`));
    if (pairs.length === 0) break;
    const ids = [...new Set(pairs.flatMap(pair => [pair.a, pair.b]))];
    const rows = new Map((await getDb().select().from(notes).where(and(inArray(notes.id, ids), liveLessonsOf(userId)))).map(row => [row.id, row]));
    const touched = new Set<string>();
    const best = (pair: Pair): Note | undefined => {
      const x = rows.get(pair.a);
      const y = rows.get(pair.b);
      return x && y ? (betterLessonTarget(x, y) ? x : y) : x ?? y;
    };
    // The pair holding the best target of all first, as for proposals.
    pairs.sort((p, q) => {
      const bp = best(p);
      const bq = best(q);
      if (bp && bq && bp.id !== bq.id) return betterLessonTarget(bp, bq) ? -1 : 1;
      return q.similarity - p.similarity;
    });
    for (const pair of pairs) {
      if (out.merged >= opts.maxMerges) break;
      if (touched.has(pair.a) || touched.has(pair.b)) continue;
      const x = rows.get(pair.a);
      const y = rows.get(pair.b);
      if (!x || !y) continue;
      const [target, absorbed] = betterLessonTarget(x, y) ? [x, y] : [y, x];
      const result = await absorbLessonNote(absorbed, target, { allowDistinct: pair.similarity < duplicateSimilarity });
      if (result.outcome === 'distinct') {
        distinct.add(`${pair.a}:${pair.b}`);
        continue;
      }
      touched.add(pair.a);
      touched.add(pair.b);
      if (result.outcome === 'not_live') continue;
      out.merged++;
      if (result.mergeDegraded) out.degraded++;
      mergedThisRound = true;
    }
  }
  return out;
}

/**
 * Step 6: archive `userId`'s lesson notes that are not pinned and were
 * neither updated nor shown within `learning.lessonTtlDays`: the later of the
 * note's `updated_at` and its chunks' latest `last_accessed_at` is older than
 * that. `updated_at` moves on every save (an edit, a merge from a review that
 * saw the lesson again, a consolidation merge into it) and on pin or unpin;
 * `last_accessed_at` moves when a search returns the chunk (recall counts only
 * the passages it shows; search_notes, search_knowledge, the knowledge API and
 * link suggestions count what they return), never when it is indexed. A
 * re-index replaces the chunks (no `last_accessed_at`), but it comes with a
 * save, which moves `updated_at`. Archived, never deleted. Returns how many;
 * 0 days archives none.
 */
export async function expireLessonNotes(userId: string): Promise<number> {
  const { lessonTtlDays } = getConfig().learning;
  if (lessonTtlDays <= 0) return 0;
  const cutoff = new Date(Date.now() - lessonTtlDays * 24 * 60 * 60 * 1000);
  const archived = await getDb().update(notes).set({ archivedAt: new Date(), updatedAt: new Date() }).where(and(
    liveLessonsOf(userId), eq(notes.pinned, false), lt(notes.updatedAt, cutoff),
    sql`NOT EXISTS (SELECT 1 FROM ${embeddings} e WHERE e.source_id = 'note:' || ${notes.id}::text AND e.user_id = ${userId}::uuid
      AND e.last_accessed_at >= ${cutoff.toISOString()}::timestamptz)`,
  )).returning({ id: notes.id });
  if (archived.length) coreLogger.info({ userId, archived: archived.length, lessonTtlDays }, 'Unused lesson notes archived');
  return archived.length;
}

// ── daily maintenance ─────────────────────────────────────────────

/** The `kv_store` key holding the last daily run (epoch milliseconds). */
export const MAINTENANCE_KEY = 'learning:maintenance:last-run';
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

/** How long a claimed run blocks other processes before it counts as interrupted. */
export const MAINTENANCE_LEASE_MS = 2 * 60 * 60 * 1000;

/**
 * Claim today's run unless the stored last run is less than 24 h old. One
 * statement, so of two processes ticking at once exactly one wins.
 *
 * The claim is a lease, not the run: it stores a last run of
 * `now - 24 h + lease`, which blocks every other claim for the lease (ample
 * for a run) and no longer, so a run cut short by a restart (a deploy right
 * after boot) is retried after 2 hours instead of skipped for a day.
 * `recordDailyRun` stores the real time once the run is done. Kept as one
 * epoch number so the key still reads as "last run".
 */
async function claimDailyRun(now: number): Promise<boolean> {
  const leased = String(now - DAY_MS + MAINTENANCE_LEASE_MS);
  const rows = await getDb().insert(kvStore)
    .values({ key: MAINTENANCE_KEY, value: leased, expiresAt: null })
    .onConflictDoUpdate({
      target: kvStore.key,
      set: { value: leased, expiresAt: null },
      // A value that is not a number (hand-edited) counts as never run.
      setWhere: sql`CASE WHEN ${kvStore.value} ~ '^[0-9]+$' THEN ${kvStore.value}::bigint <= ${now - DAY_MS} ELSE true END`,
    })
    .returning({ key: kvStore.key });
  return rows.length > 0;
}

/** The run finished: the next one is due 24 h from now. Logged, not thrown: the lease still bounds a retry. */
async function recordDailyRun(now: number): Promise<void> {
  try {
    await getDb().insert(kvStore).values({ key: MAINTENANCE_KEY, value: String(now), expiresAt: null })
      .onConflictDoUpdate({ target: kvStore.key, set: { value: String(now), expiresAt: null } });
  } catch (err) {
    coreLogger.error({ err }, 'Daily learning maintenance: could not record the finished run; it runs again once the lease ends');
  }
}

export type MaintenanceResult =
  | { ran: false }
  | { ran: true; users: number; failed: number; report: ConsolidationReport; curator: { archived: number; flagged: number } | null };

/**
 * Consolidate every user with open proposals, then run the skill curator, at
 * most once per 24 hours (claimed in `kv_store` as a lease, recorded when
 * done). A failing user or curator is logged and the rest goes on; only the
 * claim and the listing of users can throw (the lease then bounds the retry).
 */
export async function runDailyLearningMaintenance(): Promise<MaintenanceResult> {
  if (!(await claimDailyRun(Date.now()))) return { ran: false };
  const db = getDb();
  const [withProposals, withLessons] = await Promise.all([
    db.selectDistinct({ userId: skillProposals.userId }).from(skillProposals)
      .where(and(inArray(skillProposals.status, OPEN), ne(skillProposals.kind, 'patch'))),
    db.selectDistinct({ userId: notes.userId }).from(notes).where(and(eq(notes.noteKind, 'lesson'), isNull(notes.archivedAt))),
  ]);
  const owners = [...new Set([...withProposals, ...withLessons].map(row => row.userId))].map(userId => ({ userId }));
  const total = emptyReport();
  let failed = 0;
  for (const { userId } of owners) {
    try {
      const report = await consolidateProposals(userId);
      for (const key of Object.keys(total) as Array<keyof ConsolidationReport>) total[key] += report[key];
    } catch (err) {
      failed++;
      coreLogger.error({ err, userId }, 'Daily learning maintenance: consolidating this user\'s skill proposals and lesson notes failed');
    }
  }
  let curator: { archived: number; flagged: number } | null = null;
  try {
    const result = await runSkillCurator();
    curator = { archived: result.archived.length, flagged: result.flagged.length };
  } catch (err) {
    coreLogger.error({ err }, 'Daily learning maintenance: the skill curator failed');
  }
  await recordDailyRun(Date.now());
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
