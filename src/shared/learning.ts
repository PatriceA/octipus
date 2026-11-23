/**
 * What filing a learned skill did: `proposed` a new pending proposal,
 * `candidate` filed but not shown until it is seen again, `merged` into an
 * existing proposal, `duplicate` dropped (covered by a live skill, or
 * suppressed after a rejection), `failed` not written.
 */
export type LearningSkillOutputStatus = 'proposed' | 'candidate' | 'merged' | 'duplicate' | 'failed';

/**
 * What filing a lesson note did: `saved` a new lesson note, `merged` into an
 * existing one (whose id is given), `duplicate` dropped (a lesson note the
 * user archived already says it), `saved_unindexed` written but not indexed
 * (no embedding model; a partial failure), `failed` not written.
 */
export type LearningKnowledgeOutputStatus = 'saved' | 'merged' | 'duplicate' | 'saved_unindexed' | 'failed';

/** What a lesson note records: a decision (and the alternative rejected), a constraint, or a fact. */
export const LESSON_KINDS = ['decision', 'constraint', 'fact'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** Most entries kept in each evidence list of a lesson note's frontmatter; the oldest go first. */
export const MAX_LESSON_REFS = 50;

/**
 * The frontmatter of a lesson note (`note_kind = 'lesson'`): the evidence
 * lives here, not in the body. Lists are newest last, at most MAX_LESSON_REFS.
 */
export interface LessonFrontmatter {
  lessonKind: LessonKind;
  /** Learning reviews that recorded this lesson (merges add the absorbed note's count). */
  sightings: number;
  sessions: string[];
  learningJobIds: string[];
  /** Evidence ids the reviews cited (`event:…`, `check:…`, `message:…`). */
  sources: string[];
  /** Set on a lesson note consolidation absorbed (and archived): the note it was merged into. */
  mergedInto?: string;
  /**
   * Set on a lesson note the system archived for another reason than a merge:
   * `expiry`, unused past `learning.lessonTtlDays`. A lesson seen again revives
   * it. A note the user archived carries neither this nor `mergedInto`.
   */
  archivedBy?: 'expiry';
  /**
   * Lesson notes the merge model judged to be other lessons (at most
   * MAX_LESSON_REFS, newest last): consolidation does not ask again about a
   * pair that lists each other. Cleared when a merge rewrites this note's body.
   */
  distinctFrom?: string[];
}

/** One outcome of a learning check. */
export type LearningOutputView =
  | { kind: 'skill'; status: LearningSkillOutputStatus; id?: string; detail?: string }
  | { kind: 'knowledge'; status: LearningKnowledgeOutputStatus; id?: string; detail?: string }
  | { kind: 'memory' | 'skill_patch'; status: string; id?: string; detail?: string };

/** Public learning-check receipt; raw execution evidence stays on the server. */
export interface LearningCheckView {
  id: string;
  title: string;
  status: string;
  stage: string | null;
  error: string | null;
  createdAt: string;
  result: { reason?: string; outputs?: LearningOutputView[] } | null;
}

/**
 * What one consolidation run did (`POST /api/skills/proposals/consolidate`,
 * the daily learning maintenance).
 */
export interface ConsolidationReport {
  /** Proposals absorbed into another. */
  merged: number;
  /** Candidates deleted because they were not seen again in time. */
  expired: number;
  /** Candidates surfaced (pending) by this run. */
  promoted: number;
  /** Skill and proposal embeddings computed. */
  embedded: number;
  /**
   * Proposal merges that only counted (the text was not rewritten) because
   * the merge model could not be used. Lesson notes are never merged that
   * way: without a verdict they stay apart for a later run.
   */
  degraded: number;
  /** Lesson notes absorbed into another lesson note (and archived). */
  notesMerged: number;
  /** Lesson notes archived as unused past `learning.lessonTtlDays`. */
  notesArchived: number;
}
