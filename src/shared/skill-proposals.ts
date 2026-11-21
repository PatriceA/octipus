/**
 * A skill proposal as `GET /api/skills/proposals` serves it (the
 * `skill_proposals` row without its embedding, dates as ISO strings).
 * Type-only, for the web client, plus the pure `sessionCountOf`.
 *
 * kind 'patch' replaces exactly one passage of an existing learned skill
 * (`targetSkillId`): `patchOldText` → `patchNewText`, made against the content
 * whose sha256 is `baseContentHash`. Its `draftPromptTemplate` is the skill as
 * it would read after approval. See docs/SESSION-LEARNING.md.
 *
 * status 'candidate': filed by automatic learning, not shown yet; 'merged':
 * absorbed into another proposal (`mergedIntoId`).
 */
export interface SkillProposalView {
  id: string;
  userId: string;
  fingerprint: string;
  name: string;
  /** For a patch: the reviewer's reason. */
  description: string;
  draftPromptTemplate: string;
  /** Observations merged into this proposal, the first included. */
  exemplarCount: number;
  lastExemplarAt: string;
  kind: 'skill' | 'expert' | 'patch';
  sourceRef: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'promoted' | 'candidate' | 'merged';
  createdAt: string;
  targetSkillId: string | null;
  patchOldText: string | null;
  patchNewText: string | null;
  baseContentHash: string | null;
  /** The skill an approval created, merged into or patched. */
  promotedSkillId: string | null;
  /** Every source merged in, newest last (at most 50). */
  sourceRefs: string[];
  /** Distinct sessions (and other sources) in `sourceRefs`: `sessionCountOf(sourceRefs)`. */
  sessionCount: number;
  /** What kind of evidence it rests on. */
  signal: 'correction' | 'recovery' | 'procedure' | null;
  /** The draft before the last merge. */
  previousDraft: string | null;
  /** When it became pending (shown). */
  surfacedAt: string | null;
  /** Status 'merged': the proposal it was absorbed into. */
  mergedIntoId: string | null;
  /** The nearest live skill, when it is similar enough to mention. */
  similarSkill: { id: string; name: string; similarity: number } | null;
  /** Patches only: the target skill's content now (null when it is gone). */
  currentContent?: string | null;
  /** Patches only: the content changed since the patch was made; approval will be refused. */
  stale?: boolean;
}

/**
 * How many distinct sessions a proposal was seen in: session ids parsed from
 * `learning:<job>:session:<id>` and `session:<id>`; any other ref (`text`,
 * `trajectory:<id>`) counts as one distinct source of its own.
 */
export function sessionCountOf(sourceRefs: string[]): number {
  const sources = new Set<string>();
  for (const ref of sourceRefs) {
    const session = /(?:^|:)session:(.+)$/.exec(ref);
    sources.add(session ? `session:${session[1]}` : `ref:${ref}`);
  }
  return sources.size;
}
