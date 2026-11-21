/**
 * What filing a learned skill did: `proposed` a new pending proposal,
 * `candidate` filed but not shown until it is seen again, `merged` into an
 * existing proposal, `duplicate` dropped (covered by a live skill, or
 * suppressed after a rejection), `failed` not written.
 */
export type LearningSkillOutputStatus = 'proposed' | 'candidate' | 'merged' | 'duplicate' | 'failed';

/** One outcome of a learning check. */
export type LearningOutputView =
  | { kind: 'skill'; status: LearningSkillOutputStatus; id?: string; detail?: string }
  | { kind: 'knowledge' | 'memory' | 'skill_patch'; status: string; id?: string; detail?: string };

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
