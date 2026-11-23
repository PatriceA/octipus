/**
 * Filing a lesson from a learning review as a lesson note
 * (docs/plans/learning-notes-and-skill-discovery.md, "Filing a lesson").
 *
 * A lesson note is a personal note of the job's workspace with
 * `note_kind = 'lesson'`, the tag `session-learning` and its chunks indexed
 * under `purpose = 'lesson'` (NoteService). The body holds the lesson only;
 * the evidence is in the frontmatter (`LessonFrontmatter`).
 *
 * `fileLessonNote(item, ctx)`, cheapest check first:
 *   1. `extends` names a lesson note of this user and workspace: merge into it;
 *   2. the same normalized content (slug `learning-<hash>`): a live note is
 *      counted again;
 *   3. the nearest lesson note by embedding (`purpose = 'lesson'` rows of this
 *      user and workspace): a live one at or above `learning.duplicateSimilarity`
 *      as a note (`noteLevelDuplicate`: every chunk of the shorter side has a
 *      match there, not just one shared passage) is merged into; a live one in
 *      the related band (or a duplicate by one passage only) is merged into
 *      unless the merge model says it is another lesson;
 *   4. otherwise a new lesson note.
 *
 * A duplicate (by 1, 2 or 3) of an archived lesson note depends on who
 * archived it (`resolveLessonTarget`): consolidation merged it into another
 * (`frontmatter.mergedInto`): counted on that note, followed on while that one
 * was merged too, at most MAX_MERGED_HOPS; expiry (`frontmatter.archivedBy =
 * 'expiry'`): the note is unarchived and counted, so it is recalled again; the
 * user (no mark; archiving through the notes API, UI or tool drops the marks):
 * the lesson is dropped as a `duplicate`.
 *
 * A merge is one background-model call (`{verdict, title, content}`, the
 * contract and degradation of `mergeIntoProposal`): without a usable model a
 * duplicate is counted only (`mergeDegraded`) and a related pair stays apart.
 * Without an embedding model only steps 1, 2 and 4 run.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { filterPII } from '@/core/agent/pii-filter';
import { capabilityConfigured } from '@/core/capabilities/gates';
import { getNoteService, NoteExistsError } from '@/core/knowledge/notes';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { getNoteRepository, personalNoteScope } from '@/db/repositories/note-repository';
import { notInSharedWorkspace } from '@/db/repositories/scoped';
import { embeddings } from '@/db/schema/embeddings';
import { type Note, notes } from '@/db/schema/notes';
import { callMergeModel, readMergeJson } from '@/services/skill-proposal-merge';
import { LESSON_KINDS, type LessonFrontmatter, type LessonKind, MAX_LESSON_REFS } from '@/shared/learning';
import { coreLogger } from '@/utils/logger';

/** The tag every note written by a learning review carries. */
export const LESSON_TAG = 'session-learning';
/** Most characters of a lesson note's body. */
export const MAX_LESSON_CHARS = 4000;

/** A knowledge item of a learning review (review.ts), with `extends` already checked against what was offered. */
export interface LessonItem {
  title: string;
  content: string;
  kind: LessonKind;
  /** `note:<id>` of a lesson note offered in the review's `existing.notes`. */
  extends?: string;
  sources: string[];
}

export interface LessonContext {
  userId: string;
  /** The job's workspace: a personal one (never a shared space). */
  workspaceId: string;
  sessionId: string;
  jobId: string;
}

export interface FileLessonResult {
  status: 'saved' | 'merged' | 'duplicate' | 'saved_unindexed';
  /** The note written, merged into, or (for a duplicate) the archived note that already says it. */
  id: string;
  merged?: boolean;
  /** The merge model could not be used: the lesson was counted, the text is unchanged. */
  mergeDegraded?: boolean;
  detail?: string;
}

type DegradedReason = 'no_model' | 'truncated' | 'malformed' | 'model_error' | 'concurrent_change';

