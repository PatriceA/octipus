/**
 * Audit-coverage gate — an auditor must name what it audited.
 *
 * The evidence gate (`stageEvidenceFailure`) gates the *producer*: a stage that
 * declared it produces artifacts and changed zero files cannot complete. This
 * module gates the *auditor*: a QA/review stage cannot pass a run it never
 * accounted for.
 *
 * Ported from jcode's `validate_gate_pass` (`crates/jcode-plan/src/dag/ops.rs`),
 * whose rule reads: *enumerated accounting is what separates an audit from a
 * rubber stamp — "all good, no gaps" cannot pass over work it never names.*
 * Today a verdict of `{"passed": true, "issues": []}` sails through
 * `parseQAResult`, gets a `passed: true` row in `verification_evidence`, and
 * turns the pipeline green without naming a single thing it checked.
 *
 * No IO here on purpose: every rule is a pure function over an already-parsed
 * verdict, so the whole gate is unit-testable without a model, a DB, or a
 * pipeline run.
 *
 * Direction of the bias, deliberately: matching is LOOSE (normalized substring),
 * because the worse error is failing an audit that actually happened. Missing a
 * rubber stamp costs a green run that already happens today; falsely rejecting
 * an honest verdict burns a retry on work that was fine. Same standing guidance
 * as `deriveCodeDiffScorer`: a wrong guess here is worse than no gate.
 */

import type { QAValidationResult } from './types';

/** One completed stage an auditor is accountable for. */
export interface AuditScopeStage {
  /** Stage name as the pipeline knows it, e.g. `Implementation`. */
  name: string;
}

/**
 * Fold a stage name or a chunk of verdict prose into a comparable form:
 * lowercase, every run of non-alphanumerics collapsed to one space, trimmed.
 * So `Code Review`, `code-review`, and `**Code Review:**` all compare equal.
 *
 * jcode matches slug ids on token boundaries (`mentions_node_id`), which is the
 * wrong shape here — Octipus stage names are prose (`Requirements &
 * Architecture`), not ids, and a boundary matcher would reject an auditor that
 * wrote "the requirements and architecture stage".
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Stages in `scope` that the verdict never addresses. Empty means the audit is
 * accounted for.
 *
 * "Addresses" = the stage name appears anywhere in `feedback` or in any
 * `issues[]` entry. A stage whose name normalizes to empty (punctuation only)
 * is skipped rather than counted as uncovered — an unmatchable name is our
 * problem, not the auditor's.
 */
export function uncoveredStages(verdict: QAValidationResult, scope: AuditScopeStage[]): string[] {
  const haystack = normalizeForMatch([verdict.feedback, ...verdict.issues].join(' \n '));
  return scope
    .filter((stage) => {
      const needle = normalizeForMatch(stage.name);
      return needle.length > 0 && !haystack.includes(needle);
    })
    .map((stage) => stage.name);
}

/**
 * The audit-gate decision for one parsed verdict.
 *
 * Returns a human-readable failure reason when a PASSING verdict is not
 * accountable for its scope, else null (= let the pass stand).
 *
 * Only gates a pass. A `passed: false` verdict is already routing to the retry
 * loop and has nothing to prove; re-judging it would only risk turning a
 * legitimate failure into a differently-worded one.
 *
 * An empty scope passes: a pipeline with no artifact-producing stages before
 * the auditor (research-only) has nothing to enumerate, exactly as
 * `stageEvidenceFailure` leaves `Research & Discovery` green.
 *
 * No enumeration cap. jcode relaxes full enumeration above 20 audited nodes
 * (`GATE_COVERAGE_ENUMERATION_CAP`) because its graphs grow unbounded; pipeline
 * templates are fixed and top out at 7 stages, so a cap would be dead code.
 * ponytail: add one if a template ever exceeds ~15 stages.
 */
export function auditVerdictFailure(
  verdict: QAValidationResult,
  scope: AuditScopeStage[],
): string | null {
  if (!verdict.passed) return null;

  const reasons: string[] = [];

  const uncovered = uncoveredStages(verdict, scope);
  if (uncovered.length > 0) {
    reasons.push(
      `the verdict passed without addressing ${uncovered.length} audited stage(s): ` +
        `${uncovered.join(', ')}. Name each stage you checked and what you checked ` +
        `about it — a pass that does not account for the work it covers is a rubber stamp.`,
    );
  }

  reasons.push(...thinVerdictReasons(verdict));

  // Every fault at once, never one per round. Disclosing them sequentially
  // would let three formatting gaps eat the whole retry budget (default 3)
  // before the auditor ever gets to re-judge the substance — which is how a
  // gate ends up failing work that actually succeeded.
  return reasons.length > 0 ? reasons.join(' Also: ') : null;
}

/**
 * Thin-verdict rules — port of jcode's `validate_artifact` → `ThinArtifact`
 * (`ops.rs:703`). A passing verdict that states nothing it left unchecked, or
 * states no confidence, is structurally indistinguishable from a shallow one.
 *
 * Applies to the structured `json` tier ONLY. `QA_VERDICT_JSON_INSTRUCTION`
 * asks for these fields in that block and nowhere else, so failing a prose or
 * inline verdict for lacking them would fail an auditor for answering the
 * question it was actually asked. The caller logs when a non-json pass skips
 * these rules, so the gap stays visible rather than silently forgiven.
 */
export function thinVerdictReasons(verdict: QAValidationResult): string[] {
  if (!verdict.passed) return [];
  if (verdict.source !== 'json') return [];

  const reasons: string[] = [];

  if (!verdict.whatIDidNotCheck?.length) {
    reasons.push(
      `the verdict passed without stating what it did NOT check. List it in ` +
        `"whatIDidNotCheck" — an explicit "nothing, the change is trivial" is a ` +
        `valid entry, an empty list is not.`,
    );
  }

  if (!verdict.confidence) {
    reasons.push(
      `the verdict passed without a usable confidence. State "high", "medium" ` +
        `or "low" — an honest "low" is welcome, it routes follow-up work rather ` +
        `than counting against you.`,
    );
  }

  return reasons;
}

/** Every thin-verdict fault as one message, or null when the verdict is sound. */
export function thinVerdictFailure(verdict: QAValidationResult): string | null {
  const reasons = thinVerdictReasons(verdict);
  return reasons.length > 0 ? reasons.join(' Also: ') : null;
}
