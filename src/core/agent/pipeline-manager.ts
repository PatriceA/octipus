import { getConfig } from '@/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getNotificationService } from '@/core/notification-service';
import { recordRunEvent } from '@/core/run-log';
import type { SideEffectCounters } from '@/core/swarm/receipt';
import type { AgentContext } from '@/core/types';
import { getDb } from '@/db/postgres';
import { messageRepository } from '@/db/repositories/message-repository';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import type {
  NewPipeline,
  NewPipelineNode,
  Pipeline,
  PipelineNodeRow,
  PlanItemRow,
} from '@/db/schema/pipelines';
import { pipelineNodes, pipelines } from '@/db/schema/pipelines';
import { getModelRegistry, type ModelRegistry } from '@/models/model-registry';
import { getTopicConfig } from '@/models/topic-config';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';
import { type AuditScopeStage, auditVerdictFailure, coverageScope, unaddressedDoubt, uncoveredStages } from './audit-coverage';

import { createHandoffContext, formatHandoffChain, HANDOFF_EMIT_INSTRUCTION, type HandoffContext, parseStructuredHandoff, stripHandoffBlock } from './handoff';
import {
  compileTemplateToGraph,
  edgeId,
  isRetryExhausted,
  type NodeOutcome,
  type PipelineGraph,
  routeExhausted,
  selectEdge,
  validateGraph,
} from './pipeline-graph';
import { paramTemplateVars, resolveRecipeParams } from './recipe-params';
import { stageContractErrors } from './role-contract';
import { getOrchestratorService } from './service';
import {
  buildStagesFromTemplate,
  expandPromptTemplate,
  getPipelineTemplate,
  type StageTemplate,
} from './templates';
import { appendSources, ROOT_ROLE, type QAValidationResult } from './types';
import { countChangedFiles, snapshotWorkspace, type WorkspaceSnapshot } from './workspace-snapshot';

/**
 * Coerce an arbitrary value to the enumerated QA confidence (or undefined).
 *
 * Case- and whitespace-insensitive: a model writing `"High"` has stated its
 * confidence, and since the thin-verdict rule now REJECTS a pass with no
 * usable confidence, exact-literal matching would fail an accountable audit
 * over capitalisation.
 */
function normalizeConfidence(v: unknown): QAValidationResult['confidence'] {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : undefined;
}
/**
 * Coerce a JSON field to a list of non-empty strings. A model that answers
 * `"nothing"` instead of `["nothing"]` is answering the question, so a bare
 * string is accepted; anything else yields an empty list, which the
 * thin-verdict rule treats as "did not state it".
 */
function normalizeStringList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}
/** Pull a stated `confidence: high|medium|low` (JSON or prose) from raw text. */
function parseConfidence(text: string): QAValidationResult['confidence'] {
  const m = text.match(/confidence["\s]*[:=]\s*["']?(high|medium|low)/i);
  return m ? (m[1].toLowerCase() as 'high' | 'medium' | 'low') : undefined;
}

/** Field names a verdict block uses for each part of the contract, in priority order. */
const VERDICT_KEYS = ['passed', 'verdict', 'status', 'result', 'outcome'];
const ISSUE_KEYS = ['issues', 'blockers', 'problems', 'critical_issues', 'criticalIssues'];
const FEEDBACK_KEYS = ['feedback', 'summary', 'notes', 'rationale', 'reasoning'];
const NOT_CHECKED_KEYS = ['whatIDidNotCheck', 'what_i_did_not_check', 'notChecked', 'not_checked'];
/**
 * Keys a REVIEW writes and a tool payload does not.
 *
 * The split inside `VERDICT_KEYS` and `ISSUE_KEYS` is the useful one. A test
 * runner or a health check answers under `result` or `status`, and lists
 * `issues`; nothing but something rendering a judgement calls its answer a
 * `verdict`, or its list `blockers` / `critical_issues`, or offers
 * `recommendations`. That vocabulary, not the NUMBER of fields present, is what
 * separates a real audit from a pasted payload — `{"result":"success",
 * "issues":[],"summary":"171/171 passed"}` carries three keys and none of them
 * is a judgement.
 */
const AUDIT_VOCAB_KEYS = [
  'verdict',
  'blockers',
  'critical_issues',
  'criticalIssues',
  'recommendations',
  'confidence',
  'certainty',
  ...NOT_CHECKED_KEYS,
];

/** Words a verdict field uses for the two answers. Anything else is not a verdict. */
const PASS_WORDS = /^(pass(ed)?|approve[ds]?|ok|accept(ed)?|green|success(ful)?)$/i;
const FAIL_WORDS = /^(fail(ed)?|reject(ed)?|block(ed)?|deny|denied|needs[-_\s]?work|red)$/i;

/**
 * First key present on the object with a value, in the alias order given.
 *
 * A key present but null or undefined is SKIPPED rather than winning: models
 * routinely emit the whole contract with the fields they did not fill set to
 * null, so `{"passed": null, "verdict": "fail"}` would otherwise read as "no
 * recognisable verdict" and fall through to the prose tier, and
 * `{"issues": null, "blockers": ["…"]}` would silently drop the blockers.
 * A present-and-empty value (`""`, `[]`) is a real answer and still wins.
 */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== null && obj[k] !== undefined) return obj[k];
  return undefined;
}

/**
 * Read a verdict object that carries the contract under different field names.
 *
 * Returns null unless the object states pass or fail unambiguously — a block
 * with no recognizable verdict field, or one whose value is neither a pass nor
 * a fail word, is NOT a verdict and must not be guessed at. Reported as the
 * `json` tier because that is what it is: a structured answer, held to the
 * structured tier's rules.
 */
export function aliasVerdict(raw: unknown): QAValidationResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const stated = pick(obj, VERDICT_KEYS);
  let passed: boolean;
  if (typeof stated === 'boolean') passed = stated;
  else if (typeof stated === 'string' && PASS_WORDS.test(stated.trim())) passed = true;
  else if (typeof stated === 'string' && FAIL_WORDS.test(stated.trim())) passed = false;
  else return null;

  // A verdict word alone is not a verdict, and neither is a verdict word beside
  // ordinary prose. The object must answer something only an AUDIT answers.
  //
  // `feedback` used to count, but `FEEDBACK_KEYS` includes `summary` and
  // `notes`, which any pasted payload has: `{"result": "success", "summary":
  // "12 tests passed"}` from a test runner and `{"status": "ok", "notes":
  // "service up"}` from a health check both satisfied it and were read as
  // PASSING verdicts. Tier 1b runs before the prose tiers, so an auditor that
  // wrote a genuine FAIL in prose and ended its report with a tool-output fence
  // had that FAIL replaced by a pass — which the coverage gate then rejected
  // into the auditor-only retry loop, so the real failure never reached the
  // implementer at all.
  //
  // What-was-not-checked and confidence are AUDIT vocabulary: a tool does not
  // emit them, only something answering this contract does. `issues` is not — a
  // test summary or a linter emits `{"result": "success", "issues": []}` and
  // `{"status": "ok", "issues": []}` just as readily, the same trap one key over
  // from the `summary`/`notes` one.
  //
  // So the bar depends on which way the verdict points, because the two
  // mistakes do not cost the same. Reading a stray payload as a FAIL costs one
  // retry and can only make the gate stricter. Reading one as a PASS overwrites
  // a genuine failure the auditor wrote in prose — this tier runs first — and
  // ships the work. A failing alias may therefore stand on a generic issue list;
  // a passing one must speak audit vocabulary.
  //
  // `issues` PLUS `feedback` used to clear the passing bar, on the reasoning
  // that two incidental keys are less likely than one. They are not: a test
  // runner emits `{"result":"success","issues":[],"summary":"171/171 passed"}`
  // in a single payload and satisfies both halves at once. Counting keys was
  // the wrong axis — two keys a tool carries anyway do not add up to one key
  // only an audit carries. `AUDIT_VOCAB_KEYS` is that axis, and it keeps the
  // shape a real QA stage was measured emitting (`verdict` + `blockers` +
  // `recommendations`) passing while the pasted payload above does not.
  const feedback = pick(obj, FEEDBACK_KEYS);
  const speaksAudit = AUDIT_VOCAB_KEYS.some((k) => obj[k] !== undefined && obj[k] !== null);
  const hasIssues = pick(obj, ISSUE_KEYS) !== undefined;
  const answersAudit = passed ? speaksAudit : speaksAudit || hasIssues;
  if (!answersAudit) return null;

  return {
    passed,
    issues: normalizeStringList(pick(obj, ISSUE_KEYS)),
    feedback: typeof feedback === 'string' ? feedback : '',
    retryCount: typeof obj.retryCount === 'number' ? obj.retryCount : 0,
    confidence: normalizeConfidence(pick(obj, ['confidence', 'certainty'])),
    whatIDidNotCheck: normalizeStringList(pick(obj, NOT_CHECKED_KEYS)),
    source: 'json',
  };
}

/**
 * The retry prompt for a verdict the audit gate REJECTED.
 *
 * The work was judged; it is the report that is unusable. Re-running the audit
 * makes the auditor redo everything it just did — measured 2026-08-21 at ~430k
 * tokens a visit, three visits, the run pool gone and not one plan item
 * finished. Handing the auditor its own report back and asking only for the
 * verdict block costs a fraction of that, and converges, because the model has
 * nothing left to do except answer in the shape it was asked for.
 *
 * The report is re-attached to the corrected block afterwards, so whatever runs
 * next still reads the full audit rather than a bare verdict.
 */
export function qaVerdictCorrectionInput(report: string, reason: string, handsOff = false): string {
  return (
    `Your audit REPORT below was rejected — not the work you audited, and not your conclusion. ` +
    `The reason:\n\n${reason}\n\n` +
    `Do NOT re-run the audit, re-read the code, or run any commands: nothing has changed since you ` +
    `wrote this, and your findings stand. Fix ONLY the reported problem and reply with ` +
    // "nothing else" USED to be unconditional, and the handoff instruction was
    // appended underneath it asking for a second block. The code then relied on
    // the model resolving that contradiction in favour of the handoff: a
    // literal reading obeys "nothing else", `previousRaw` comes back empty, and
    // the downstream stage falls back to scraping the re-joined report.
    (handsOff ? `the corrected verdict block and the handoff block, and nothing else` : `the corrected verdict block, nothing else`) +
    `.\n\n` +
    `--- YOUR PREVIOUS REPORT ---\n${report}\n--- END OF REPORT ---\n` +
    // A node with an outgoing edge still owes the next one a handoff. Without
    // this the reply carries none and the downstream stage inherits the
    // PRE-correction handoff out of the re-attached report.
    (handsOff ? HANDOFF_EMIT_INSTRUCTION : '') +
    QA_VERDICT_JSON_INSTRUCTION
  );
}

/**
 * Run a stage's `verifyCommand` and render the result as fact for the auditor.
 *
 * Reuses `command_exit_zero` rather than spawning anything itself: that scorer
 * already owns every constraint a command from a template needs to satisfy —
 * argv only through `tokenizeSafe`, the shell tool's own content policy, the
 * operator's permission decision through `routeApproval`, a workspace-resolved
 * cwd and a hard timeout. A second executor beside it would be a second set of
 * those rules to keep in step, and the one that drifts is the one nobody reads.
 *
 * Never throws. A verify command that cannot run is worth saying out loud in
 * the auditor's input — it is a fact about the run — and is not worth failing
 * the stage over before anyone has looked at the work.
 */
async function runStageVerifyCommand(
  command: string,
  ctx: { userId?: string; sessionId: string; role: string; toolIds?: string[] },
): Promise<string> {
  const canRunCommands = (ctx.toolIds ?? []).includes('shell');
  if (!canRunCommands) {
    return `VERIFY COMMAND (from the pipeline, not the model): \`${command}\`\nNot run — this stage does not hold the shell tool. Judge the work on what you can read.`;
  }
  try {
    const { runScorers } = await import('@/core/swarm/scorers');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await sessionRepository.findById(ctx.sessionId);
    const sessionCtx = session?.context as { devMode?: boolean; projectPath?: string } | undefined;
    const outcome = await runScorers(
      [{ kind: 'command_exit_zero', command }],
      { output: '', notes: '' },
      {
        userId: ctx.userId,
        role: ctx.role,
        canRunCommands: true,
        projectPath: sessionCtx?.devMode === true ? sessionCtx.projectPath : undefined,
      },
    );
    const failure = outcome.failures[0];
    return failure
      ? `VERIFY COMMAND (run by the pipeline, not by you): \`${command}\`\nRESULT: FAILED.\n${failure.reason}\n\nThat is the ground truth for this stage. Do not re-run it to check; explain it.`
      : `VERIFY COMMAND (run by the pipeline, not by you): \`${command}\`\nRESULT: exit 0.\n\nThat is the ground truth for this stage. You do not need to run it again — judge whether it is SUFFICIENT evidence for the work claimed.`;
  } catch (err) {
    return `VERIFY COMMAND (from the pipeline): \`${command}\`\nCould not be run: ${(err as Error).message}. Judge the work on what you can read.`;
  }
}

/**
 * Appended to `qa_validation` stages so they emit a machine-readable verdict
 * `parseQAResult`'s strict-JSON tier (1) consumes — instead of relying on the
 * prose-verdict fallback (`parseProseVerdict`, tier 3) to recover PASS/FAIL from
 * free text (Phase B2). Kept as a runtime injection so it reaches ad-hoc
 * pipelines and existing installs, not only reseeded templates.
 *
 * Shows the shape with PLACEHOLDER values and no ```json fence: if this text is
 * echoed, `parseQAResult` scans every fenced block for one that parses with a
 * boolean `passed`, and would otherwise read the example as the verdict (the B3
 * anti-echo lesson). `<true|false>` parses as neither JSON nor the inline regex.
 * `parseProseVerdict` stays as the loud fallback until eval proves the JSON path
 * fires on 100% of QA stages — its deletion is deferred (follow-ups plan B2).
 */