/** A legacy body's trailing "Evidence: session …; …. Learning check ….", as the processor wrote it before lesson notes. */
const EVIDENCE_FOOTER = /\s*\n?Evidence: session [^\n]*\. Learning check [^\s.]+\.\s*$/;

/** `body` without the legacy evidence footer (and trailing whitespace). */
export function stripEvidenceFooter(body: string): string {
  let out = body;
  while (EVIDENCE_FOOTER.test(out)) out = out.replace(EVIDENCE_FOOTER, '');
  return out.trimEnd();
}

/** The slug of a lesson: its normalized content's hash, so identical lessons share one note. */
export function lessonSlug(body: string): string {
  const fingerprint = createHash('sha256').update(body.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 24);
  return `learning-${fingerprint}`;
}

/** `list` with each of `added` moved to (or put at) the end, at most MAX_LESSON_REFS, newest last. */
export function appendRefs(list: readonly string[], added: readonly string[]): string[] {
  const out = list.filter(item => !added.includes(item));
  for (const item of added) if (!out.includes(item)) out.push(item);
  return out.slice(-MAX_LESSON_REFS);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * A lesson note's frontmatter, read leniently: a note written before lesson
 * notes carries `sessionId` / `learningJobId` (one each) and no `sightings`.
 */
export function lessonFrontmatterOf(frontmatter: Record<string, unknown>, fallbackKind: LessonKind = 'fact'): LessonFrontmatter {
  const legacy = (key: string) => (typeof frontmatter[key] === 'string' ? [frontmatter[key] as string] : []);
  const kind = LESSON_KINDS.find(k => k === frontmatter.lessonKind) ?? fallbackKind;
  const sightings = typeof frontmatter.sightings === 'number' && Number.isFinite(frontmatter.sightings) && frontmatter.sightings >= 1
    ? Math.floor(frontmatter.sightings) : 1;
  return {
    lessonKind: kind,
    sightings,
    sessions: appendRefs(legacy('sessionId'), strings(frontmatter.sessions)),
    learningJobIds: appendRefs(legacy('learningJobId'), strings(frontmatter.learningJobIds)),
    sources: appendRefs([], strings(frontmatter.sources)),
    ...(typeof frontmatter.mergedInto === 'string' ? { mergedInto: frontmatter.mergedInto } : {}),
  };
}

/**
 * The frontmatter of `target` after absorbing `incoming` (a lesson or another
 * note): the lists appended, `sightings` added, legacy single-value keys
 * dropped. Other keys of the target are kept.
 */
export function mergedFrontmatter(target: Record<string, unknown>, incoming: Omit<LessonFrontmatter, 'mergedInto'>): Record<string, unknown> {
  const current = lessonFrontmatterOf(target, incoming.lessonKind);
  const { sessionId: _s, learningJobId: _j, ...rest } = target;
  void _s; void _j;
  const next: LessonFrontmatter = {
    lessonKind: current.lessonKind,
    sightings: current.sightings + incoming.sightings,
    sessions: appendRefs(current.sessions, incoming.sessions),
    learningJobIds: appendRefs(current.learningJobIds, incoming.learningJobIds),
    sources: appendRefs(current.sources, incoming.sources),
  };
  return { ...rest, ...next };
}

// ── merge model ───────────────────────────────────────────────────

const MERGE_PROMPT = `You maintain lesson notes: what is true about a project, or what was decided and why. EXISTING is a lesson note; INCOMING is a new observation that may be the same lesson.
Reply with ONLY a JSON object: {"verdict": "merged" | "unchanged" | "distinct", "title": string, "content": string}.
- "merged": INCOMING adds to, corrects or updates EXISTING. Return the combined note: "title" a short name of the lesson, "content" the lesson in markdown. Keep what in EXISTING is still true, prefer INCOMING where they conflict, keep the alternative a decision rejected, drop session details (ids, dates, people, secrets). At most ${MAX_LESSON_CHARS} characters.
- "unchanged": INCOMING adds nothing new. "title" and "content" are "".
- "distinct": INCOMING is a different lesson. Only when "allowDistinct" is true; otherwise choose "merged" or "unchanged".`;

const lessonMergeReply = z.object({ verdict: z.enum(['merged', 'unchanged', 'distinct']), title: z.string(), content: z.string() });

export type LessonMergeReply =
  | { kind: 'merged'; title: string; content: string }
  | { kind: 'unchanged' }
  | { kind: 'distinct' }
  | { kind: 'truncated' }
  | { kind: 'malformed'; reason: string };

/** Classify the lesson merge model's reply, as `interpretMergeReply` does for skills. A `merged` reply is PII-filtered and capped. */
export function interpretLessonMergeReply(raw: string, finishReason: string | undefined, allowDistinct: boolean): LessonMergeReply {
  const json = readMergeJson(raw, finishReason);
  if (json.kind !== 'json') return json;
  const reply = lessonMergeReply.safeParse(json.value);
  if (!reply.success) return { kind: 'malformed', reason: 'verdict, title and content are required' };
  if (reply.data.verdict === 'distinct') return allowDistinct ? { kind: 'distinct' } : { kind: 'unchanged' };
  if (reply.data.verdict === 'unchanged') return { kind: 'unchanged' };
  const title = filterPII(reply.data.title.trim()).filtered.slice(0, 150);
  const content = filterPII(stripEvidenceFooter(reply.data.content.trim())).filtered.slice(0, MAX_LESSON_CHARS);
  if (!title || !content) return { kind: 'malformed', reason: 'a merged reply needs a title and content' };
  return { kind: 'merged', title, content };
}

/** The two texts a lesson merge compares. */
export interface LessonText { title: string; content: string; kind: LessonKind }

export type LessonMergeDecision =
  | { verdict: 'distinct'; degradedReason?: Exclude<DegradedReason, 'concurrent_change'> }
  | { verdict: 'merged'; title: string; content: string }
  | { verdict: 'unchanged'; degradedReason?: Exclude<DegradedReason, 'concurrent_change'> };

/**
 * Ask the background model whether `incoming` adds to `existing`. Without a
 * usable answer: `distinct` in the related band (`allowDistinct`), where only
 * the model could make them one lesson; otherwise a count-only `unchanged`
 * with `degradedReason`.
 */
export async function decideLessonMerge(existing: LessonText, incoming: LessonText, ctx: { userId: string; noteId: string; allowDistinct: boolean }): Promise<LessonMergeDecision> {
  const input = JSON.stringify({ allowDistinct: ctx.allowDistinct, existing, incoming });
  const call = await callMergeModel(MERGE_PROMPT, input, { userId: ctx.userId, requestType: 'lesson-note-merge',
    log: { noteId: ctx.noteId }, failure: 'Lesson note merge: the model call failed' });
  const reply = call.kind === 'reply' ? interpretLessonMergeReply(call.content, call.finishReason, ctx.allowDistinct) : call;
  if (reply.kind === 'merged') return { verdict: 'merged', title: reply.title, content: reply.content };
  if (reply.kind === 'unchanged') return { verdict: 'unchanged' };
  if (reply.kind === 'distinct') return { verdict: 'distinct' };
  const detail = reply.kind === 'malformed' ? { detail: reply.reason } : {};
  if (ctx.allowDistinct) {
    coreLogger.warn({ noteId: ctx.noteId, reason: reply.kind, ...detail }, 'Lesson note merge: the merge model could not judge a related pair; keeping them apart');
    return { verdict: 'distinct', degradedReason: reply.kind };
  }
  coreLogger.warn({ noteId: ctx.noteId, reason: reply.kind, ...detail }, 'Lesson note merge degraded to a count-only merge');
  return { verdict: 'unchanged', degradedReason: reply.kind };
}

// ── writes ────────────────────────────────────────────────────────

/** The incoming side of a merge: one lesson (one sighting) or an absorbed note's evidence. */
export type IncomingEvidence = Omit<LessonFrontmatter, 'mergedInto' | 'archivedBy' | 'distinctFrom'>;

/** Whether two lesson bodies are the same text once the legacy footer, case and whitespace are set aside. */
export function sameLessonText(a: string, b: string): boolean {
  const norm = (text: string) => stripEvidenceFooter(text).toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

/**
 * Write `next(frontmatter)` over note `id`'s frontmatter only while it is
 * still the one read (compare-and-set on the jsonb value): a concurrent merge
 * into the same note is re-read and applied on top, once. Throws when it
 * changed again: the count is then reported as failed, never lost silently.
 */
async function casFrontmatter(note: Pick<Note, 'id' | 'userId' | 'frontmatter'>, next: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  let current = note.frontmatter;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const row = await getNoteRepository().getById(note.userId, note.id);
      if (!row) throw new Error(`Lesson note ${note.id} vanished during a merge`);
      current = row.frontmatter;
    }
    const [hit] = await getDb().update(notes).set({ frontmatter: next(current) })
      .where(and(eq(notes.id, note.id), eq(notes.userId, note.userId), sql`${notes.frontmatter} = ${JSON.stringify(current)}::jsonb`))
      .returning({ id: notes.id });
    if (hit) return;
  }
  throw new Error(`Lesson note ${note.id} changed twice while a merge was counting into it; this sighting was not counted`);
}

