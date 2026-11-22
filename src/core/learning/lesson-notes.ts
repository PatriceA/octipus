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
 *      counted again, an archived one drops the lesson;
 *   3. the nearest lesson note by embedding (`purpose = 'lesson'` rows of this
 *      user and workspace): a live one at or above `learning.duplicateSimilarity`
 *      is merged into, an archived one there drops the lesson (the user's
 *      archive is never revived); a live one in the related band is merged
 *      into unless the merge model says it is another lesson;
 *   4. otherwise a new lesson note.
 *
 * A merge is one background-model call (`{verdict, title, content}`, the
 * contract and degradation of `mergeIntoProposal`): without a usable model a
 * duplicate is counted only (`mergeDegraded`) and a related pair stays apart.
 * Without an embedding model only steps 1, 2 and 4 run.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
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

/**
 * Write a merge into lesson note `target`: the model's text when it rewrote
 * the note and the body has not changed since it was read (else count-only,
 * `concurrent_change`), the legacy evidence footer removed, the frontmatter
 * from `frontmatter`. Through NoteService.save, so it is re-linked and
 * re-indexed. Returns whether the text changed and whether it is indexed.
 */
export async function writeLessonMerge(target: Note, text: { title: string; content: string } | null, frontmatter: Record<string, unknown>):
  Promise<{ indexed: boolean; rewritten: boolean; concurrent: boolean }> {
  const scope = personalNoteScope(target.userId, target.workspaceId);
  const current = await getNoteRepository().getById(target.userId, target.id);
  if (!current) throw new Error(`Lesson note ${target.id} vanished during a merge`);
  const concurrent = text !== null && current.bodySha256 !== target.bodySha256;
  const rewrite = text !== null && !concurrent;
  const saved = await getNoteService().save({
    scope, id: current.id,
    title: rewrite ? text.title : current.title,
    body: rewrite ? text.content : stripEvidenceFooter(current.body),
    noteKind: 'lesson',
    tags: current.tags.includes(LESSON_TAG) ? current.tags : [...current.tags, LESSON_TAG],
    frontmatter,
  });
  return { indexed: saved.indexed, rewritten: rewrite, concurrent };
}

interface Neighbour { id: string; archived: boolean; similarity: number }

/**
 * Lesson notes of `userId` in `workspaceId` nearest to `vector`, by their
 * `purpose = 'lesson'` chunks (the best chunk per note), archived ones
 * included and flagged. Vectors of another dimension are skipped.
 */
async function nearestLessons(userId: string, workspaceId: string, vector: number[]): Promise<Neighbour[]> {
  const literal = `[${vector.join(',')}]`;
  const res = await getDb().execute(sql`
    SELECT n.id AS id, (n.archived_at IS NOT NULL) AS archived, max(1 - (e.embedding <=> ${literal}::vector)) AS similarity
    FROM ${embeddings} e
    JOIN ${notes} n ON e.source_id = 'note:' || n.id::text
    WHERE e.purpose = 'lesson' AND e.user_id = ${userId}::uuid AND e.workspace_id = ${workspaceId}::uuid
      AND n.user_id = ${userId}::uuid AND n.workspace_id = ${workspaceId}::uuid AND n.note_kind = 'lesson' AND ${notInSharedWorkspace(sql`n.workspace_id`)}
      AND vector_dims(e.embedding) = ${vector.length}
    GROUP BY n.id, n.archived_at
    ORDER BY similarity DESC, n.id
    LIMIT 10
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{ id: string; archived: boolean; similarity: number | string }>;
  return rows.map(row => ({ id: row.id, archived: Boolean(row.archived), similarity: Number(row.similarity) }));
}

/** A lesson note of exactly this user and workspace (archived or not), or null. */
async function lessonNoteOf(ctx: LessonContext, id: string): Promise<Note | null> {
  const note = await getNoteRepository().getById(ctx.userId, id);
  return note && note.workspaceId === ctx.workspaceId && note.noteKind === 'lesson' ? note : null;
}

/** The incoming lesson's frontmatter (one sighting). */
function incomingFrontmatter(item: LessonItem, ctx: LessonContext): Omit<LessonFrontmatter, 'mergedInto'> {
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

  const merge = async (target: Note, how: { allowDistinct: boolean; identical?: boolean }): Promise<FileLessonResult | null> => {
    if (target.archivedAt) {
      coreLogger.info({ ...log, decision: 'archived_duplicate', against: target.id }, 'Lesson note filing decision');
      return { status: 'duplicate', id: target.id, detail: 'A lesson note you archived already says this' };
    }
    const existing: LessonText = { title: target.title, content: stripEvidenceFooter(target.body), kind: lessonFrontmatterOf(target.frontmatter).lessonKind };
    // Identical text needs no model: it is the same lesson seen again.
    const decision: LessonMergeDecision = how.identical ? { verdict: 'unchanged' }
      : await decideLessonMerge(existing, lesson, { userId: ctx.userId, noteId: target.id, allowDistinct: how.allowDistinct });
    if (decision.verdict === 'distinct') return null;
    const written = await writeLessonMerge(target, decision.verdict === 'merged' ? decision : null,
      mergedFrontmatter(target.frontmatter, incomingFrontmatter(item, ctx)));
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

  // 3. The nearest lesson note by meaning.
  let related: Note | null = null;
  if (await capabilityConfigured('embedding')) {
    let vector: number[] | null = null;
    try {
      vector = await getEmbeddingService().generateEmbedding(body, 'document');
    } catch (err) {
      coreLogger.warn({ err, ...log }, 'Lesson note filing: could not embed the lesson; comparing by exact content only');
    }
    if (vector) {
      const { duplicateSimilarity, relatedSimilarity } = getConfig().learning;
      const near = await nearestLessons(ctx.userId, ctx.workspaceId, vector);
      const live = near.find(n => !n.archived);
      const archived = near.find(n => n.archived);
      if (live && live.similarity >= duplicateSimilarity) {
        const target = await lessonNoteOf(ctx, live.id);
        if (target) return (await merge(target, { allowDistinct: false }))!;
      }
      if (archived && archived.similarity >= duplicateSimilarity) {
        coreLogger.info({ ...log, decision: 'archived_duplicate', similarity: archived.similarity, against: archived.id }, 'Lesson note filing decision');
        return { status: 'duplicate', id: archived.id, detail: 'A lesson note you archived already says this' };
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