export const QA_VERDICT_JSON_INSTRUCTION = `

---
QA VERDICT (required) — append your verdict now, as a fenced code block tagged \`json\` (three backticks then the word json) containing ONLY an object of this shape, with YOUR values in place of the placeholders:

    {
      "passed": <true|false>,
      "confidence": <"high"|"medium"|"low">,
      "issues": [<one short string per blocking issue; [] when none>],
      "feedback": <one paragraph that NAMES each stage you audited and what you checked about it>,
      "whatIDidNotCheck": [<one short string per thing you did not verify; never empty on a pass — "nothing, the change is trivial" is a valid entry>]
    }

\`passed\` is false if ANY critical or major issue remains. An honest \`"low"\` confidence is welcome — it routes follow-up work rather than counting against you. A pass whose \`feedback\` does not account for the stages it covers is rejected and re-run.

Emit the block exactly once, as the LAST thing in your reply.`;

/**
 * The same contract, stated up front. Position is the fix: on the 2026-08-07
 * run the auditor omitted the verdict block three times in a row with the
 * instruction appended *after* a ~3000-word prompt, so all three retries went
 * on formatting and the substance was never re-judged. Stating the requirement
 * before the work — and again after it — is the cheapest lever available, and
 * it changes what is asked for rather than what the gate will accept.
 *
 * Deliberately carries no ```json fence and no literal `"passed": true` for the
 * same anti-echo reason as the instruction itself: `parseQAResult` scans every
 * fenced block for one that parses with a boolean `passed`, so an echoed
 * example would be read as the verdict. The placeholder shape (`<true|false>`)
 * parses as neither JSON nor the inline regex, so echoing it is inert.
 */
export const QA_VERDICT_JSON_LEAD = `OUTPUT CONTRACT — read this first.

Your reply MUST END with a fenced \`json\` verdict block. A report without one is rejected unread and re-run: the substance is never judged, so writing a thorough report and forgetting the block wastes the whole stage. The field list is repeated at the end of this message.

---

`;

/**
 * Wrap a QA stage's input in the verdict contract — stated before the work and
 * specified after it. One chokepoint for every injection site (initial pass,
 * implementation retry, auditor-only re-run) so a retried auditor can never be
 * asked for something different from a first-pass one.
 */
export function withQaVerdictContract(input: string, rejection?: string): string {
  return (
    QA_VERDICT_JSON_LEAD +
    (rejection ? `YOUR PREVIOUS VERDICT WAS REJECTED — ${rejection}\n\n---\n\n` : '') +
    input +
    QA_VERDICT_JSON_INSTRUCTION
  );
}

/**
 * The stages an auditor at `qaIndex` is accountable for.
 *
 * Two ways in, and they are deliberately different:
 * - it DECLARED it produces artifacts (the coverage rule). Declared, never
 *   inferred from the stage name — a `Research & Discovery` stage legitimately
 *   produces nothing and must not be gated for coverage.
 * - it handed off saying its own confidence was `low` (the doubt rule), which
 *   applies whether or not it wrote anything. A shaky architecture stage is
 *   exactly the doubt that would otherwise be inherited in silence.
 *
 * Confidence comes from each stage's handoff block, keyed by STAGE INDEX. A
 * pipeline recipe may legitimately reuse a stage name (nothing enforces
 * uniqueness on imported recipes), and keying by name would let a later
 * occurrence's confidence overwrite an earlier one's — losing real doubt in one
 * direction and inventing it in the other. A stage that emitted no handoff
 * simply carries no confidence: a missing signal, not a low one.
 */
export function auditScopeBefore(
  qaIndex: number,
  names: string[],
  producesArtifacts: Array<boolean | undefined>,
  confidenceByIndex: Map<number, 'high' | 'medium' | 'low'> = new Map(),
): AuditScopeStage[] {
  const scope: AuditScopeStage[] = [];
  for (let k = 0; k < qaIndex && k < names.length; k++) {
    const confidence = confidenceByIndex.get(k);
    if (producesArtifacts[k] || confidence === 'low') {
      scope.push({ name: names[k], producesArtifacts: !!producesArtifacts[k], confidence });
    }
  }
  return scope;
}

/** Each stage's self-reported handoff confidence, keyed by stage index. */
export function handoffConfidenceByStage(chain: HandoffContext[]): Map<number, 'high' | 'medium' | 'low'> {
  const byIndex = new Map<number, 'high' | 'medium' | 'low'>();
  for (const handoff of chain) {
    const index = handoff.from.stageIndex;
    if (typeof index === 'number' && handoff.confidence) byIndex.set(index, handoff.confidence);
  }
  return byIndex;
}

/**
 * Resolve a per-stage model override (a bound model name or id) to a concrete
 * modelId. Returns undefined when no override is set; throws (fail loud) when an
 * override names a model that isn't registered/enabled.
 */
async function resolveStageModelId(
  stageModel: string | undefined,
  registry: ModelRegistry,
): Promise<string | undefined> {
  if (!stageModel) return undefined;
  const model = (await registry.getModel(stageModel)) || (await registry.getModelByModelId(stageModel));
  if (!model) {
    throw new Error(
      `Pipeline stage has model override '${stageModel}' but no such model is registered. ` +
        `Fix the recipe's stage model or clear it.`,
    );
  }
  return model.modelId;
}

/**
 * The model a pipeline stage actually runs on, in order of precedence:
 *
 *   1. the recipe's per-stage `model` override — an explicit choice wins
 *   2. the lane's `executorModel`, but ONLY for a stage that DECLARED itself
 *      `mechanical` (the pipeline's planner→executor split — see
 *      `PipelineStepConfig.mechanical`). A plan-less stage skips this branch
 *      entirely, exactly as a plan-less swarm child does
 *   3. the topic's primary binding
 *
 * Every spawn a stage can make — first pass, implementation retry, auditor
 * re-run — resolves through here, so a retry can never silently land on a
 * different model than the attempt it is repeating.
 *
 * Fails loud on a misconfigured `executorModel` rather than quietly falling
 * back to the primary: a typo that silently costs full price is the failure
 * this whole declaration exists to end.
 */
async function resolveStageModel(
  declared: { model?: string; mechanical?: boolean } | undefined,
  topic: string,
  registry: ModelRegistry,
): Promise<string | undefined> {
  const explicit = await resolveStageModelId(declared?.model, registry);
  if (explicit) return explicit;

  const executorName = declared?.mechanical ? getTopicConfig(topic).executorModel : null;
  if (executorName) {
    const executor =
      (await registry.getModel(executorName)) || (await registry.getModelByModelId(executorName));
    if (!executor) {
      throw new Error(
        `Topic '${topic}' has executorModel '${executorName}' but no such model is registered. ` +
          `Fix it on the Topics page or clear the executor binding.`,
      );
    }
    coreLogger.info(
      { topic, executorModel: executor.modelId },
      'Mechanical pipeline stage routed to the lane executorModel (cheap executor path)',
    );
    return executor.modelId;
  }

  return (await registry.getModelForTopic(topic))?.modelId || undefined;
}

/**
 * The pipeline-pool decision, pure so it is directly testable.
 *
 * Returns the failure summary when the run has spent its pool, else null. A
 * pool of 0 disables the bound, and the comparison is `>=` because the pool is
 * a ceiling on what a run may spend, not on what it may have spent before its
 * last node.
 */
export function poolExhaustedSummary(pool: number, spent: number, nextNodeName: string): string | null {
  if (pool <= 0 || spent < pool) return null;
  return (
    `Pipeline exhausted its ${pool.toLocaleString()}-token pool (${spent.toLocaleString()} spent) ` +
    `before "${nextNodeName}".`
  );
}

/** What a stage said it was for. Both flags are opt-in declarations from the
 *  template — never inferred from a stage's name or its prompt wording. */
export interface StageDeclaration {
  producesArtifacts?: boolean;
  runsCommands?: boolean;
  readOnly?: boolean;
}

/**
 * The evidence-gate decision, with no IO so it is directly testable.
 *
 * Returns the failure reason when a stage did demonstrably none of what it
 * DECLARED it was for, else null (= let the stage complete). Two declarations,
 * checked independently — a stage may make either, both, or neither.
 *
 * **`producesArtifacts`** — TWO signals, and either one showing work is enough:
 *
 * - `counters.filesChanged` — file-mutating TOOL calls. Blind to anything
 *   written through `shell__run` (heredoc, `sed -i`, a generator).
 * - `filesTouched` — files that actually differ on disk across the stage
 *   (`workspace-snapshot.ts`). Blind to which tool did it, which is the point,
 *   but sees the whole workspace including a concurrent pipeline's writes.
 *
 * Requiring only one is deliberate. Each is blind where the other sees, so an
 * AND would fail every stage that used only the tool the other signal misses —
 * which is precisely the false positive this gate had: a real `Implement Fix`
 * stage rewrote two files through the shell and was failed for "changed 0 files".
 *
 * **`runsCommands`** — a stage whose purpose is to EXECUTE (run the suite, the
 * linter, the build) and which ran zero commands did not do its job, however
 * confident its prose. This is the "declared purpose vs receipt" check: a
 * Testing agent that announced it could not run shell, simulated the run, and
 * reported "18 passed, 0 failed" was previously accepted because nothing
 * compared its honest `commandsRun: 0` against what the stage was for.
 *
 * `counters` here are the STAGE's, not one worker's — `stageCounters()` folds in
 * every swarm child, so a stage that delegated its shell work still counts it.
 *
 * "We could not measure" always passes, for every signal:
 * - `counters === null` — the worker exposed no tally (a CLI worker, say).
 * - `filesTouched === null` — no usable snapshot (root unreadable, tree too big).
 * Failing a run we merely failed to observe is the worse error: it fails work
 * that actually succeeded. The gate only bites when a signal is present AND says
 * nothing happened.
 */
export function stageEvidenceFailure(
  declared: StageDeclaration,
  counters: SideEffectCounters | null,
  filesTouched: number | null = null,
): string | null {
  const reasons: string[] = [];

  // Read-only is judged on the SNAPSHOT alone, so it is checked BEFORE the
  // no-counters bail-out below. `filesChanged` counts only file-mutating tools,
  // and the whole failure this catches came through the shell, invisible to it.
  // `null` (no snapshot) is unknown, so it passes.
  //
  // This used to sit after `if (counters === null) return null`, which made it
  // unreachable for exactly the workers that need it most: a CLI worker keeps
  // no tally, so every CLI stage skipped the rule while the snapshot already
  // held the answer. Measured 2026-08-08 on a seven-stage CLI run — QA
  // Validation is declared read-only, the snapshot recorded `filesTouched: 2`,
  // it left a `test_bug.py` probe beside the product and handed back the
  // deliverable modified and uncommitted, and the gate passed it.
  if (declared.readOnly && filesTouched !== null && filesTouched > 0) {
    reasons.push(
      `changed ${filesTouched} file(s) in a read-only stage — it was asked to inspect and report, ` +
        `and a validator that edits what it is validating has invalidated its own verdict`,
    );
  }

  // Everything below needs the worker's own tally. No tally is "we could not
  // measure", never "it did nothing" — failing work that actually succeeded is
  // the worse error.
  if (counters === null) return reasons.length === 0 ? null : reasons.join('; and ');

  if (declared.producesArtifacts && !(filesTouched !== null && filesTouched > 0) && counters.filesChanged === 0) {
    // Name which evidence was actually consulted, so a failure is auditable
    // without re-running it: "0 files" from counters alone is a much weaker claim
    // than "0 files, and the workspace is byte-identical".
    const onDisk = filesTouched === null ? 'no workspace snapshot' : 'workspace unchanged on disk';
    reasons.push(
      `changed 0 files (${counters.toolCalls} tool calls, ${counters.commandsRun} commands, ` +
        `${counters.toolErrors} tool errors; ${onDisk})`,
    );
  }

  if (declared.runsCommands && counters.commandsRun === 0) {
    reasons.push(
      `ran 0 commands (${counters.toolCalls} tool calls, ${counters.toolErrors} tool errors) — ` +
        `a stage that verifies by executing cannot have executed nothing`,
    );
  }

  return reasons.length === 0 ? null : reasons.join('; and ');
}

/**
 * The declaration a verdict-CORRECTION visit is judged against.
 *
 * `qaVerdictCorrectionInput` tells the auditor to run nothing, re-read nothing
 * and change nothing: the work already stands, only the report's shape is
 * wrong. The stage's own declaration still says `runsCommands` — `QA
 * Validation` and `Verify Fix` both declare it — so the evidence gate then
 * fails the visit for doing exactly what it was told, and a failed gate aborts
 * the whole pipeline. The cheap correction path killed the run it exists to
 * rescue.
 *
 * Only the do-something declarations are cleared, and only for this one visit;
 * the stage's own declaration is untouched and a later re-audit is gated in
 * full. `readOnly` is deliberately KEPT, and is the one that should still bite:
 * a correction that edits the code it already judged has invalidated the very
 * verdict it is correcting.
 */
export function correctionDeclaration<T extends StageDeclaration & { producesPlan?: boolean }>(declared: T): T {
  return { ...declared, producesArtifacts: false, runsCommands: false, producesPlan: false };
}

/**
 * Is this the last plan item the loop will visit?
 *
 * Asked of a project-wide verify command on a `loopOverPlan` auditor: `npm
 * test` run against item 1 of 10 fails for the nine nobody has written yet, and
 * that exit code would reach the auditor labelled ground truth. Ordinal rather
 * than count, because `plan__add_items` can extend the plan mid-run.
 */
export function isFinalPlanItem(items: Array<{ ordinal: number }>, current: { ordinal: number }): boolean {
  return !items.some((i) => i.ordinal > current.ordinal);
}

/**
 * Everything the graph walker carries that no table already holds.
 *
 * Node outputs, plan items and edge traversal totals are durable on their own
 * rows; this is the rest — where the cursor is, what the next node will read,
 * which QA feedback is in flight, and the per-item counters the loop resets.
 * Serialized into one `pipeline_checkpoints.state` at every node boundary,
 * which is what makes pause/resume and rewind-to-node the same mechanism.
 */
export interface WalkState {
  cursor: string;
  previousOutput: string;
  handoffChain: HandoffContext[];
  pipelineSources: string[];
  /** Per-edge traversal counts, keyed by `edgeId`. Reset per plan item. */
  traversals: Record<string, number>;
  /** Handoff-chain length when each loop was entered. */
  loopMarks: Record<string, number>;
  pendingFeedback: Record<string, QAValidationResult>;
  judgedContext: Record<string, string>;
  pendingRejection?: string;
  /** The rejected report itself, so the retry corrects it instead of redoing it. */
  rejectedReport?: string;
  currentItemId: string | null;
  steps: number;
}

