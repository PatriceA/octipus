/**
 * A pending skill proposal as `GET /api/skills/proposals` serves it (the
 * `skill_proposals` row, dates as ISO strings). Type-only, for the web client.
 *
 * kind 'patch' replaces exactly one passage of an existing learned skill
 * (`targetSkillId`): `patchOldText` → `patchNewText`, made against the content
 * whose sha256 is `baseContentHash`. Its `draftPromptTemplate` is the skill as
 * it would read after approval. See docs/SESSION-LEARNING.md.
 */
export interface SkillProposalView {
  id: string;
  userId: string;
  fingerprint: string;
  name: string;
  /** For a patch: the reviewer's reason. */
  description: string;
  draftPromptTemplate: string;
  exemplarCount: number;
  lastExemplarAt: string;
  kind: 'skill' | 'expert' | 'patch';
  sourceRef: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'promoted';
  createdAt: string;
  targetSkillId: string | null;
  patchOldText: string | null;
  patchNewText: string | null;
  baseContentHash: string | null;
  /** The skill an approval created, merged into or patched. */
  promotedSkillId: string | null;
  /** Patches only: the target skill's content now (null when it is gone). */
  currentContent?: string | null;
  /** Patches only: the content changed since the patch was made; approval will be refused. */
  stale?: boolean;
}