export interface LessonMergeWrite {
  /** False only with `onConcurrentChange: 'skip'` when the body changed since `target` was read: nothing was written. */
  written: boolean;
  indexed: boolean;
  rewritten: boolean;
  concurrent: boolean;
}

/**
 * Write a merge into lesson note `target` (as read before the model call):
 * the model's text when it rewrote the note and the body has not changed
 * since `target` was read, the legacy evidence footer removed; `incoming`'s
 * evidence counted into the frontmatter as it is now (re-read here, and
 * written by compare-and-set, so two merges at once both count). A rewrite
 * clears `distinctFrom`: the text the verdicts were about is gone.
 *
 * When the body changed meanwhile (`concurrent`): `count` writes a
 * count-only merge (the filing path: the sighting is kept); `skip` writes
 * nothing (consolidation: the absorbed note stays live and is retried).
 * Through NoteService.save, so it is re-linked and re-indexed.
 */
export async function writeLessonMerge(target: Note, text: { title: string; content: string } | null, incoming: IncomingEvidence,
  opts: { onConcurrentChange: 'count' | 'skip' } = { onConcurrentChange: 'count' }): Promise<LessonMergeWrite> {
  const scope = personalNoteScope(target.userId, target.workspaceId);
  const current = await getNoteRepository().getById(target.userId, target.id);
  if (!current) throw new Error(`Lesson note ${target.id} vanished during a merge`);
  const concurrent = text !== null && current.bodySha256 !== target.bodySha256;
  if (concurrent && opts.onConcurrentChange === 'skip') return { written: false, indexed: false, rewritten: false, concurrent };
  const rewrite = text !== null && !concurrent;
  // The text first, its frontmatter left alone (save writes none here).
  const saved = await getNoteService().save({
    scope, id: current.id,
    title: rewrite ? text.title : current.title,
    body: rewrite ? text.content : stripEvidenceFooter(current.body),
    noteKind: 'lesson',
    tags: current.tags.includes(LESSON_TAG) ? current.tags : [...current.tags, LESSON_TAG],
  });
  await casFrontmatter(saved.note, (frontmatter) => {
    const next = mergedFrontmatter(frontmatter, incoming);
    if (rewrite) delete next.distinctFrom;
    return next;
  });
  return { written: true, indexed: saved.indexed, rewritten: rewrite, concurrent };
}