/** JSON form of a walk state. Plain data — `Map`s are already objects here. */
export function serializeWalk(state: WalkState): Record<string, unknown> {
  return { ...state } as unknown as Record<string, unknown>;
}

/**
 * Read a stored state back, or `null` when it is not one.
 *
 * Defensive on purpose: a checkpoint is user-editable (that is the point of
 * "inspect state, edit it, resume"), and a walk resumed from a malformed
 * snapshot would fail somewhere far from the cause.
 */
export function hydrateWalk(raw: unknown): WalkState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cursor !== 'string' || !r.cursor) return null;
  const record = <T>(v: unknown): Record<string, T> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    cursor: r.cursor,
    previousOutput: typeof r.previousOutput === 'string' ? r.previousOutput : '',
    handoffChain: list<HandoffContext>(r.handoffChain),
    pipelineSources: list<string>(r.pipelineSources),
    traversals: record<number>(r.traversals),
    loopMarks: record<number>(r.loopMarks),
    pendingFeedback: record<QAValidationResult>(r.pendingFeedback),
    judgedContext: record<string>(r.judgedContext),
    pendingRejection: typeof r.pendingRejection === 'string' ? r.pendingRejection : undefined,
    rejectedReport: typeof r.rejectedReport === 'string' ? r.rejectedReport : undefined,
    currentItemId: typeof r.currentItemId === 'string' ? r.currentItemId : null,
    steps: typeof r.steps === 'number' && r.steps >= 0 ? r.steps : 0,
  };
}

export class PipelineManager {
  private get db() { return getDb(); }

  /**
   * Pipelines this process is walking right now.
   *
   * The status column is the cross-process guard; this is the same-process one,
   * because a status write and a second `resume` can interleave between them.
   * Two walkers on one pipeline pay for every remaining node twice.
   */
  private readonly walking = new Set<string>();