/** Record on both notes that the merge model judged them two lessons (consolidation asks no more about the pair). */
export async function recordDistinctLessons(a: Note, b: Note): Promise<void> {
  // Re-read and compare-and-set: a verdict recorded on the note meanwhile
  // (another pair of this run) or a count into it is kept.
  const append = async (id: string, userId: string, other: string) => {
    const note = await getNoteRepository().getById(userId, id);
    if (!note) return;
    await casFrontmatter(note, (frontmatter) => ({ ...frontmatter, distinctFrom: appendRefs(strings(frontmatter.distinctFrom), [other]) }));
  };
  await append(a.id, a.userId, b.id);
  await append(b.id, b.userId, a.id);
}

/** Whether `a` and `b` each list the other as a distinct lesson (a rewrite of either clears its list). */
export function knownDistinct(a: Note, b: Note): boolean {
  return strings(a.frontmatter.distinctFrom).includes(b.id) && strings(b.frontmatter.distinctFrom).includes(a.id);
}

/**
 * Whether two notes say the same thing as notes, not only in one passage:
 * `na`/`nb` chunks, of which `ma`/`mb` have a match at or above
 * `duplicateSimilarity` in the other. Every chunk of the shorter note (fewer
 * chunks) must have one. Two one-chunk notes: their single pair decides.
 */
export function noteLevelDuplicate(na: number, ma: number, nb: number, mb: number): boolean {
  if (na === 0 || nb === 0) return false;
  return na <= nb ? ma === na : mb === nb;
}

interface Neighbour { id: string; archived: boolean; similarity: number }

const vectorLiteral = (vector: number[]) => `[${vector.join(',')}]`;

/**
 * Lesson notes of `userId` in `workspaceId` nearest to `vectors` (the
 * incoming lesson's chunks), by their `purpose = 'lesson'` chunks (the best
 * chunk pair per note), archived ones included and flagged. Vectors of
 * another dimension are skipped.
 */
async function nearestLessons(userId: string, workspaceId: string, vectors: number[][]): Promise<Neighbour[]> {
  const query = sql.join(vectors.map((v, i) => sql`(${i}, ${vectorLiteral(v)}::vector)`), sql`, `);
  const res = await getDb().execute(sql`
    WITH q(i, v) AS (VALUES ${query})
    SELECT n.id AS id, (n.archived_at IS NOT NULL) AS archived, max(1 - (e.embedding <=> q.v)) AS similarity
    FROM ${embeddings} e
    JOIN ${notes} n ON e.source_id = 'note:' || n.id::text
    CROSS JOIN q
    WHERE e.purpose = 'lesson' AND e.user_id = ${userId}::uuid AND e.workspace_id = ${workspaceId}::uuid
      AND n.user_id = ${userId}::uuid AND n.workspace_id = ${workspaceId}::uuid AND n.note_kind = 'lesson' AND ${notInSharedWorkspace(sql`n.workspace_id`)}
      AND vector_dims(e.embedding) = ${vectors[0].length}
    GROUP BY n.id, n.archived_at
    ORDER BY similarity DESC, n.id
    LIMIT 10
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{ id: string; archived: boolean; similarity: number | string }>;
  return rows.map(row => ({ id: row.id, archived: Boolean(row.archived), similarity: Number(row.similarity) }));
}

/** Whether the incoming lesson (`vectors`, its chunks) and note `noteId` are duplicates as notes (`noteLevelDuplicate`). */
async function duplicateAsNotes(userId: string, workspaceId: string, noteId: string, vectors: number[][], threshold: number): Promise<boolean> {
  const query = sql.join(vectors.map((v, i) => sql`(${i}, ${vectorLiteral(v)}::vector)`), sql`, `);
  const res = await getDb().execute(sql`
    WITH q(i, v) AS (VALUES ${query}),
    c AS (
      SELECT e.embedding FROM ${embeddings} e
      WHERE e.source_id = ${`note:${noteId}`} AND e.purpose = 'lesson' AND e.user_id = ${userId}::uuid
        AND e.workspace_id = ${workspaceId}::uuid AND vector_dims(e.embedding) = ${vectors[0].length}
    )
    SELECT (SELECT count(*) FROM q)::int AS nq, (SELECT count(*) FROM c)::int AS nc,
      (SELECT count(*) FROM q WHERE EXISTS (SELECT 1 FROM c WHERE 1 - (c.embedding <=> q.v) >= ${threshold}))::int AS mq,
      (SELECT count(*) FROM c WHERE EXISTS (SELECT 1 FROM q WHERE 1 - (c.embedding <=> q.v) >= ${threshold}))::int AS mc
  `);
  const [row] = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{ nq: number; nc: number; mq: number; mc: number }>;
  return Boolean(row) && noteLevelDuplicate(Number(row.nq), Number(row.mq), Number(row.nc), Number(row.mc));
}

/**
 * The incoming lesson's chunk vectors, chunked as the index chunks a body
 * (`chunkText`): one vector for a lesson of one chunk. Throws when any chunk
 * could not be embedded.
 */
async function lessonVectors(body: string): Promise<number[][]> {
  const service = getEmbeddingService();
  const chunks = service.chunkText(body);
  if (chunks.length <= 1) return [await service.generateEmbedding(body, 'document')];
  const vectors = await service.embedBatch(chunks, 'document');
  const failed = vectors.find((v): v is Error => v instanceof Error);
  if (failed) throw failed;
  return vectors as number[][];
}

/** A lesson note of exactly this user and workspace (archived or not), or null. */
async function lessonNoteOf(ctx: LessonContext, id: string): Promise<Note | null> {
  const note = await getNoteRepository().getById(ctx.userId, id);
  return note && note.workspaceId === ctx.workspaceId && note.noteKind === 'lesson' ? note : null;
}

/** The most `mergedInto` links followed from an archived lesson to a live one. */
export const MAX_MERGED_HOPS = 5;

/** Who archived a lesson note: consolidation (`merged`, into `mergedInto`), expiry, or the user (no system mark). */
function archivedBy(note: Note): 'merged' | 'expiry' | 'user' {
  if (typeof note.frontmatter.mergedInto === 'string') return 'merged';
  return note.frontmatter.archivedBy === 'expiry' ? 'expiry' : 'user';
}

/**
 * Unarchive a lesson note expiry archived, dropping the mark; its chunks were
 * kept, so it is searchable again at once (the merge that follows re-indexes a
 * changed body). Null when it is no longer an expired lesson (revived or
 * archived by the user meanwhile).
 */
async function reviveExpiredLesson(note: Note): Promise<Note | null> {
  const [row] = await getDb().update(notes)
    .set({ archivedAt: null, updatedAt: new Date(), frontmatter: sql`${notes.frontmatter} - 'archivedBy'` })
    .where(and(eq(notes.id, note.id), eq(notes.userId, note.userId), eq(notes.noteKind, 'lesson'), isNotNull(notes.archivedAt),
      sql`${notes.frontmatter}->>'archivedBy' = 'expiry'`, sql`NOT (${notes.frontmatter} ? 'mergedInto')`))
    .returning();
  return row ?? null;
}

type ResolvedTarget =
  | { kind: 'live'; note: Note; via: 'live' | 'merged' | 'revived' }
  | { kind: 'dropped'; note: Note; reason: 'user_archived' | 'merge_target_gone' | 'too_many_hops' };

/**
 * Where a duplicate of lesson note `found` is counted: `found` when live; the
 * live note it was merged into (following `mergedInto`, at most
 * MAX_MERGED_HOPS); `found` revived when expiry archived it; nowhere when the
 * user archived it (or the note it was merged into is gone).
 */
async function resolveLessonTarget(ctx: LessonContext, found: Note): Promise<ResolvedTarget> {
  let note = found;
  let via: 'live' | 'merged' = 'live';
  for (let hop = 0; hop <= MAX_MERGED_HOPS; hop++) {
    if (!note.archivedAt) return { kind: 'live', note, via };
    const by = archivedBy(note);
    if (by === 'user') return { kind: 'dropped', note, reason: 'user_archived' };
    if (by === 'expiry') {
      const revived = await reviveExpiredLesson(note);
      if (revived) return { kind: 'live', note: revived, via: 'revived' };
      const now = await lessonNoteOf(ctx, note.id);
      if (!now) return { kind: 'dropped', note, reason: 'merge_target_gone' };
      note = now;
      continue;
    }
    const next = await lessonNoteOf(ctx, note.frontmatter.mergedInto as string);
    if (!next) return { kind: 'dropped', note, reason: 'merge_target_gone' };
    note = next;
    via = 'merged';
  }
  return { kind: 'dropped', note, reason: 'too_many_hops' };
}

/** The incoming lesson's frontmatter (one sighting). */
function incomingFrontmatter(item: LessonItem, ctx: LessonContext): IncomingEvidence {
  return { lessonKind: item.kind, sightings: 1, sessions: [ctx.sessionId], learningJobIds: [ctx.jobId], sources: appendRefs([], item.sources) };
}

/**
 * File one lesson of a learning review (see the module comment). The caller
 * has checked the knowledge permission. Throws on a failed write.
 */
export async function fileLessonNote(item: LessonItem, ctx: LessonContext): Promise<FileLessonResult> {
  const title = filterPII(item.title).filtered.slice(0, 150);
  const body = filterPII(stripEvidenceFooter(item.content)).filtered.slice(0, MAX_LESSON_CHARS);
  const lesson: LessonText = { title, content: body, kind: item.kind };
  const slug = lessonSlug(body);
  const log = { userId: ctx.userId, jobId: ctx.jobId, slug };

  const merge = async (found: Note, how: { allowDistinct: boolean; identical?: boolean }): Promise<FileLessonResult | null> => {
    const resolved = await resolveLessonTarget(ctx, found);
    if (resolved.kind === 'dropped') {
      coreLogger.info({ ...log, decision: 'archived_duplicate', against: found.id, reason: resolved.reason }, 'Lesson note filing decision');
      return { status: 'duplicate', id: resolved.note.id, detail: 'A lesson note you archived already says this' };
    }
    const target = resolved.note;
    if (resolved.via !== 'live') coreLogger.info({ ...log, decision: resolved.via, from: found.id, to: target.id }, 'Lesson note filing: an archived duplicate leads to a live note');
    const existing: LessonText = { title: target.title, content: stripEvidenceFooter(target.body), kind: lessonFrontmatterOf(target.frontmatter).lessonKind };
    // Identical text needs no model: it is the same lesson seen again.
    const identical = (how.identical && target.id === found.id) || sameLessonText(target.body, body);
    const decision: LessonMergeDecision = identical ? { verdict: 'unchanged' }
      : await decideLessonMerge(existing, lesson, { userId: ctx.userId, noteId: target.id, allowDistinct: how.allowDistinct });
    if (decision.verdict === 'distinct') return null;
    const written = await writeLessonMerge(target, decision.verdict === 'merged' ? decision : null, incomingFrontmatter(item, ctx));
    const degradedReason: DegradedReason | undefined = decision.verdict === 'unchanged' ? decision.degradedReason : written.concurrent ? 'concurrent_change' : undefined;
    coreLogger.info({ ...log, decision: 'merged', against: target.id, rewritten: written.rewritten, degradedReason }, 'Lesson note filing decision');
    return {
      status: written.indexed ? 'merged' : 'saved_unindexed', id: target.id, merged: true,
      ...(degradedReason ? { mergeDegraded: true } : {}),
      ...(!written.indexed ? { detail: 'Merged into a lesson note; embedding/indexing unavailable' }
        : degradedReason ? { detail: `Counted only: ${degradedReason.replace('_', ' ')}` } : {}),
    };
  };

  // 1. extends: a lesson note offered to this review.
  if (item.extends) {
    const target = await lessonNoteOf(ctx, item.extends.replace(/^note:/, ''));
    if (target) {
      const result = await merge(target, { allowDistinct: false });
      if (result) return result;
    } else {
      coreLogger.warn({ ...log, extends: item.extends }, 'Lesson note filing: the extended note is gone; filing the lesson on its own');
    }
  }

  // 2. The same content.
  const sameSlug = await getNoteRepository().getBySlug(ctx.userId, ctx.workspaceId, slug);
  if (sameSlug && sameSlug.workspaceId === ctx.workspaceId) {
    const result = await merge(sameSlug, { allowDistinct: false, identical: true });
    if (result) return result;
  }

  // 3. The nearest lesson note by meaning. A duplicate must be one as a note
  // (`noteLevelDuplicate`), not by one shared passage: otherwise it is related.
  let related: Note | null = null;
  if (await capabilityConfigured('embedding')) {
    let vectors: number[][] | null = null;
    try {
      vectors = await lessonVectors(body);
    } catch (err) {
      coreLogger.warn({ err, ...log }, 'Lesson note filing: could not embed the lesson; comparing by exact content only');
    }
    if (vectors) {
      const { duplicateSimilarity, relatedSimilarity } = getConfig().learning;
      const near = await nearestLessons(ctx.userId, ctx.workspaceId, vectors);
      const duplicate = async (n: Neighbour | undefined) => n !== undefined && n.similarity >= duplicateSimilarity
        && await duplicateAsNotes(ctx.userId, ctx.workspaceId, n.id, vectors, duplicateSimilarity);
      const live = near.find(n => !n.archived);
      const archived = near.find(n => n.archived);
      if (await duplicate(live)) {
        const target = await lessonNoteOf(ctx, live!.id);
        if (target) return (await merge(target, { allowDistinct: false }))!;
      }
      // An archived duplicate: counted where it leads (merged into, or
      // revived from expiry), or dropped when the user archived it.
      if (await duplicate(archived)) {
        const found = await lessonNoteOf(ctx, archived!.id);
        if (found) {
          coreLogger.info({ ...log, similarity: archived!.similarity, against: archived!.id }, 'Lesson note filing: an archived lesson note says this');
          return (await merge(found, { allowDistinct: false }))!;
        }
      }
      if (live && live.similarity >= relatedSimilarity) related = await lessonNoteOf(ctx, live.id);
    }
  }
  if (related) {
    const result = await merge(related, { allowDistinct: true });
    if (result) return result;
  }

  // 4. A new lesson note.
  try {
    const saved = await getNoteService().save({
      scope: personalNoteScope(ctx.userId, ctx.workspaceId), slug, title, body, noteKind: 'lesson', tags: [LESSON_TAG],
      frontmatter: { ...incomingFrontmatter(item, ctx) }, createOnly: true,
    });
    coreLogger.info({ ...log, decision: 'new', id: saved.note.id }, 'Lesson note filing decision');
    return saved.indexed ? { status: 'saved', id: saved.note.id }
      : { status: 'saved_unindexed', id: saved.note.id, detail: 'Note saved; embedding/indexing unavailable' };
  } catch (err) {
    // Another review wrote the same lesson meanwhile: count it there.
    if (!(err instanceof NoteExistsError)) throw err;
    const target = await lessonNoteOf(ctx, err.noteId);
    if (!target) throw err;
    return (await merge(target, { allowDistinct: false, identical: true }))!;
  }
}