  /**
   * Create a pipeline from a template type and start it.
   */
  async createAndRun(
    orchestratorAgentId: string,
    sessionId: string,
    userId: string,
    title: string,
    type: string,
    description: string,
    context: AgentContext,
    options?: {
      maxRetries?: number;
      params?: Record<string, unknown>;
      /**
       * Called once the pipeline row exists, before any stage runs.
       *
       * A REST caller needs the id NOW — the run itself takes minutes, and a
       * POST that blocks that long is a timeout waiting to happen. With this
       * the route can answer `{ pipelineId }` and let the run continue in the
       * background, where `GET /pipelines/:id` follows it.
       */
      onCreated?: (pipelineId: string) => void;
    },
  ): Promise<{ pipelineId: string; result: string }> {
    // Scoped to the caller: a bare template NAME must resolve to the same row
    // the caller was authorized against (see `getPipelineTemplate`).
    const template = await getPipelineTemplate(type, userId);
    // Override maxRetries if provided
    if (options?.maxRetries != null) {
      for (const stage of template.stages) {
        if (stage.stageType === 'qa_validation') {
          stage.maxRetries = options.maxRetries;
        }
      }
    }
    // Resolve + validate recipe parameters against the template's typed defs
    // (fail loud on missing-required / unknown / type-mismatch). Substituted
    // into stage prompts as {{param.<key>}}.
    const paramVars = paramTemplateVars(resolveRecipeParams(template.parameters, options?.params ?? {}));
    const built = buildStagesFromTemplate(template, description);

    // Compile the template into an execution graph and REFUSE to run a bad one.
    // Every defect `validateGraph` catches (unreachable node, unbounded cycle)
    // is an infinite loop or silently skipped work at runtime, and both are
    // vastly more expensive to discover halfway through a paid run.
    const graph = compileTemplateToGraph(template.stages);
    const graphErrors = [...validateGraph(graph), ...stageContractErrors(template.stages)];
    if (graphErrors.length > 0) {
      throw new Error(
        `Pipeline template "${type}" does not compile to a runnable graph: ${graphErrors.join('; ')}`,
      );
    }

    const pipeline = await pipelineRepository.create({
      orchestratorAgentId,
      sessionId,
      userId,
      title,
      type,
      description,
      status: 'running',
      currentNodeKey: graph.entryKey,
      // Kept so a resume in another process can rebuild the same prompts. The
      // template is re-read by `type`; the params were only ever in memory.
      metadata: {
        params: options?.params ?? {},
        ...(options?.maxRetries != null ? { maxRetries: options.maxRetries } : {}),
      },
    });

    options?.onCreated?.(pipeline.id);

    // A `foreach` head adopts the approval flag of its first body node, and the
    // body node drops it: the user approves the PLAN once, before the loop
    // starts, rather than being asked again for every item.
    const firstBodyKey = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.parentKey && !firstBodyKey.has(n.parentKey)) firstBodyKey.set(n.parentKey, n.key);
    }
    const byKey = new Map(graph.nodes.map((n) => [n.key, n]));

    await pipelineRepository.createNodes(
      graph.nodes.map((n) => {
        if (n.kind === 'foreach') {
          const bodyHead = byKey.get(firstBodyKey.get(n.key) ?? '');
          return {
            pipelineId: pipeline.id,
            nodeKey: n.key,
            kind: 'foreach' as const,
            name: n.name,
            // A loop head runs no worker; the role is carried for display only.
            role: bodyHead ? built[bodyHead.templateIndex].role : 'general',
            toolIds: [],
            systemPrompt: '',
            input: '',
            requiresApproval: bodyHead ? built[bodyHead.templateIndex].requiresApproval : false,
            ordinal: n.ordinal,
          };
        }
        const b = built[n.templateIndex];
        return {
          pipelineId: pipeline.id,
          nodeKey: n.key,
          kind: n.kind === 'human' ? ('human' as const) : ('step' as const),
          name: b.name,
          role: b.role,
          toolIds: b.toolIds,
          systemPrompt: b.systemPrompt,
          input: '',
          // Asked on the loop head instead — see above.
          requiresApproval: n.parentKey ? false : b.requiresApproval,
          ordinal: n.ordinal,
          parentNodeKey: n.parentKey ?? null,
          maxTokens: b.maxTokens ?? null,
        };
      }),
    );

    await pipelineRepository.createEdges(
      graph.edges.map((e) => ({
        pipelineId: pipeline.id,
        fromNodeKey: e.from,
        toNodeKey: e.to,
        condition: e.condition,
        maxTraversals: e.maxTraversals ?? null,
        ordinal: e.ordinal,
      })),
    );

    const orchestrator = getOrchestratorService();
    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: {
        event: 'pipeline_created',
        pipelineId: pipeline.id,
        title,
        type,
        stageCount: graph.nodes.length,
      },
      timestamp: new Date(),
    });

    coreLogger.info(
      { pipelineId: pipeline.id, type, nodes: graph.nodes.length, edges: graph.edges.length },
      'Pipeline created',
    );

    return this.runGraph({
      pipeline,
      graph,
      built,
      template,
      paramVars,
      description,
      title,
      context,
      orchestratorAgentId,
      sessionId,
    });
  }

  /**
   * Tools the RUNTIME grants a node on top of its role's set.
   *
   * `plan` for any node that writes or revises the plan: the planner needs it
   * to emit the items, and every loop-body node needs it so a review or QA node
   * can append the work it just discovered. Granted rather than declared,
   * because a template author declares INTENT (`producesPlan`, `loopOverPlan`)
   * and having to also remember a tool id would make the declaration a trap
   * rather than a contract.
   */
  private grantedToolIds(b: { producesPlan?: boolean; loopOverPlan?: boolean }): string[] | undefined {
    return b.producesPlan || b.loopOverPlan ? ['plan'] : undefined;
  }

  /**
   * Walk the graph.
   *
   * One loop, one cursor. Every routing decision goes through `selectEdge`, so
   * the shape of a run is decided by the graph rather than by control flow
   * scattered through this method — which is what the old nested
   * stage-loop-plus-retry-while-loop was.
   */
  private async runGraph(args: {
    pipeline: Pipeline;
    graph: PipelineGraph;
    built: ReturnType<typeof buildStagesFromTemplate>;
    template: { stages: StageTemplate[] };
    paramVars: Record<string, string>;
    description: string;
    title: string;
    context: AgentContext;
    orchestratorAgentId: string;
    sessionId: string;
    /** Set when continuing an interrupted, paused, or rewound run. */
    resumeState?: WalkState;
  }): Promise<{ pipelineId: string; result: string }> {
    const { pipeline } = args;
    if (this.walking.has(pipeline.id)) {
      throw new Error(`Pipeline ${pipeline.id} is already being walked in this process.`);
    }
    this.walking.add(pipeline.id);
    try {
      return await this.walk(args);
    } finally {
      this.walking.delete(pipeline.id);
    }
  }

  /** The walk itself. `runGraph` owns the one-walker-per-pipeline lease. */
  private async walk(args: Parameters<PipelineManager['runGraph']>[0]): Promise<{ pipelineId: string; result: string }> {
    const { pipeline, graph, built, template, paramVars, description, title, context, sessionId } = args;
    const orchestrator = getOrchestratorService();
    const registry = getModelRegistry();
    const nodes = new Map((await pipelineRepository.getNodes(pipeline.id)).map((r) => [r.nodeKey, r]));
    const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
    const workspaceRoot = await this.resolveWorkspaceRoot(sessionId);

    let previousOutput = '';
    // The last stage's reply with its ```handoff fence still in it. Kept beside
    // `previousOutput` (which is stripped, because the fence must never reach a
    // model or a user) purely so the handoff can be parsed from it — see the
    // `raw` note on `runStepNode`. Not checkpointed: a resumed run re-derives
    // its handoff from prose, which is the old behaviour and no worse.
    let previousRaw = '';
    /** Set when the walk left a node that had edges but could take none. */
    let stoppedShort: { node: string; outcome: NodeOutcome } | null = null;
    /**
     * A QA failure that burned its retries and could not be escalated.
     *
     * The walk forces `outcome = 'qa_pass'` there so it can keep going, and
     * that rewrite is what the exit below would otherwise see: it asks
     * `routeExhausted` about `qa_pass` edges, finds none exhausted, and reports
     * the run as having completed successfully — the exact scenario
     * `stoppedShort` was introduced to catch, reached through the one path that
     * launders the outcome on its way there. Remembered here so the exit can
     * answer with what actually happened.
     */
    let unescalatedQaFailure: { node: string; outcome: NodeOutcome } | null = null;
    const handoffChain: HandoffContext[] = [];
    // Source attribution: every successfully completed node (incl. retries)
    // appends one entry, rendered into the summary as `_Sources: ..._`.
    const pipelineSources: string[] = [];
    const traversals = new Map<string, number>();
    /** QA feedback waiting to be injected into the node it was sent back to. */
    const pendingFeedback = new Map<string, QAValidationResult>();
    /** The work a QA node judged, so an auditor-only re-run re-judges the same thing. */
    const judgedContext = new Map<string, string>();
    /** Rejection notice for a QA node re-running because its report was unaccountable. */
    let pendingRejection: string | undefined;
    /** That node's rejected report, handed back to it so the retry is a correction. */
    let rejectedReport: string | undefined;
    /** The plan item currently in flight, when inside a `foreach` body. */
    let currentItem: PlanItemRow | null = null;
    /** Handoff-chain length when each loop was first entered — the per-item reset point. */
    const loopMarks = new Map<string, number>();

    let cursor: string | null = graph.entryKey;
    // Backstop. Every cycle is individually bounded, but a template that
    // compiles to something pathological must fail loudly rather than bill for
    // an afternoon.
    let steps = 0;
    const MAX_STEPS = 500;

    // Resuming or rewinding: adopt the snapshot taken when the target node was
    // last entered. Everything the walker carries is restored except the plan
    // item, which is re-read from the row (the user may have edited it while
    // the run sat paused).
    if (args.resumeState) {
      const r = args.resumeState;
      cursor = r.cursor;
      previousOutput = r.previousOutput;
      handoffChain.push(...r.handoffChain);
      pipelineSources.push(...r.pipelineSources);
      for (const [k, v] of Object.entries(r.traversals)) traversals.set(k, v);
      for (const [k, v] of Object.entries(r.loopMarks)) loopMarks.set(k, v);
      for (const [k, v] of Object.entries(r.pendingFeedback)) pendingFeedback.set(k, v);
      for (const [k, v] of Object.entries(r.judgedContext)) judgedContext.set(k, v);
      pendingRejection = r.pendingRejection;
      rejectedReport = r.rejectedReport;
      steps = r.steps;
      currentItem = r.currentItemId
        ? (await pipelineRepository.getPlanItems(pipeline.id)).find((i) => i.id === r.currentItemId) ?? null
        : null;
    }

    while (cursor) {
      // Node boundary: snapshot first, then honour a pause request. Snapshot
      // BEFORE the node runs, so resuming re-enters this node rather than
      // trying to continue a worker turn mid-flight.
      const snapshot: WalkState = {
        cursor,
        previousOutput,
        handoffChain,
        pipelineSources,
        traversals: Object.fromEntries(traversals),
        loopMarks: Object.fromEntries(loopMarks),
        pendingFeedback: Object.fromEntries(pendingFeedback),
        judgedContext: Object.fromEntries(judgedContext),
        pendingRejection,
        rejectedReport,
        currentItemId: currentItem?.id ?? null,
        steps,
      };
      await pipelineRepository.saveCheckpoint({
        pipelineId: pipeline.id,
        nodeKey: cursor,
        state: serializeWalk(snapshot),
      });

      if (await this.pauseRequested(pipeline.id)) {
        await this.updatePipeline(pipeline.id, {
          status: 'paused',
          summary: `Paused at "${byKey.get(cursor)?.name ?? cursor}". Resume to continue from here.`,
        });
        return {
          pipelineId: pipeline.id,
          result: `Pipeline paused before "${byKey.get(cursor)?.name ?? cursor}".`,
        };
      }

      // Pipeline token pool. Per-node caps bound a VISIT; this bounds the RUN,
      // which is the only bound a `foreach` respects — its item count is not
      // known when the run starts, because a review or QA node can append
      // items to the plan while the loop is running. Checked at the node
      // boundary, so an over-budget run stops before paying for one more node
      // rather than mid-turn.
      const pool = getConfig().orchestrator.pipelineTokenBudget;
      const spent = [...nodes.values()].reduce((sum, n) => sum + n.tokensUsed, 0);
      const summary = poolExhaustedSummary(pool, spent, byKey.get(cursor)?.name ?? cursor);
      if (summary) {
        await this.updatePipeline(pipeline.id, { status: 'failed', summary });
        recordRunEvent({
          runId: sessionId,
          subject: 'pipeline',
          subjectId: pipeline.id,
          event: 'budget_exhausted',
          payload: { pool, spent, nodeKey: cursor },
        });
        return { pipelineId: pipeline.id, result: summary };
      }

      if (++steps > MAX_STEPS) {
        await this.updatePipeline(pipeline.id, {
          status: 'failed',
          summary: `Pipeline exceeded ${MAX_STEPS} node visits — the graph is not converging.`,
        });
        return {
          pipelineId: pipeline.id,
          result: `Pipeline stopped: exceeded ${MAX_STEPS} node visits without finishing.`,
        };
      }

      const gnode = byKey.get(cursor);
      const node = nodes.get(cursor);
      if (!gnode || !node) {
        await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Unknown node '${cursor}'.` });
        return { pipelineId: pipeline.id, result: `Pipeline failed: unknown node '${cursor}'.` };
      }

      await this.updatePipeline(pipeline.id, { currentNodeKey: cursor, status: 'running' });
      await this.updateNode(node.id, { visits: node.visits + 1 });
      node.visits += 1;

      // The run log records the WALK, which the node rows cannot: a row's
      // `status` is overwritten on every revisit, so a retry or a loop pass
      // leaves no trace there. Ordering, timing and checkpoint boundaries all
      // read from here.
      recordRunEvent({
        runId: sessionId,
        subject: 'pipeline_node',
        subjectId: node.nodeKey,
        event: 'node_entered',
        payload: { pipelineId: pipeline.id, name: node.name, role: node.role, kind: gnode.kind, visit: node.visits },
      });

      let outcome: NodeOutcome;

      // Per-step sign-off, unchanged from the linear runtime: a step declaring
      // `requiresApproval` pauses before it runs. Gated on `previousOutput`
      // because there is nothing to approve before the first stage produced
      // anything. The `foreach` head asks its own, different question (the
      // whole plan, once) in `runForeachNode`.
      if (gnode.kind === 'step' && node.requiresApproval && previousOutput) {
        const decision = await this.approveStepNode({
          pipeline, node, handoffChain, previousOutput, context, title,
        });
        if (decision === 'stop') {
          return { pipelineId: pipeline.id, result: `Pipeline stopped at "${node.name}".` };
        }
        if (decision === 'skip') {
          await this.updateNode(node.id, { status: 'skipped' });
          // A skipped QA node must still take its `qa_pass` edge — it has no
          // unconditional one, and "no edge" would end the walk silently.
          outcome = built[gnode.templateIndex].stageType === 'qa_validation' ? 'qa_pass' : 'ok';
          const skipEdge = selectEdge(graph, cursor, outcome, traversals);
          if (!skipEdge) {
            // Same question at the second exit. A skipped QA node whose only
            // routes are `qa_fail`/`audit_gate_failed` leaves the walk here,
            // and leaving `stoppedShort` null reported it green.
            // Ask about the outcome `selectEdge` was just given, not a
            // hardcoded 'ok': MATCHES.ok is ['always'] while MATCHES.qa_pass is
            // ['qa_pass','always'], so a skipped qa_validation node was having
            // its exhaustion checked against the wrong edge set.
            stoppedShort = routeExhausted(graph, cursor, outcome, traversals)
              ? { node: node.name, outcome }
              : null;
            break;
          }
          traversals.set(edgeId(skipEdge), (traversals.get(edgeId(skipEdge)) ?? 0) + 1);
          cursor = skipEdge.to;
          continue;
        }
      }

      if (gnode.kind === 'human') {
        // A QA node can route its rejection here (a human node is a legal retry
        // target). Consume it like a step does, or the person is re-asked the
        // original question with no idea what was rejected.
        const humanFeedback = pendingFeedback.get(cursor);
        if (humanFeedback) pendingFeedback.delete(cursor);
        const asked = await this.runHumanNode({
          pipeline,
          node,
          stageTemplate: template.stages[gnode.templateIndex],
          description,
          paramVars,
          previousOutput,
          feedback: humanFeedback,
          context,
          title,
        });
        if (asked.stopped) return asked.stopped;
        previousOutput = asked.output;
        previousRaw = asked.raw;
        pipelineSources.push(`stage(${node.ordinal + 1}: ${node.name}/human)`);
        outcome = 'ok';
      } else if (gnode.kind === 'foreach') {
        const stepResult = await this.runForeachNode({
          pipeline,
          node,
          currentItem,
          lastOutput: previousOutput,
          context,
          title,
        });
        if (stepResult.stopped) return stepResult.stopped;
        currentItem = stepResult.item;
        outcome = stepResult.outcome;

        if (outcome === 'loop_next') {
          // Each item starts from the state the loop was entered in. Two things
          // are per-item, not per-run: the retry budget on the body's QA edges
          // (item 1 burning three retries must not leave item 7 with zero), and
          // the handoff chain (every entry is concatenated into every later
          // prompt, so an unreset chain grows by one body pass per item until
          // it swamps the context).
          if (!loopMarks.has(cursor)) loopMarks.set(cursor, handoffChain.length);
          handoffChain.length = loopMarks.get(cursor) as number;
          const bodyKeys = new Set(
            graph.nodes.filter((n) => n.parentKey === cursor).map((n) => n.key),
          );
          for (const e of graph.edges) if (bodyKeys.has(e.from)) traversals.delete(edgeId(e));
        }
      } else {
        const b = built[gnode.templateIndex];
        const stageTemplate = template.stages[gnode.templateIndex];
        const isQa = b.stageType === 'qa_validation';

        // An auditor-only re-run must re-read the work it judged, not its own
        // previous verdict — otherwise a real retry followed by a rubber stamp
        // re-judges superseded work.
        if (isQa && pendingRejection) previousOutput = judgedContext.get(cursor) ?? previousOutput;

        const handoffText = handoffChain.length > 0 ? formatHandoffChain(handoffChain) : '';
        let input = expandPromptTemplate(stageTemplate.promptTemplate, {
          description,
          previousOutput: handoffText || previousOutput,
          ...paramVars,
        });

        // The item this pass is for. Appended rather than only substituted, so
        // a template written before plan loops existed still sees it.
        if (currentItem && gnode.parentKey) {
          input += `\n\n---\nCURRENT PLAN ITEM (#${currentItem.ordinal + 1}): ${currentItem.title}` +
            (currentItem.detail ? `\n${currentItem.detail}` : '') +
            `\n\nWork ONLY on this item. Anything else you discover: add it to the plan with ` +
            `\`plan__add_items\` instead of doing it here.`;
        }

        const feedback = pendingFeedback.get(cursor);
        if (feedback) {
          pendingFeedback.delete(cursor);
          input = `Previous attempt had issues:\n${feedback.feedback}\n\nPlease fix these issues:\n` +
            `${feedback.issues.join('\n')}\n\nOriginal task:\n${input}`;
        }

        // Non-terminal nodes emit a structured ```handoff block for whoever
        // runs next; `createHandoffContext` prefers it over regex scraping.
        if (graph.edges.some((e) => e.from === cursor)) input += HANDOFF_EMIT_INSTRUCTION;
        // A rejected REPORT is corrected, not re-audited (`qaVerdictCorrectionInput`).
        // Without the report to hand — a resume from a checkpoint written before
        // this existed — fall back to the full re-audit.
        const correcting = isQa && !!pendingRejection && !!rejectedReport;
        const reportUnderCorrection = correcting ? (rejectedReport as string) : undefined;
        // Run the command that DEFINES success, once, before the auditor turn.
        //
        // `runsCommands` only ever declared THAT a stage runs something, never
        // what — so a verify stage got a numbered checklist ("run the
        // regression test, run the full suite, try the original repro, check
        // for edge cases") and spent its iterations rediscovering the command.
        // Handing it a real exit code instead turns research back into
        // judgement, which is what an auditor is actually for.
        //
        // The result is stated whether it passed or failed: a failing verify
        // command is exactly the evidence the auditor needs to write an honest
        // FAIL, and hiding it would leave it guessing again.
        let frameworkVerified = false;
        if (isQa && !correcting && stageTemplate.verifyCommand) {
          const command = expandPromptTemplate(stageTemplate.verifyCommand, {
            description,
            previousOutput: handoffText || previousOutput,
            ...paramVars,
          }).trim();
          // An UNRESOLVED reference is not a command. A template whose steps
          // were copied without its parameters — `scripts/seed-cli-pipeline.ts`
          // clones the shipped steps, and a user template built the same way —
          // leaves `{{param.verifyCommand}}` standing, and running that literal
          // hands the auditor `RESULT: FAILED` for a command that never
          // existed, labelled as the ground truth it must not re-check. The
          // only safe reading of a placeholder is "no command was supplied".
          const unresolved = command.includes('{{');
          if (unresolved) {
            coreLogger.warn(
              { pipelineId: pipeline.id, stage: node.name, command },
              'Stage verifyCommand still holds an unresolved template reference — not running it',
            );
          }
          // One project-wide command, run once, on the LAST plan item. A
          // looping QA stage sees this per item, and `npm test` legitimately
          // fails while items 2..n are unwritten — which would hand the auditor
          // a FAILED ground truth for work nobody has started yet and bounce it
          // back to Implementation on every early item.
          let lastItem = true;
          if (currentItem && gnode.parentKey) {
            const items = await pipelineRepository.getPlanItems(pipeline.id);
            lastItem = isFinalPlanItem(items, currentItem);
          }
          if (command && !unresolved && lastItem) {
            const evidence = await runStageVerifyCommand(command, {
              userId: context.userId,
              sessionId,
              role: b.role,
              toolIds: b.toolIds,
            });
            input = `${evidence}\n\n---\n\n${input}`;
            frameworkVerified = true;
          }
        }

        if (isQa) {
          input = correcting
            ? qaVerdictCorrectionInput(
                reportUnderCorrection as string,
                pendingRejection as string,
                graph.edges.some((e) => e.from === cursor),
              )
            : withQaVerdictContract(input, pendingRejection);
          judgedContext.set(cursor, handoffText || previousOutput);
        }

        const stepResult = await this.runStepNode({
          pipeline,
          node,
          // A correction visit is told to run and change nothing, so it is not
          // judged against declarations it was just forbidden to satisfy.
          // Same reasoning for a framework-verified visit: it was handed the
          // exit code and told not to re-run it, so `runsCommands` would fail
          // the stage for obeying — and the command it declares it must execute
          // has been executed, by the framework, for this visit.
          declared: correcting
            ? correctionDeclaration(b)
            : frameworkVerified
              ? { ...b, runsCommands: false }
              : b,
          stageTemplate,
          input,
          // A correction visit is told to re-read nothing, and its own prompt
          // already carries the full report it must fix. Appending the judged
          // work as "context from previous steps" on top of that made the
          // correction prompt LARGER than the re-audit it replaces, and invited
          // a weak model to do the one thing it was forbidden to do.
          stageContext: correcting ? '' : handoffText || previousOutput,
          graph,
          context,
          registry,
          workspaceRoot,
          orchestratorAgentId: args.orchestratorAgentId,
          title,
        });
        if (stepResult.stopped) return stepResult.stopped;

        // The corrected reply is the verdict block alone, and the audit it
        // belongs to is the report it was written against, so the two are
        // re-joined. What the GATE reads stays the corrected reply alone:
        // re-parsing the pair would find the old, rejected block first
        // (`parseQAResult` takes the first fence that parses) and re-reject the
        // correction it never looked at.
        //
        // The pair is for the RECORD, not for the next node — a QA node with an
        // outgoing edge always emits a handoff, so downstream reads
        // `handoffText` and never this. It is the node row, the UI and the audit
        // trail that would otherwise keep a bare verdict with the findings gone.
        const verdictText = stepResult.output;
        // A correction reply is the verdict block alone. If it carries no
        // handoff fence there is nothing structured to parse, and scraping the
        // bare verdict would build the downstream handoff out of JSON with every
        // finding gone — which is what re-joining the report exists to prevent.
        // Fall back to the re-joined pair in that case, not to the bare reply.
        previousRaw = parseStructuredHandoff(stepResult.raw) ? stepResult.raw : '';
        previousOutput = reportUnderCorrection
          ? `${reportUnderCorrection}\n\n${stepResult.output}`
          : stepResult.output;
        // `runStepNode` stored the reply it received, which for a correction is
        // the verdict block ALONE — so the node row, the UI and the audit trail
        // lost the findings the verdict belongs to. Re-persist the pair the next
        // node reads, so what was audited survives where it can be inspected.
        if (reportUnderCorrection) {
          await this.updateNode(node.id, { output: previousOutput });
        }
        pipelineSources.push(`stage(${node.ordinal + 1}: ${node.name}/${node.role})`);
        pendingRejection = undefined;
        rejectedReport = undefined;

        if (isQa) {
          const auditScope = auditScopeBefore(
            node.ordinal,
            graph.nodes.map((n) => n.name),
            graph.nodes.map((n) => (n.templateIndex >= 0 ? built[n.templateIndex].producesArtifacts : false)),
            handoffConfidenceByStage(handoffChain),
          );
          const qaResult = await this.gateQaVerdict(verdictText, auditScope, {
            sessionId,
            pipelineId: pipeline.id,
            stageName: node.name,
          });
          if (!qaResult || qaResult.passed) {
            outcome = 'qa_pass';
          } else if (qaResult.auditGateFailed) {
            // The REPORT was rejected, not the work. Re-run the auditor alone.
            outcome = 'audit_gate_failed';
            pendingRejection = qaResult.feedback;
            // The original report, not the growing pile — re-embedding each
            // round's verdict block would enlarge the prompt every retry.
            // Only an unusable REPORT is correctable in place. A coverage
            // rejection says the auditor never examined stages it passed, and
            // the correction prompt forbids re-reading anything — so it could
            // only re-word, the gate would reject the same uncovered stages,
            // and the edge's retry budget would burn down with the missing
            // stage still unexamined. That one re-audits for real.
            rejectedReport =
              qaResult.auditGateReason === 'coverage'
                ? undefined
                : (reportUnderCorrection ?? previousOutput);
          } else {
            outcome = 'qa_fail';
          }
          if (qaResult && outcome !== 'qa_pass') {
            // Carry the verdict to whichever node the edge sends the work to —
            // the implementer on a retry, this same auditor on a re-report.
            const nextEdge = selectEdge(graph, cursor, outcome, traversals);
            if (nextEdge) {
              pendingFeedback.set(nextEdge.to, qaResult);
            } else if (outcome === 'qa_fail' && isRetryExhausted(graph, cursor, traversals)) {
              // Retries used up and QA still says no: ask a human rather than
              // looping, and rather than quietly accepting a failing verdict.
              const retryEdge = graph.edges.find((e) => e.from === cursor && e.condition === 'qa_fail');
              const escalated = await this.escalateQaFailure({
                pipeline,
                node,
                qaResult,
                attempts: retryEdge ? (traversals.get(edgeId(retryEdge)) ?? 0) : 0,
                context,
              });
              if (escalated) return escalated;
              unescalatedQaFailure = { node: node.name, outcome: 'qa_fail' as NodeOutcome };
              outcome = 'qa_pass';
            }
          }
        } else {
          outcome = 'ok';
        }
      }

      const edge = selectEdge(graph, cursor, outcome, traversals);
      if (!edge) {
        // Two very different exits share this one `break`, and they used to
        // share a summary too. A node with no route for this outcome has
        // finished; a node whose route existed and is now exhausted stopped
        // short of where it was going, and reporting "completed successfully"
        // for that is the same false green the evidence gate exists to prevent,
        // one level up — a QA stage can fail, burn its retry budget, and hand
        // the failing work back as a success. See `routeExhausted` for why "has
        // any outgoing edge" is the wrong test.
        stoppedShort =
          unescalatedQaFailure ??
          (routeExhausted(graph, cursor, outcome, traversals) ? { node: node.name, outcome } : null);
        break;
      }

      traversals.set(edgeId(edge), (traversals.get(edgeId(edge)) ?? 0) + 1);
      await pipelineRepository.recordTraversal(pipeline.id, edge.from, edge.to, edge.condition);
      recordRunEvent({
        runId: sessionId,
        subject: 'pipeline_node',
        subjectId: edge.from,
        parentSubjectId: edge.to,
        event: 'edge_traversed',
        payload: {
          pipelineId: pipeline.id,
          condition: edge.condition,
          outcome,
          traversals: traversals.get(edgeId(edge)),
        },
      });

      // A handoff is only built when moving FORWARD. A retry re-does work the
      // chain already describes; appending there would grow the chain without
      // bound and tell the next reader the same story twice.
      // `foreach` is the only kind with nothing to hand off — it runs no work.
      // A human node MUST hand off: the next node builds its prompt from the
      // chain when one exists, so an answer left out of it is silently dropped.
      if (gnode.kind !== 'foreach' && (edge.condition === 'always' || edge.condition === 'qa_pass')) {
        const target = nodes.get(edge.to);
        if (target) {
          handoffChain.push(
            await createHandoffContext({
              from: { role: node.role, stageName: node.name, stageIndex: node.ordinal },
              to: { role: target.role, stageName: target.name, stageIndex: target.ordinal },
              originalRequest: description,
              // RAW, so the structured block is still there to parse. Passing
              // the stripped reply made `parseStructuredHandoff` return null on
              // every stage, silently downgrading every handoff to regex-scraped
              // prose while the prompt kept demanding a fence.
              stageOutput: previousRaw || previousOutput,
            }),
          );
        }
      }

      cursor = edge.to;
    }

    const baseSummary = stoppedShort
      ? `Pipeline "${title}" STOPPED at "${stoppedShort.node}" (${stoppedShort.outcome}) — ` +
        `no route out of that stage was left to take, so the remaining stages never ran. ` +
        `Last output:\n\n${previousOutput}`
      : `Pipeline "${title}" completed successfully. Final output:\n\n${previousOutput}`;
    const summary = appendSources(baseSummary, pipelineSources);
    await this.updatePipeline(pipeline.id, {
      status: stoppedShort ? 'failed' : 'completed',
      summary,
      // `completedAt` marks a run that FINISHED. Stamping it on one that stopped
      // short would keep every duration and success rate computed from its
      // presence counting this as a completion, whatever `status` says.
      ...(stoppedShort ? {} : { completedAt: new Date() }),
    });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      // The UI and the notification below say the same thing the row does — a
      // run that stopped short must not arrive as a completion anywhere.
      data: {
        event: stoppedShort ? 'pipeline_failed' : 'pipeline_completed',
        pipelineId: pipeline.id,
        title,
        ...(stoppedShort ? { stoppedAt: stoppedShort.node, outcome: stoppedShort.outcome } : {}),
      },
      timestamp: new Date(),
    });

    getNotificationService().notify(
      pipeline.userId,
      // The TYPE, not only the title — anything filtering on `pipeline_complete`
      // would otherwise keep counting a stopped run as a finished one.
      stoppedShort ? 'pipeline_failed' : 'pipeline_complete',
      stoppedShort ? `Pipeline "${title}" stopped at "${stoppedShort.node}"` : `Pipeline "${title}" completed`,
      (previousOutput || '').slice(0, 200),
      { pipelineId: pipeline.id },
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

    return { pipelineId: pipeline.id, result: summary };
  }

  /**
   * List pipeline templates for a user.
   */
  async listTemplates(userId: string) {
    return this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, userId))
      .orderBy(desc(pipelineTemplates.createdAt));
  }

  /**
   * Get pipeline by ID with stages.
   */
  async getPipeline(id: string): Promise<Pipeline | null> {
    return pipelineRepository.findById(id);
  }

  /**
   * Get a pipeline's nodes, in display order. Execution order lives in the
   * edges — see `getGraph`.
   */
  async getNodes(pipelineId: string): Promise<PipelineNodeRow[]> {
    return pipelineRepository.getNodes(pipelineId);
  }

  /** Nodes, edges, and the live plan — everything the UI needs to draw a run. */
  async getGraph(pipelineId: string) {
    const [nodes, edges, plan] = await Promise.all([
      pipelineRepository.getNodes(pipelineId),
      pipelineRepository.getEdges(pipelineId),
      pipelineRepository.getPlanItems(pipelineId),
    ]);
    return { nodes, edges, plan };
  }

  /**
   * List pipelines for a user.
   */
  async listByUser(userId: string): Promise<Pipeline[]> {
    return this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.userId, userId))
      .orderBy(desc(pipelines.createdAt));
  }

  /**
   * List all pipelines (admin).
   */
  async listAll(): Promise<Pipeline[]> {
    return this.db
      .select()
      .from(pipelines)
      .orderBy(desc(pipelines.createdAt));
  }

  /**
   * Stop a running pipeline.
   */
  /**
   * Ask a running pipeline to stop at its next node boundary.
   *
   * Cooperative rather than a kill: the walker checks this flag where it also
   * writes its checkpoint, so a pause always lands on a state that can be
   * resumed. A node already in flight finishes — killing a worker mid-turn
   * loses its work and buys nothing back.
   */
  async pause(pipelineId: string): Promise<boolean> {
    const pipeline = await this.getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'running') return false;
    await this.updatePipeline(pipelineId, {
      metadata: { ...(pipeline.metadata ?? {}), pauseRequested: true },
    });
    return true;
  }

  /**
   * Boot sweep: a pipeline left `running` by a dead process is paused, so its
   * newest checkpoint becomes resumable. Returns how many were reconciled.
   *
   * Deliberately not an auto-resume: restarting paid work without being asked
   * is the wrong default, and the run may have been killed on purpose.
   */
  async reconcileInterrupted(): Promise<number> {
    const rows = await this.db
      .update(pipelines)
      .set({
        status: 'paused',
        summary: 'Interrupted by a restart — resume to continue from the last checkpoint.',
        updatedAt: new Date(),
      })
      // `awaiting_approval` is just as dead after a restart: the walker that was
      // blocked on the question is gone, and nothing will ever answer it.
      .where(inArray(pipelines.status, ['running', 'awaiting_approval']))
      .returning({ id: pipelines.id });

    // The stage the dead process was inside is still marked `running`, and its
    // worker died with that process. Leaving the row is a claim that work is in
    // flight when none is — the same class of lie as a run that reports success
    // after stopping short, one level down. `pending` is the honest state: the
    // interrupted node RE-RUNS on resume (a worker turn cannot be picked up
    // halfway), and `resume` locates itself from the checkpoints and
    // `currentNodeKey`, never from a node's status, so nothing reads the value
    // being reset here.
    //
    // `awaiting_approval` for the same reason the pipeline sweep above treats
    // it as dead: the walker sitting inside `requestApproval` is gone and
    // nothing will ever answer the question, so a stage row still claiming to
    // be waiting on the user is the identical lie one status over. `stop()`
    // already resets both together.
    if (rows.length > 0) {
      await this.db
        .update(pipelineNodes)
        .set({ status: 'pending' })
        .where(
          and(
            inArray(
              pipelineNodes.pipelineId,
              rows.map((r) => r.id),
            ),
            inArray(pipelineNodes.status, ['running', 'awaiting_approval']),
          ),
        );
    }
    return rows.length;
  }

  /** True once, then cleared — a pause request is consumed by the walker. */
  private async pauseRequested(pipelineId: string): Promise<boolean> {
    const pipeline = await this.getPipeline(pipelineId);
    const meta = (pipeline?.metadata ?? {}) as Record<string, unknown>;
    if (!meta.pauseRequested) return false;
    const { pauseRequested: _drop, ...rest } = meta;
    await this.updatePipeline(pipelineId, { metadata: rest });
    return true;
  }

  /**
   * Continue a pipeline that is not running — after a pause, a crash, or a
   * rewind.
   *
   * `fromSeq` selects which checkpoint to walk from; without it the newest one
   * wins, which is "carry on". Rewinding is the same call with an older seq:
   * the checkpoints after it are dropped (they describe a future that is being
   * replaced) and the walk re-enters that node with the state it had then.
   *
   * The node that was interrupted RE-RUNS. Its previous output is already on
   * its row, and a worker turn cannot be resumed halfway.
   */
  async resume(
    pipelineId: string,
    opts: { fromSeq?: number } = {},
  ): Promise<{ pipelineId: string; result: string }> {
    const pipeline = await this.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found.`);
    // Two walkers on one pipeline would write the same node rows and pay for
    // the same workers twice. `awaiting_approval` counts as live: a walker is
    // sitting inside `requestApproval` with the run in hand. After a restart
    // that promise is gone, and the boot sweep is what turns those rows into
    // `paused` so this guard stops applying.
    if (pipeline.status === 'running' || pipeline.status === 'awaiting_approval') {
      throw new Error(`Pipeline ${pipelineId} is already ${pipeline.status}.`);
    }
    if (this.walking.has(pipelineId)) {
      throw new Error(`Pipeline ${pipelineId} is already being walked in this process.`);
    }

    const checkpoint = opts.fromSeq != null
      ? await pipelineRepository.getCheckpoint(pipelineId, opts.fromSeq)
      : (await pipelineRepository.getCheckpoints(pipelineId, 1))[0] ?? null;
    if (!checkpoint) {
      throw new Error(`Pipeline ${pipelineId} has no checkpoint to resume from.`);
    }
    const resumeState = hydrateWalk(checkpoint.state);
    if (!resumeState) {
      throw new Error(`Checkpoint ${checkpoint.seq} does not hold a readable walk state.`);
    }

    // A pause request the walker never reached (it was inside the last node
    // when the run ended) would otherwise fire on the first boundary of THIS
    // walk and pause it before it did anything.
    const meta = (pipeline.metadata ?? {}) as Record<string, unknown>;
    if (meta.pauseRequested) {
      const { pauseRequested: _drop, ...rest } = meta;
      await this.updatePipeline(pipelineId, { metadata: rest });
    }

    // Rewind: anything recorded after the target describes a walk that is being
    // replaced. Dropping it keeps "resume from the newest" honest.
    if (opts.fromSeq != null) {
      await pipelineRepository.deleteCheckpointsAfter(pipelineId, checkpoint.seq);
    }

    // Rebuild what the run was compiled from. The template is read by type and
    // recompiled rather than stored: a graph is a pure function of the template,
    // and the node/edge rows the walker reads are already persisted.
    const template = await getPipelineTemplate(pipeline.type, pipeline.userId ?? undefined);
    // The creation-time override only ever lived in memory; without re-applying
    // it here every QA edge silently reverts to the default of 3.
    const resumeMaxRetries = ((pipeline.metadata ?? {}) as { maxRetries?: number }).maxRetries;
    if (resumeMaxRetries != null) {
      for (const stage of template.stages) {
        if (stage.stageType === 'qa_validation') stage.maxRetries = resumeMaxRetries;
      }
    }
    const built = buildStagesFromTemplate(template, pipeline.description ?? '');
    const graph = compileTemplateToGraph(template.stages);
    const graphErrors = [...validateGraph(graph), ...stageContractErrors(template.stages)];
    if (graphErrors.length > 0) {
      throw new Error(`Pipeline "${pipeline.type}" no longer compiles: ${graphErrors.join('; ')}`);
    }
    // The persisted nodes are the run; the template is only how they were
    // produced. If a recipe was edited while this run sat paused, the recompiled
    // keys no longer line up — an inserted stage points the walk at a node row
    // that does not exist, and a reorder runs one stage's prompt through
    // another's role. Refuse rather than half-run a graph nobody designed.
    const persistedKeys = new Set((await pipelineRepository.getNodes(pipelineId)).map((n) => n.nodeKey));
    const missing = graph.nodes.filter((n) => !persistedKeys.has(n.key)).map((n) => n.key);
    if (missing.length > 0 || persistedKeys.size !== graph.nodes.length) {
      throw new Error(
        `Recipe "${pipeline.type}" has changed since this run started ` +
          `(${missing.length > 0 ? `new nodes ${missing.join(', ')}` : 'node count differs'}). ` +
          `Start a new run instead of resuming this one.`,
      );
    }

    const storedParams = ((pipeline.metadata ?? {}) as { params?: Record<string, unknown> }).params ?? {};
    const paramVars = paramTemplateVars(resolveRecipeParams(template.parameters, storedParams));

    // The context is rebuilt from the pipeline row rather than passed in: the
    // caller of a resume is an HTTP request or a boot-time sweep, neither of
    // which holds the agent context the original run was started with, and
    // everything downstream needs from it is on the row.
    const context: AgentContext = {
      id: pipeline.orchestratorAgentId,
      sessionId: pipeline.sessionId,
      userId: pipeline.userId,
      workspaceId: pipeline.workspaceId,
      topic: 'general',
      role: ROOT_ROLE,
      root: true,
      model: '',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { pipelineId, resumed: true },
    };

    await this.updatePipeline(pipelineId, { status: 'running', currentNodeKey: resumeState.cursor });
    coreLogger.info(
      { pipelineId, fromSeq: checkpoint.seq, nodeKey: resumeState.cursor },
      'Resuming pipeline from checkpoint',
    );

    return this.runGraph({
      pipeline: { ...pipeline, status: 'running' },
      graph,
      built,
      template,
      paramVars,
      description: pipeline.description ?? '',
      title: pipeline.title,
      context,
      orchestratorAgentId: pipeline.orchestratorAgentId,
      sessionId: pipeline.sessionId,
      resumeState,
    });
  }

  async stop(pipelineId: string): Promise<boolean> {
    const pipeline = await this.getPipeline(pipelineId);
    if (!pipeline || pipeline.status === 'completed' || pipeline.status === 'failed') {
      return false;
    }

    await this.updatePipeline(pipelineId, {
      status: 'paused',
      summary: 'Pipeline stopped by user.',
    });

    // Mark running nodes as skipped
    for (const node of await this.getNodes(pipelineId)) {
      if (node.status === 'running' || node.status === 'awaiting_approval') {
        await this.updateNode(node.id, { status: 'skipped' });
      }
    }

    return true;
  }

  /**
   * Parse QA validation output into a structured result.
   *
   * Resolution order (most reliable → fuzziest):
   *   1. Strict JSON (with or without code fences) — what well-prompted
   *      agents emit when asked for a `{"passed":bool,...}` deliverable.
   *   2. Inline JSON keys (`"passed": true|false`) anywhere in prose.
   *   3. Prose verdict keywords matching the seed-template wording —
   *      `Overall status: PASS|FAIL|PASS WITH NOTES`,
   *      `Rate overall quality: Excellent|Good|Needs Work|Critical Issues`,
   *      bare `PASS` / `FAIL` headlines.
   *
   *   Why (3) exists: the built-in "Full Development Cycle" template
   *   prompts the agent to emit those exact verdicts in prose, not JSON.
   *   Without (3), the retry loop silently no-ops on a failing QA stage
   *   because `parseQAResult` returns null → `while (qaResult && ...)`
   *   short-circuits and the pipeline marks the stage "complete".
   */
  /**
   * Persist a QA verdict to the verification evidence ledger. Best-effort: a
   * ledger write must never break the pipeline, so failures are logged and
   * swallowed. Append-only — every verdict (initial + each retry) is a row.
   */
  /**
   * Evidence gate for a stage that DECLARED what it is for — leaving files
   * behind (`producesArtifacts`), executing something (`runsCommands`), or
   * both. Throws when the stage did none of what it declared, so the caller's
   * existing error path marks the stage — and the pipeline — failed. Without
   * this a "Full Development Cycle" reports seven green stages over an empty
   * workspace, which is the exact failure this gate exists for
   * (docs/plans/pipeline-evidence-gate.md).
   *
   * Three deliberate non-behaviours:
   * - An UNDECLARED stage is never gated and never even writes a row. Research
   *   and review stages legitimately write nothing.
   * - `counters === null` means "we could not measure", NOT "it did nothing" —
   *   it passes, loudly, and records `passed: true` with the gap named. Failing
   *   work that actually succeeded is the worse error (the standing guidance on
   *   `deriveCodeDiffScorer`).
   * - The ledger write is best-effort and never breaks a run, matching
   *   `recordQaEvidence`. The gate decision itself does NOT depend on it.
   */
  private async assertStageEvidence(args: {
    sessionId: string;
    pipelineId: string;
    stageName: string;
    declared: StageDeclaration | undefined;
    counters: SideEffectCounters | null;
    /** Workspace state captured before the stage ran — see `snapshotStage`. */
    before?: WorkspaceSnapshot | null;
    /** Root the stage's worker writes to, re-walked here for the "after" side. */
    workspaceRoot?: string | null;
  }): Promise<void> {
    const declared: StageDeclaration = {
      producesArtifacts: args.declared?.producesArtifacts,
      runsCommands: args.declared?.runsCommands,
      readOnly: args.declared?.readOnly,
    };
    if (!declared.producesArtifacts && !declared.runsCommands && !declared.readOnly) return;

    const { counters, stageName, pipelineId } = args;
    const measured = counters !== null;

    // The "after" side of the snapshot. Taken here rather than at the call site
    // so it is impossible to gate on a stale reading: this runs immediately
    // before the decision that uses it.
    const after = args.before && args.workspaceRoot ? await snapshotWorkspace(args.workspaceRoot) : null;
    // The declaration decides how the diff is SCORED, not what the walk records:
    // a snapshot that hides files can never be re-scored, and two snapshots taken
    // under different rules cannot be compared at all.
    const filesTouched = countChangedFiles(args.before ?? null, after, {
      countPackages: declared.producesArtifacts === true,
    });

    const failure = stageEvidenceFailure(declared, counters, filesTouched);
    const passed = failure === null;

    try {
      await verificationEvidenceRepository.record({
        sessionId: args.sessionId,
        pipelineId,
        stage: stageName,
        kind: 'side_effect',
        passed,
        detail: {
          // Recorded even when null, so a later reader can tell "the snapshot
          // said nothing changed" from "there was no snapshot" — the two reasons
          // a counters-only failure can happen.
          filesTouched,
          ...(measured
            ? {
                filesChanged: counters.filesChanged,
                toolCalls: counters.toolCalls,
                commandsRun: counters.commandsRun,
                toolErrors: counters.toolErrors,
                byName: counters.byName,
              }
            : {
                // Two different states, and conflating them makes the ledger
                // contradict itself. A counter-less worker is normally passed
                // ungated — but the snapshot alone can still condemn it
                // (`readOnly`), and labelling THAT row "not gated" would leave a
                // reader looking at a failed row that claims nothing judged it.
                unavailable: passed
                  ? 'worker exposed no side-effect counters — not gated'
                  : 'worker exposed no side-effect counters — gated on the workspace snapshot alone',
                ...(failure ? { reason: failure } : {}),
              }),
        },
      });
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, pipelineId, stage: stageName }, 'Failed to record side-effect verification evidence');
    }

    if (!measured && !failure) {
      // The snapshot can still have seen the work even when the worker exposed
      // no tally (a CLI worker). That is a measured pass, not an ungated one —
      // worth distinguishing in the log, because "ungated" is a gap to fix and
      // this is not.
      //
      // Guarded on `!failure` so a rule the SNAPSHOT can decide by itself still
      // bites here: `readOnly` needs no counters, and returning early on a
      // counter-less worker is what let a CLI QA stage edit the deliverable it
      // was validating and pass.
      if (filesTouched !== null && filesTouched > 0) {
        coreLogger.info(
          { pipelineId, stage: stageName, filesTouched },
          'Stage exposed no counters, but the workspace shows its work — passing on filesystem evidence',
        );
      } else {
        coreLogger.warn(
          { pipelineId, stage: stageName, filesTouched },
          'Stage made a declaration but its worker exposed no counters — passing ungated (unknown is not zero)',
        );
      }
      return;
    }

    if (failure) {
      throw new Error(
        `Stage "${stageName}" did not do what it declared: ${failure}. ` +
          `Reporting it complete would claim work that did not happen.`,
      );
    }
  }

  /**
   * The workspace root this session's stage workers actually write to.
   *
   * `WorkspaceFS.forSession` is the shared resolver — a dev-mode session with a
   * `projectPath` runs its agents inside that project, everyone else gets the
   * per-user nested workspace. Reused rather than reimplemented so the gate can
   * never snapshot a different directory than the one the worker wrote to; a
   * mismatch would report "workspace unchanged" for every stage.
   *
   * Resolved once per pipeline run: it cannot change mid-run, and the session
   * lookup is a DB round-trip we do not need per stage.
   */
  private async resolveWorkspaceRoot(sessionId: string): Promise<string | null> {
    try {
      const session = await sessionRepository.findById(sessionId);
      if (!session) return null;
      return WorkspaceFS.forSession(session).root;
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, sessionId }, 'Could not resolve workspace root for the evidence gate');
      return null;
    }
  }

  /**
   * The "before" half of a stage's filesystem evidence.
   *
   * Only walks the tree for a stage that DECLARED it produces artifacts —
   * everything else is not gated, so the scan would be pure cost.
   */
  private async snapshotStage(
    declared: StageDeclaration | undefined,
    workspaceRoot: string | null,
  ): Promise<WorkspaceSnapshot | null> {
    // Both declarations need the filesystem: one to prove work happened, the
    // other to prove it did not.
    if (!workspaceRoot || !(declared?.producesArtifacts || declared?.readOnly)) return null;
    return snapshotWorkspace(workspaceRoot);
  }

  /**
   * Parse a QA/review stage's output and hold its verdict to account.
   *
   * Wraps `parseQAResult` so every verdict — both run loops, both the initial
   * pass and each retry — goes through one chokepoint. A PASSING verdict that
   * cannot account for the stages it covered (`auditVerdictFailure`) is
   * downgraded to a failure carrying the gate's reason, which puts it on the
   * existing retry path instead of turning the pipeline green.
   *
   * `scope` is the artifact-producing stages completed before this auditor,
   * derived from the DECLARED `producesArtifacts` flag rather than inferred
   * from stage names — same discipline as `stageEvidenceFailure`.
   *
   * Returns null when the output carried no parseable verdict at all; callers
   * already treat that as "no QA signal" and skip the retry loop.
   */
  private async gateQaVerdict(
    output: string,
    scope: AuditScopeStage[],
    evidence: { sessionId: string; pipelineId: string; stageName: string },
  ): Promise<QAValidationResult | null> {
    const parsed = this.parseQAResult(output);
    if (!parsed) {
      // A `qa_validation` stage that emits nothing parseable used to mean "no QA
      // signal — skip the retry loop", which let an auditor opt itself out of
      // being audited simply by not answering the question. Measured: a QA stage
      // ended with a prose "**Verdict:** implementation is correct" instead of
      // the requested JSON, so `audit_coverage` never fired and the pipeline
      // went green on an unexamined verdict.
      //
      // Treated as a FAILED audit gate: the deliverable may be perfectly fine,
      // it is the report that is unusable, so this takes the auditor-only retry
      // path (`auditGateFailed`) rather than re-running the implementation.
      const reason =
        'the stage produced no machine-readable verdict. Emit the required ```json block with ' +
        'passed / confidence / issues / feedback / whatIDidNotCheck — a verdict nobody can read ' +
        'cannot be audited, and an unaudited pass is not a pass.';
      coreLogger.warn(
        { pipelineId: evidence.pipelineId, stage: evidence.stageName },
        'QA stage emitted no parseable verdict — treating as an audit-gate failure',
      );
      try {
        await verificationEvidenceRepository.record({
          sessionId: evidence.sessionId,
          pipelineId: evidence.pipelineId,
          stage: evidence.stageName,
          kind: 'audit_coverage',
          passed: false,
          detail: { reason, source: 'unparseable', scope: coverageScope(scope).map((s) => s.name) },
        });
      } catch (err) {
        coreLogger.warn({ err: (err as Error).message }, 'Failed to record unparseable-verdict evidence');
      }
      return { passed: false, issues: [reason], feedback: reason, retryCount: 0, auditGateFailed: true, auditGateReason: 'unparseable' };
    }

    void this.recordQaEvidence(evidence.sessionId, evidence.pipelineId, evidence.stageName, parsed);

    const failure = auditVerdictFailure(parsed, scope);
    if (!parsed.passed) return parsed;

    try {
      await verificationEvidenceRepository.record({
        sessionId: evidence.sessionId,
        pipelineId: evidence.pipelineId,
        stage: evidence.stageName,
        kind: 'audit_coverage',
        passed: failure === null,
        confidence: parsed.confidence ?? null,
        detail: {
          scope: coverageScope(scope).map((s) => s.name),
          doubtScope: scope.filter((s) => s.confidence === 'low').map((s) => s.name),
          uncovered: uncoveredStages(parsed, coverageScope(scope)),
          unaddressedDoubt: unaddressedDoubt(parsed, scope),
          source: parsed.source ?? 'unknown',
          whatIDidNotCheck: parsed.whatIDidNotCheck ?? [],
          ...(failure ? { reason: failure } : {}),
        },
      });
    } catch (err) {
      coreLogger.warn(
        { err: (err as Error).message, pipelineId: evidence.pipelineId, stage: evidence.stageName },
        'Failed to record audit-coverage verification evidence',
      );
    }

    if (!failure) {
      // No silent caps: a pass that never went through the structured tier was
      // exempt from the thin-verdict rules. Say so, rather than let a degraded
      // parse read as a fully-gated pass.
      if (parsed.source !== 'json') {
        coreLogger.warn(
          { pipelineId: evidence.pipelineId, stage: evidence.stageName, source: parsed.source ?? 'unknown' },
          'Audit gate passed a verdict that never reached the structured tier — thin-verdict rules did not apply',
        );
      }
      return parsed;
    }

    coreLogger.warn(
      { pipelineId: evidence.pipelineId, stage: evidence.stageName, failure },
      'Audit-coverage gate rejected a passing verdict — re-running the auditor',
    );
    return {
      ...parsed,
      passed: false,
      auditGateFailed: true,
      auditGateReason: 'coverage',
      feedback: `Your PASS verdict was rejected: ${failure}\n\n${parsed.feedback}`.trim(),
      issues: [...parsed.issues, failure],
    };
  }

  private async recordQaEvidence(
    sessionId: string,
    pipelineId: string,
    stage: string,
    qaResult: QAValidationResult,
  ): Promise<void> {
    try {
      await verificationEvidenceRepository.record({
        sessionId,
        pipelineId,
        stage,
        kind: 'qa_verdict',
        passed: qaResult.passed,
        confidence: qaResult.confidence ?? null,
        detail: { issues: qaResult.issues, feedback: qaResult.feedback, retryCount: qaResult.retryCount },
      });
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, pipelineId, stage }, 'Failed to record QA verification evidence');
    }
  }

  private parseQAResult(output: string): QAValidationResult | null {
    // (1) Strict JSON parse. Scan EVERY fenced block (plus the bare-string
    // fallback) and take the first that yields an object with a boolean
    // `passed` — a QA/code-review report often has a code block ABOVE its
    // verdict, so matching only the first fence would parse the wrong block.
    const candidates: string[] = [];
    for (const m of output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g)) {
      candidates.push(m[1].trim());
    }
    // Fenced blocks in reply order; the bare-output fallback is appended after,
    // and tier 1b reverses only the fenced slice (see there).
    const fencedCount = candidates.length;
    candidates.push(output.trim()); // whole output, when the model emitted bare JSON
    for (const jsonStr of candidates) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed.passed === 'boolean') {
          return {
            passed: parsed.passed,
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
            retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : 0,
            confidence: normalizeConfidence(parsed.confidence),
            whatIDidNotCheck: normalizeStringList(parsed.whatIDidNotCheck),
            source: 'json',
          };
        }
      } catch { /* try the next candidate */ }
    }

    // (1b) A structured block that answers the question under different field
    // names. Measured 2026-08-21: a QA stage emitted a fenced `json` verdict of
    // its own shape — `{"verdict": "approve", "blockers": [], "summary": ...}` —
    // and the gate threw it away as "no machine-readable verdict", re-ran the
    // whole audit three times at ~430k tokens a visit and killed the run on the
    // token pool without ever judging the substance. The block WAS machine
    // readable; only the key names differed. Rejecting a parseable verdict over
    // vocabulary is the gate failing, not the auditor.
    //
    // Runs as a second pass so a literal `passed` block anywhere in the reply
    // still wins, and stays inside the structured tier: the thin-verdict rules
    // apply to it, and the fields it lacks are exactly what the retry asks for.
    // LAST block wins here, unlike tier 1: the contract asks for the verdict as
    // the last thing in the reply, and an alias key is common enough in
    // incidental JSON (`{"status": "ok"}` from a health check, `{"result":
    // "success"}` from a test summary) that taking the first match would read a
    // quoted payload as the verdict.
    // Reverse the FENCED slice only. Reversing the whole list would put the
    // bare-output fallback first, which is the opposite of what the comment
    // above promises — harmless only while a reply containing fences never
    // parses as bare JSON, and quietly wrong for whoever relies on the order.
    for (const jsonStr of [...candidates.slice(0, fencedCount).reverse(), ...candidates.slice(fencedCount)]) {
      try {
        const alias = aliasVerdict(JSON.parse(jsonStr));
        if (alias) return alias;
      } catch { /* try the next candidate */ }
    }

    // (2) Inline `"passed": true|false` anywhere in prose
    const passedMatch = output.match(/"passed"\s*:\s*(true|false)/);
    if (passedMatch) {
      const passed = passedMatch[1] === 'true';
      const issuesMatch = output.match(/"issues"\s*:\s*\[([\s\S]*?)\]/);
      const feedbackMatch = output.match(/"feedback"\s*:\s*"([\s\S]*?)"/);
      return {
        passed,
        issues: issuesMatch
          ? issuesMatch[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
          : [],
        // Same reason as the prose tier: an empty `feedback` gives the
        // audit-coverage gate nothing to match, so a verdict whose feedback
        // field did not parse falls back to the report itself rather than to
        // an empty string that would read as "named nothing".
        feedback: feedbackMatch ? feedbackMatch[1] : output.slice(0, 2000),
        retryCount: 0,
        confidence: parseConfidence(output),
        source: 'inline',
      };
    }

    // (3) Prose verdict patterns — matches the wording the built-in
    //     templates ask the QA / Code Review agents to emit.
    const proseVerdict = this.parseProseVerdict(output);
    if (proseVerdict) return proseVerdict;

    coreLogger.debug({ outputSnippet: output.slice(0, 200) }, 'Could not parse QA validation output (no JSON, no prose verdict)');
    return null;
  }

  /**
   * Extract pass/fail verdict from prose. Returns null if no recognizable
   * verdict was found. Failing verdicts capture an issues list from common
   * markdown headings (`## Issues`, `### Issues`, `**Issues:**`, etc.) so
   * the retry prompt has actionable feedback to inject into the
   * implementation stage.
   */
  private parseProseVerdict(output: string): QAValidationResult | null {
    // Negative verdicts win over positive — a stage that says "mostly good
    // but FAIL on X" should retry, not pass.
    const NEGATIVE_PATTERNS = [
      /Overall\s+status\s*:\s*FAIL\b/i,
      /Overall\s+status\s*:\s*PASS\s+WITH\s+NOTES\b/i, // treat as failure → retry
      /Rate\s+overall\s+quality\s*:\s*(?:Needs\s+Work|Critical\s+Issues)\b/i,
      /Overall\s+quality\s*:\s*(?:Needs\s+Work|Critical\s+Issues)\b/i,
      /\bVerdict\s*:\s*(?:fail|reject|not\s+ready)\b/i,
      /^[#*\s]*FAIL\b/im,
    ];
    const POSITIVE_PATTERNS = [
      /Overall\s+status\s*:\s*PASS\b(?!\s+WITH\s+NOTES)/i,
      /Rate\s+overall\s+quality\s*:\s*(?:Excellent|Good)\b/i,
      /Overall\s+quality\s*:\s*(?:Excellent|Good)\b/i,
      /\bVerdict\s*:\s*(?:pass|approve|ready)\b/i,
      /^[#*\s]*PASS\b/im,
    ];

    const hasNegative = NEGATIVE_PATTERNS.some(rx => rx.test(output));
    const hasPositive = POSITIVE_PATTERNS.some(rx => rx.test(output));

    if (!hasNegative && !hasPositive) return null;

    const passed = hasNegative ? false : true;

    // Pull an issues bullet list from common heading shapes if the verdict
    // is negative — gives the retry prompt something concrete to act on.
    let issues: string[] = [];
    if (!passed) {
      const issuesSection = output.match(
        /(?:^|\n)\s*(?:#{1,4}\s+|\*\*)\s*(?:Issues\s+found|Issues|Critical\s+Issues|Problems|Findings)\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{1,4}\s+|\*\*[A-Z])|\n\s*$|$)/i,
      );
      if (issuesSection) {
        issues = issuesSection[1]
          .split('\n')
          .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
          .filter(line => line.length > 0 && !line.startsWith('#'))
          .slice(0, 20);
      }
    }

    return {
      passed,
      issues,
      // The prose report IS the verdict's reasoning, on a pass as much as on a
      // failure. It used to be dropped for a pass (nothing read it), but the
      // audit-coverage gate matches the audited stage names against `feedback`
      // — blanking it here would reject every honest prose audit for naming
      // nothing, the one outcome worse than no gate.
      feedback: output.slice(0, 2000),
      retryCount: 0,
      confidence: parseConfidence(output),
      source: 'prose',
    };
  }

  /**
   * Run one `step` node: approval gate, worker spawn, evidence gate, persist.
   *
   * Returns `{ stopped }` when the pipeline must end here (user stopped it, or
   * the node failed) — the caller returns that verbatim, so every exit still
   * goes through one place.
   */
  private async runStepNode(args: {
    pipeline: Pipeline;
    node: PipelineNodeRow;
    declared: ReturnType<typeof buildStagesFromTemplate>[number];
    stageTemplate: StageTemplate;
    input: string;
    stageContext: string;
    graph: PipelineGraph;
    context: AgentContext;
    registry: ModelRegistry;
    workspaceRoot: string | null;
    orchestratorAgentId: string;
    title: string;
  }): Promise<{ output: string; raw: string; stopped?: { pipelineId: string; result: string } }> {
    const { pipeline, node, declared, stageTemplate, input, stageContext, context, registry, workspaceRoot, title } = args;
    const orchestrator = getOrchestratorService();
    const sessionId = pipeline.sessionId;

    await this.updateNode(node.id, { input, status: 'running' });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'stage_started', pipelineId: pipeline.id, stageId: node.id, name: node.name, role: node.role, index: node.ordinal },
      timestamp: new Date(),
    });

    messageRepository.create({
      sessionId,
      role: 'system',
      content: `**${node.name}** (${node.role || 'agent'}) started`,
      metadata: { pipelineId: pipeline.id, stageId: node.id, pipelineEvent: 'stage_started' },
    }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

    let spentTokens = 0;
    try {
      // Resolve the model for this node's topic. Node override → a mechanical
      // node's lane executor → topic binding.
      const modelOverride = await resolveStageModel(stageTemplate, node.role, registry);
      const before = await this.snapshotStage(declared, workspaceRoot);

      let counters: SideEffectCounters | null = null;
      const result = await orchestrator.spawnWorker(
        node.role,
        input,
        stageContext,
        {
          ...context,
          stageName: node.name,
          // Read by the `plan` tool to scope its writes to THIS pipeline. A
          // worker cannot be trusted to pass a pipeline id it was told.
          metadata: { ...(context.metadata ?? {}), pipelineId: pipeline.id, nodeKey: node.nodeKey },
        } as AgentContext,
        {
          ...(modelOverride ? { model: modelOverride } : {}),
          toolIds: node.toolIds ?? declared.toolIds,
          // Held to the same declaration the evidence gate judges afterwards —
          // but BEFORE the model runs, against the tools it will actually hold.
          purpose: { producesArtifacts: declared.producesArtifacts, runsCommands: declared.runsCommands },
          // `NodeBudget.tokens.cap` for a graph node. Null ⇒ the global
          // per-agent default, which is what every stage ran on before.
          ...(node.maxTokens != null ? { maxTokenBudget: node.maxTokens } : {}),
          // Charged cumulatively: a retry inside the worker, and every later
          // visit of this node, add to the same total.
          onTokens: (t) => { spentTokens += t; },
          ...(this.grantedToolIds(declared) ? { extraToolIds: this.grantedToolIds(declared) } : {}),
          swarmParent: {
            id: args.orchestratorAgentId,
            rootSessionId: sessionId,
            topicPath: node.visits > 1
              ? `pipeline/${pipeline.id}/${node.name}#visit${node.visits}`
              : `pipeline/${pipeline.id}/${node.name}`,
            subtopic: node.visits > 1 ? `${node.name} (visit ${node.visits})` : node.name,
          },
          onCounters: (c) => { counters = c; },
        },
      );

      // A node that returns nothing has not reported, whatever its status.
      if (String(result ?? '').trim() === '') {
        throw new Error(
          `Stage "${node.name}" returned an empty result. The worker ended without producing ` +
            `any output (commonly a truncated turn or an exhausted budget), so there is nothing ` +
            `to hand to the next stage.`,
        );
      }

      await this.assertStageEvidence({
        sessionId,
        pipelineId: pipeline.id,
        stageName: node.name,
        declared,
        before,
        workspaceRoot,
        counters,
      });

      // A planner that produced no plan would send the loop straight past every
      // item — zero iterations reading as success. Same shape as the artifacts
      // gate: a declaration is a contract, not a hint.
      if (declared.producesPlan) {
        const items = await pipelineRepository.getPlanItems(pipeline.id);
        if (items.length === 0) {
          throw new Error(
            `Stage "${node.name}" declares producesPlan but left no plan items. ` +
              `It must call \`plan__add_items\` with the steps the pipeline should carry out.`,
          );
        }
      }

      // Persist and forward the STRIPPED reply, so the internal block is never
      // shown or bled into the next node — but RETURN the raw one as well, so
      // the handoff can still be parsed from it. Returning only the stripped
      // reply is what killed the structured path: `createHandoffContext` was
      // handed text the block had already been cut out of, so
      // `parseStructuredHandoff` returned null every time and every stage fell
      // back to scraping prose with regexes, while the prompt kept asking each
      // one for a fence nothing read.
      const raw = String(result || '');
      const output = stripHandoffBlock(raw);

      await this.updateNode(node.id, { status: 'completed', output, completedAt: new Date() });
      recordRunEvent({
        runId: sessionId,
        subject: 'pipeline_node',
        subjectId: node.nodeKey,
        event: 'node_completed',
        payload: { pipelineId: pipeline.id, name: node.name, visit: node.visits, outputChars: output.length },
      });

      const stageSummary = output.length > 300
        ? `${output.slice(0, 300).replace(/\n/g, ' ').trim()}...`
        : output.replace(/\n/g, ' ').trim();

      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: {
          event: 'stage_completed',
          pipelineId: pipeline.id,
          stageId: node.id,
          name: node.name,
          role: node.role,
          summary: stageSummary.slice(0, 200),
        },
        timestamp: new Date(),
      });

      messageRepository.create({
        sessionId,
        role: 'system',
        content: `**${node.name}** (${node.role || 'agent'}) completed: ${stageSummary.slice(0, 200)}`,
        metadata: { pipelineId: pipeline.id, stageId: node.id, pipelineEvent: 'stage_completed' },
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

      return { output, raw };
    } catch (error) {
      const errorMsg = (error as Error).message;
      await this.updateNode(node.id, { status: 'failed', error: errorMsg });
      recordRunEvent({
        runId: sessionId,
        subject: 'pipeline_node',
        subjectId: node.nodeKey,
        event: 'node_failed',
        payload: { pipelineId: pipeline.id, name: node.name, visit: node.visits, reason: errorMsg },
      });
      await this.updatePipeline(pipeline.id, {
        status: 'failed',
        summary: `Failed at stage: ${node.name} — ${errorMsg}`,
      });

      coreLogger.error({ error, pipelineId: pipeline.id, stage: node.name }, 'Pipeline stage failed');
      getNotificationService().notify(
        pipeline.userId,
        'pipeline_error',
        `Pipeline "${title}" failed`,
        `Failed at stage "${node.name}": ${errorMsg}`,
        { pipelineId: pipeline.id, stage: node.name },
      ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

      return { output: '', raw: '', stopped: { pipelineId: pipeline.id, result: `Pipeline failed at "${node.name}": ${errorMsg}` } };
    } finally {
      // Charge the node whatever this visit cost, success or failure — a run
      // that failed still burned the tokens, and the pool it draws from is what
      // bounds a loop whose item count is not known when the run starts. The
      // in-memory row is updated too: the walker sums it without re-reading.
      if (spentTokens > 0) {
        node.tokensUsed += spentTokens;
        await this.updateNode(node.id, { tokensUsed: node.tokensUsed });
        recordRunEvent({
          runId: sessionId,
          subject: 'pipeline_node',
          subjectId: node.nodeKey,
          event: 'node_tokens',
          payload: {
            pipelineId: pipeline.id,
            name: node.name,
            visit: node.visits,
            tokens: spentTokens,
            cumulative: node.tokensUsed,
            cap: node.maxTokens ?? null,
          },
        });
      }
    }
  }

  /**
   * Run one `foreach` node: close out the item just finished, then hand the
   * next PENDING one to the body.
   *
   * The plan is re-read here on every visit, which is the point of the whole
   * node kind: an item appended mid-run by a review or QA node — or by the user
   * in the UI — is picked up on the next pass instead of being deferred to a
   * follow-up pipeline.
   */
  private async runForeachNode(args: {
    pipeline: Pipeline;
    node: PipelineNodeRow;
    currentItem: PlanItemRow | null;
    lastOutput: string;
    context: AgentContext;
    title: string;
  }): Promise<{
    outcome: NodeOutcome;
    item: PlanItemRow | null;
    stopped?: { pipelineId: string; result: string };
  }> {
    const { pipeline, node, currentItem, lastOutput, context, title } = args;
    const orchestrator = getOrchestratorService();

    if (currentItem) {
      await pipelineRepository.updatePlanItem(currentItem.id, {
        status: 'done',
        result: lastOutput.slice(0, 4000),
        completedAt: new Date(),
      });
      recordRunEvent({
        runId: pipeline.sessionId,
        subject: 'plan_item',
        subjectId: currentItem.id,
        event: 'item_finished',
        payload: { pipelineId: pipeline.id, title: currentItem.title, ordinal: currentItem.ordinal },
      });
    }

    const items = await pipelineRepository.getPlanItems(pipeline.id);
    const pending = items.filter((i) => i.status === 'pending');

    // An empty plan on the FIRST visit is a failure, not an empty success: the
    // template declared per-item work and nothing produced items (a template
    // whose steps declare `loopOverPlan` with no `producesPlan` step ahead of
    // them compiles fine, and would otherwise run zero iterations and report
    // "completed successfully").
    if (items.length === 0 && node.visits === 1) {
      const summary =
        `Pipeline "${title}" reached its plan loop with an empty plan. A step before the loop ` +
        `must declare producesPlan and call \`plan__add_items\`.`;
      await this.updateNode(node.id, { status: 'failed' });
      await this.updatePipeline(pipeline.id, { status: 'failed', summary });
      return {
        outcome: 'loop_done',
        item: null,
        stopped: { pipelineId: pipeline.id, result: summary },
      };
    }

    // First visit and the plan needs sign-off: show the whole list, once.
    if (node.requiresApproval && node.visits === 1) {
      await this.updateNode(node.id, { status: 'awaiting_approval' });
      await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId: pipeline.sessionId,
        data: { event: 'plan_approval_required', pipelineId: pipeline.id, stageId: node.id, items: items.length },
        timestamp: new Date(),
      });

      const list = items.map((i, n) => `${n + 1}. ${i.title}${i.detail ? ` — ${i.detail}` : ''}`).join('\n');
      const approval = await orchestrator.requestApproval(
        `Pipeline "${title}" — plan (${items.length} item${items.length === 1 ? '' : 's'}):\n\n${list}` +
          `\n\nYou can edit, reorder, or remove items on the pipeline page before approving, and ` +
          `the plan stays editable while the pipeline runs.`,
        `Run the plan?`,
        context,
        ['Approve', 'Stop Pipeline'],
      ) as { approved: boolean; response?: string };

      if (!approval.approved || approval.response === 'Stop Pipeline') {
        await this.updateNode(node.id, { status: 'skipped' });
        await this.updatePipeline(pipeline.id, { status: 'paused', summary: 'Plan rejected by user.' });
        return {
          outcome: 'loop_done',
          item: null,
          stopped: { pipelineId: pipeline.id, result: `Pipeline stopped: plan not approved.` },
        };
      }

      await this.updateNode(node.id, { status: 'approved', approvedAt: new Date() });
      await this.updatePipeline(pipeline.id, { status: 'running' });
      // Re-read: the user may have edited the plan while it sat for approval.
      return this.nextPlanItem(pipeline, node);
    }

    if (pending.length === 0) {
      await this.updateNode(node.id, { status: 'completed', completedAt: new Date() });
      return { outcome: 'loop_done', item: null };
    }
    return this.nextPlanItem(pipeline, node);
  }

  /** Claim the next pending plan item, or report the plan finished. */
  private async nextPlanItem(
    pipeline: Pipeline,
    node: PipelineNodeRow,
  ): Promise<{ outcome: NodeOutcome; item: PlanItemRow | null }> {
    const items = await pipelineRepository.getPlanItems(pipeline.id);
    const next = items.find((i) => i.status === 'pending');
    if (!next) {
      await this.updateNode(node.id, { status: 'completed', completedAt: new Date() });
      return { outcome: 'loop_done', item: null };
    }
    const claimed = await pipelineRepository.updatePlanItem(next.id, { status: 'running' });
    recordRunEvent({
      runId: pipeline.sessionId,
      subject: 'plan_item',
      subjectId: next.id,
      event: 'item_started',
      payload: { pipelineId: pipeline.id, title: next.title, ordinal: next.ordinal },
    });

    getOrchestratorService()['emit']({
      type: 'pipeline_event',
      sessionId: pipeline.sessionId,
      data: {
        event: 'plan_item_started',
        pipelineId: pipeline.id,
        itemId: next.id,
        title: next.title,
        remaining: items.filter((i) => i.status === 'pending').length - 1,
      },
      timestamp: new Date(),
    });

    return { outcome: 'loop_next', item: claimed ?? next };
  }

  /**
   * Retries are used up and QA still says no. Ask a human instead of looping,
   * and instead of quietly accepting a failing verdict.
   *
   * Returns a stop result when the user aborts; `null` means "continue anyway",
   * which the walker treats as a pass.
   */
  /**
   * Run a `human` node: stop the walk and ask a person.
   *
   * No worker, no model, no cost. The question is the node's prompt template
   * with the same substitutions a step gets (`{{description}}`,
   * `{{previousOutput}}`, recipe params), and the answer becomes the node's
   * output — so the next node reads it exactly as it would read an agent's.
   *
   * Restart behaviour falls out of checkpointing: the snapshot is written
   * BEFORE the node runs, so a pause or a crash while the question is
   * outstanding resumes by asking again. An in-memory approval promise cannot
   * survive a restart, and re-asking is the honest recovery — the person may
   * never have seen the first one.
   */
  private async runHumanNode(args: {
    pipeline: Pipeline;
    node: PipelineNodeRow;
    stageTemplate: StageTemplate;
    description: string;
    paramVars: Record<string, string>;
    previousOutput: string;
    /** A QA verdict that sent the walk back here. */
    feedback?: QAValidationResult;
    context: AgentContext;
    title: string;
  }): Promise<{ output: string; raw: string; stopped?: { pipelineId: string; result: string } }> {
    const { pipeline, node, stageTemplate, description, paramVars, previousOutput, feedback, context, title } = args;
    const orchestrator = getOrchestratorService();

    let question = expandPromptTemplate(stageTemplate.promptTemplate, {
      description,
      previousOutput,
      ...paramVars,
    });
    if (feedback) {
      question = `QA rejected the previous attempt:\n${feedback.feedback}\n` +
        `${feedback.issues.map((i) => `- ${i}`).join('\n')}\n\n${question}`;
    }
    const fields = stageTemplate.humanFields ?? [];
    const fieldText = fields.length
      ? `\n\nAnswer with one line per field:\n${fields
          .map((f) => `- ${f.label}${f.options?.length ? ` (${f.options.join(' / ')})` : ''}`)
          .join('\n')}`
      : '';

    await this.updateNode(node.id, { input: question, status: 'awaiting_approval' });
    await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId: pipeline.sessionId,
      // `fields` rides along so a client can draw a form. The answer comes back
      // as text either way — see `humanFields`, which is advisory by design.
      data: {
        event: 'human_input_required',
        pipelineId: pipeline.id,
        stageId: node.id,
        name: node.name,
        question,
        fields,
      },
      timestamp: new Date(),
    });

    const answer = await orchestrator.requestApproval(
      `Pipeline "${title}" — ${node.name}${fieldText}`,
      question,
      context,
      // Buttons only when a single choice IS the answer; anything richer is
      // free text, which the approval channel already carries.
      fields.length === 1 && fields[0].options?.length ? fields[0].options : undefined,
    ) as { approved: boolean; response?: string };

    if (!answer.approved) {
      await this.updateNode(node.id, { status: 'skipped' });
      await this.updatePipeline(pipeline.id, {
        status: 'paused',
        summary: `Waiting on "${node.name}" — the question was not answered.`,
      });
      recordRunEvent({
        runId: pipeline.sessionId,
        subject: 'pipeline_node',
        subjectId: node.nodeKey,
        event: 'node_failed',
        payload: { pipelineId: pipeline.id, name: node.name, reason: 'unanswered' },
      });
      return {
        output: '',
        raw: '',
        stopped: {
          pipelineId: pipeline.id,
          result: `Pipeline paused at "${node.name}": no answer. Resume to ask again.`,
        },
      };
    }

    const output = (answer.response ?? '').trim();
    await this.updateNode(node.id, {
      status: 'completed',
      output,
      completedAt: new Date(),
      approvedAt: new Date(),
    });
    await this.updatePipeline(pipeline.id, { status: 'running' });
    recordRunEvent({
      runId: pipeline.sessionId,
      subject: 'pipeline_node',
      subjectId: node.nodeKey,
      event: 'node_completed',
      payload: { pipelineId: pipeline.id, name: node.name, visit: node.visits, human: true },
    });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId: pipeline.sessionId,
      data: { event: 'stage_completed', pipelineId: pipeline.id, stageId: node.id, name: node.name },
      timestamp: new Date(),
    });

    // A human answer carries no handoff fence, so raw and stripped are the same.
    return { output, raw: output };
  }

  /**
   * Ask the user before a step that declared `requiresApproval` runs.
   * Approve / Skip / Stop, over the last handoff so the decision is made on
   * what the previous step actually produced.
   */
  private async approveStepNode(args: {
    pipeline: Pipeline;
    node: PipelineNodeRow;
    handoffChain: HandoffContext[];
    previousOutput: string;
    context: AgentContext;
    title: string;
  }): Promise<'go' | 'skip' | 'stop'> {
    const { pipeline, node, handoffChain, previousOutput, context, title } = args;
    const orchestrator = getOrchestratorService();

    await this.updateNode(node.id, { status: 'awaiting_approval' });
    await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId: pipeline.sessionId,
      data: { event: 'approval_required', pipelineId: pipeline.id, stageId: node.id, name: node.name },
      timestamp: new Date(),
    });

    const latest = handoffChain[handoffChain.length - 1];
    const summary = latest
      ? `Previous stage completed.\n\n**Work done:** ${latest.completedWork.slice(0, 1500)}` +
        (latest.decisions.length > 0 ? `\n\n**Decisions:** ${latest.decisions.join('; ')}` : '')
      : `Previous stage completed.\n\nResult:\n${previousOutput.slice(0, 2000)}`;

    const approval = await orchestrator.requestApproval(
      `Pipeline "${title}" — ${summary}`,
      `Proceed with next stage: "${node.name}"?`,
      context,
      ['Approve', 'Skip', 'Stop Pipeline'],
    ) as { approved: boolean; response?: string };

    if (!approval.approved || approval.response === 'Stop Pipeline') {
      await this.updateNode(node.id, { status: 'skipped' });
      await this.updatePipeline(pipeline.id, { status: 'paused', summary: `Stopped by user at stage: ${node.name}` });
      return 'stop';
    }
    if (approval.response === 'Skip') return 'skip';

    await this.updateNode(node.id, { status: 'approved', approvedAt: new Date() });
    await this.updatePipeline(pipeline.id, { status: 'running' });
    return 'go';
  }

  private async escalateQaFailure(args: {
    pipeline: Pipeline;
    node: PipelineNodeRow;
    qaResult: QAValidationResult;
    attempts: number;
    context: AgentContext;
  }): Promise<{ pipelineId: string; result: string } | null> {
    const { pipeline, node, qaResult, attempts, context } = args;
    const orchestrator = getOrchestratorService();

    coreLogger.warn({ pipelineId: pipeline.id, attempts }, 'QA validation exhausted retries, requesting human approval');

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId: pipeline.sessionId,
      data: { event: 'qa_escalation', pipelineId: pipeline.id, qaStageId: node.id, attempts, issues: qaResult.issues },
      timestamp: new Date(),
    });

    await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

    const escalation = await orchestrator.requestApproval(
      `QA validation failed after ${attempts} attempts.\n\nRemaining issues:\n${qaResult.issues.join('\n')}\n\nFeedback: ${qaResult.feedback}`,
      `Continue pipeline despite QA failures, or abort?`,
      context,
      ['Continue Anyway', 'Abort Pipeline'],
    ) as { approved: boolean; response?: string };

    if (!escalation.approved || escalation.response === 'Abort Pipeline') {
      await this.updatePipeline(pipeline.id, {
        status: 'failed',
        summary: `QA failed after ${attempts} attempts. Aborted by user.\n\nIssues:\n${qaResult.issues.join('\n')}`,
      });
      return {
        pipelineId: pipeline.id,
        result: `Pipeline aborted: QA failed after ${attempts} attempts.\n\nUnresolved issues:\n${qaResult.issues.join('\n')}`,
      };
    }

    await this.updatePipeline(pipeline.id, { status: 'running' });
    coreLogger.info({ pipelineId: pipeline.id }, 'User approved continuing despite QA failures');
    return null;
  }

  private async updatePipeline(id: string, data: Partial<NewPipeline>) {
    await this.db
      .update(pipelines)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(pipelines.id, id));
  }

  private async updateNode(id: string, data: Partial<NewPipelineNode>) {
    await this.db
      .update(pipelineNodes)
      .set(data)
      .where(eq(pipelineNodes.id, id));
  }
}

// Singleton
let instance: PipelineManager | null = null;

export function getPipelineManager(): PipelineManager {
  if (!instance) {
    instance = new PipelineManager();
  }
  return instance;
}
