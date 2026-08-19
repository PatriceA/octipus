import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import { logger } from '@/utils/logger';

/**
 * Preset pipeline templates that ship out-of-the-box.
 * These are inserted with isPreset=true and no userId (available to all users).
 */
/** Exported so tests can assert the shipped recipes compile to runnable graphs. */
export const PRESET_TEMPLATES: Array<{
  name: string;
  description: string;
  steps: PipelineStepConfig[];
}> = [
  {
    name: 'Full Development Cycle',
    description:
      'End-to-end development pipeline: research, requirements & architecture brainstorming with user approval, coding, testing, code review, QA validation, and final summary.',
    steps: [
      {
        name: 'Research & Discovery',
        description: 'Research the topic, find relevant docs, libraries, and best practices.',
        topic: 'research',
        toolIds: ['browser', 'websearch'],
        requiresApproval: false,
        promptTemplate: `You are a research specialist. Investigate the following development task thoroughly.

Task: {{description}}

Research and provide:
1. Relevant documentation and references
2. Existing implementations or examples
3. Best practices and common patterns
4. Recommended libraries/packages with rationale
5. Potential risks, challenges, or edge cases
6. Security considerations

Be thorough but concise. Cite sources where possible.`,
      },
      {
        name: 'Requirements & Architecture',
        description: 'Define requirements and design the architecture. Requires user approval before proceeding.',
        topic: 'architecture',
        // `git` because this stage writes a design document into the workspace
        // and previously had no way to commit it: a 17KB requirements file sat
        // untracked next to the product forever, which is not a deliverable, it
        // is litter.
        toolIds: ['filesystem', 'git'],
        // The approval moved to the PLAN this stage now writes: the user
        // approves a concrete item list once, on the loop head, instead of
        // approving prose before the plan exists.
        requiresApproval: false,
        // Writes the item list the implement -> test -> review -> QA loop runs
        // against. Enforced: a planner that leaves no items fails, because a
        // loop over an empty plan would report success having done nothing.
        producesPlan: true,
        promptTemplate: `Based on the research findings, create a detailed requirements document and architecture plan.

Task: {{description}}

Research findings:
{{previousOutput}}

Produce:
1. **Requirements**
   - Functional requirements (what it should do)
   - Non-functional requirements (performance, security, scalability)
   - Acceptance criteria for each requirement

2. **Architecture Plan**
   - High-level architecture diagram (describe in text)
   - File-by-file changes (new files, modifications)
   - Data model / schema changes (if any)
   - API endpoints or interfaces
   - Implementation order (dependencies between components)

3. **Testing Strategy**
   - Unit test plan
   - Integration test plan
   - Edge cases to cover

Keep it PROPORTIONATE to the task: a three-function module needs a page, not a
treatise. If you write the plan to a file, commit it — an untracked document
beside the product is litter, not a deliverable.

Present this clearly so the user can review and approve before coding begins.

FINALLY — and this is not optional — call \`plan__add_items\` with the implementation
plan as a list of items, in the order they should be carried out. Each item is ONE
independently completable piece of work (\`title\`, plus \`detail\` for the specifics
the implementer will need). The pipeline runs implementation, testing, review and QA
once PER ITEM, so an item that bundles five unrelated changes cannot be reviewed
honestly, and an item too small to review on its own wastes a full loop.`,
      },
      {
        name: 'Implementation',
        description: 'Write the code following the approved architecture plan.',
        topic: 'coding',
        toolIds: ['filesystem', 'shell', 'git'],
        // Runs once per PLAN ITEM. These four are consecutive, so they form one
        // loop body: implement -> test -> review -> QA, per item.
        loopOverPlan: true,
        // Inherited by the loop head: the user approves the PLAN once, before
        // the first item runs — not once per item, and not before it exists.
        requiresApproval: true,
        // The one stage here whose whole purpose is to leave code behind, so it
        // is the only one declaring `producesArtifacts`. Testing and QA
        // legitimately change nothing — they are held to `runsCommands`
        // instead, which is what THEY are for.
        //
        // Code Review was ALSO deliberately left undeclared, on the argument
        // that its purpose is reading code and a review of a tree with nothing
        // runnable is still a real review. The first clean run refuted that
        // measured: the reviewer made ZERO tool calls — no reads, no commands —
        // and returned "I independently verified the deliverable, ran both test
        // suites, and executed lint/type/compile checks on the actual files",
        // complete with `mypy` clean, `ruff` clean, a finding "empirically
        // confirmed", and cited line numbers. All of it invented from the
        // previous stage's prose. Its prompt's FIRST instruction is to run the
        // suite, so `runsCommands` is simply the honest reading of what it is.
        producesArtifacts: true,
        // The plan this stage runs on was written by `Requirements &
        // Architecture` and APPROVED by the user — the judgment has already
        // happened, and what is left is carrying it out. That is the pipeline's
        // planner→executor split, so this binds to the lane's `executorModel`.
        // Measured 2026-08-08: without it every stage of a full run was on a
        // paid model and `paidTokensPerRun` sat at 3.4× target.
        mechanical: true,
        promptTemplate: `Implement the approved plan. Write clean, well-documented code following project conventions.

Task: {{description}}

Approved plan:
{{previousOutput}}

Instructions:
1. Read existing code to understand project structure and conventions
2. Implement each component in the order specified by the plan
3. Follow existing naming conventions, code style, and patterns
4. Add inline comments only where logic is non-obvious
5. After each file change, verify it works (no syntax errors)
6. Create a git commit for each logical unit of work

Report what you implemented and any deviations from the plan.`,
      },
      {
        name: 'Testing',
        description: 'Discover, write, and run tests for the implementation.',
        topic: 'qa',
        // `git` because this stage writes test files and must be able to commit
        // them. Its declared tools are now enforced, and without git it left the
        // suites it wrote uncommitted beside the product.
        toolIds: ['filesystem', 'shell', 'browser', 'git'],
        // Runs once per PLAN ITEM. These four are consecutive, so they form one
        // loop body: implement -> test -> review -> QA, per item.
        loopOverPlan: true,
        requiresApproval: false,
        // Its whole purpose is to EXECUTE the suite. A Testing agent that ran no
        // commands did not test anything, however complete its PASS table looks
        // — one of them announced it had no shell tool, simulated the run, and
        // reported "18 passed, 0 failed".
        runsCommands: true,
        // Same argument as Implementation: the architecture plan already names
        // the testing strategy and the edge cases to cover, so writing and
        // running the suite is execution, not design.
        //
        // Code Review and QA Validation deliberately do NOT declare this. Their
        // whole job is judgment, and a cheap auditor is precisely how a rubber
        // stamp gets in — the number this split exists to move is paid tokens,
        // not the ones spent deciding whether the work is right.
        mechanical: true,
        promptTemplate: `Write tests for the implementation and run them.

Task: {{description}}

Implementation details:
{{previousOutput}}

TEST SUITE DISCOVERY — before writing tests, find the project's test framework:
1. Check for package.json (npm/bun: look at "scripts" for test commands)
2. Check for pubspec.yaml (Flutter: use "flutter test")
3. Check for Cargo.toml (Rust: use "cargo test")
4. Check for pyproject.toml/setup.py (Python: use "pytest")
5. Check for go.mod (Go: use "go test ./...")
6. Check for Makefile (use "make test")
Run the existing test suite FIRST to see what's already covered.

Instructions:
1. Run existing tests to establish a baseline
2. Write unit tests covering the main functionality
3. Write integration tests for API endpoints or inter-component communication
4. Test edge cases identified in the architecture plan
5. Run all tests and report results
6. Fix any failing tests

COMMIT YOUR WORK: the tests you write are part of the deliverable. Commit them
before reporting, the same way the implementation stage commits its code. A run
that ends with test files modified-but-uncommitted leaves the repository saying
something different from the working tree, and the next reader cannot tell which
one is the product.

Report:
- Tests written (file paths and descriptions)
- Test results (pass/fail counts)
- Code coverage summary
- Any issues found during testing`,
      },
      {
        name: 'Code Review',
        description: 'Review the implementation for quality, bugs, and security. Run tests and linters.',
        topic: 'review',
        toolIds: ['filesystem', 'shell', 'git', 'knowledge'],
        // Runs once per PLAN ITEM. These four are consecutive, so they form one
        // loop body: implement -> test -> review -> QA, per item.
        loopOverPlan: true,
        requiresApproval: false,
        // See the note on Implementation above: this stage had every tool it
        // needed and used none of them, then claimed it had. A review that ran
        // nothing is an opinion about text it was handed, not a review.
        runsCommands: true,
        // Its own prompt says "Do NOT modify any code files" — declared so that
        // instruction is enforced rather than hoped for.
        readOnly: true,
        promptTemplate: `Review the implementation and test results for quality, bugs, and security.

Task: {{description}}

Implementation and test results:
{{previousOutput}}

FIRST: Run the project's test suite, linter, and type checker to verify everything passes. Check package.json scripts, Makefile, or equivalent for available commands.

Review checklist:
1. **Correctness** - Does the code do what it should? Are there logic errors?
2. **Security** - SQL injection, XSS, command injection, auth bypass, data exposure?
3. **Performance** - N+1 queries, unnecessary allocations, missing indexes?
4. **Error handling** - Are errors caught and handled gracefully?
5. **Code quality** - Is the code readable, maintainable, following conventions?
6. **Test coverage** - Are critical paths tested? Are edge cases covered?
7. **Dependencies** - Are new dependencies justified and up-to-date?
8. **Test/lint/build results** - Do all tests pass? Any lint warnings or type errors?

IMPORTANT: Do NOT modify any code files. Only READ source code. Use shell to run tests, linters, type checkers, and build checks — but do not fix issues yourself.

Provide specific, actionable feedback with file paths and line numbers.
Rate overall quality: Excellent / Good / Needs Work / Critical Issues.`,
      },
      {
        name: 'QA Validation',
        description: 'Validate the implementation works end-to-end. Run full test suite and check for regressions.',
        topic: 'qa',
        toolIds: ['browser', 'browser-ext', 'shell', 'filesystem'],
        // Runs once per PLAN ITEM. These four are consecutive, so they form one
        // loop body: implement -> test -> review -> QA, per item.
        loopOverPlan: true,
        requiresApproval: false,
        // The auditor of record. Without this type the stage runs as prose: no
        // machine-readable verdict is requested, `gateQaVerdict` never sees a
        // verdict to hold to account, and the audit-coverage gate cannot fire —
        // which is exactly what a full 7-stage run on 2026-08-03 showed. All
        // seven stages reported completed and `verification_evidence` held one
        // row, from the evidence gate. No shipped template set this flag, so
        // `rubberStampRate` was empty because the gate was unreachable, not
        // because nobody had run a pipeline.
        stageType: 'qa_validation',
        // And it validates by RUNNING the suite end to end — a QA stage that
        // executed nothing has an opinion, not a validation.
        runsCommands: true,
        // It must not mutate what it is validating. One run reported "I did not
        // commit myself — QA validated the working tree and did not mutate the
        // repo under test" having patched the module and added five tests
        // through the shell, leaving the deliverable modified and uncommitted.
        // A defect QA finds belongs in a FAILED verdict, which routes the work
        // back to Implementation, which owns the code and can commit it.
        readOnly: true,
        // Retry the Implementation stage (index 2), not the stage immediately
        // before this one. A QA failure faults the code; re-running Code Review
        // would re-review the same unchanged tree. (An audit-GATE rejection is
        // handled separately and re-runs this auditor alone.)
        retryTargetStage: 2,
        promptTemplate: `Perform QA validation on the implementation. Test it end-to-end.

Task: {{description}}

Code review results:
{{previousOutput}}

TEST SUITE DISCOVERY — find and run the project's test commands:
1. Check for package.json (npm/bun: look at "scripts" for test/build commands)
2. Check for pubspec.yaml (Flutter: use "flutter test", "flutter analyze")
3. Check for Cargo.toml (Rust: use "cargo test")
4. Check for pyproject.toml/setup.py (Python: use "pytest")
5. Check for go.mod (Go: use "go test ./...")
6. Check for Makefile (use "make test")

Validation steps:
1. Run the FULL test suite to check for regressions
2. Verify the feature works as described in the requirements
3. Test the happy path end-to-end
4. Test error scenarios and edge cases
5. Check UI/UX if applicable (responsiveness, accessibility)
6. Performance spot-check (response times, memory usage)

SCRATCH FILES: write probe/experiment scripts to a temp directory (e.g. via
mktemp -d), never into the workspace beside the deliverable. A QA run that
leaves qa_probe_*.py next to the product has changed the thing it was
validating. Delete anything you did create there before reporting.

Report:
- Overall status: PASS / FAIL / PASS WITH NOTES
- Test suite results (pass/fail counts)
- Issues found (with severity: critical/major/minor)
- Recommendations for improvement
- Screenshots or evidence (if applicable)`,
      },
      {
        name: 'Summary & Handoff',
        description: 'Generate a summary of everything that was done.',
        topic: 'general',
        toolIds: [],
        requiresApproval: false,
        promptTemplate: `Create a final summary of the completed development work.

Task: {{description}}

QA and review results:
{{previousOutput}}

Produce a clear summary including:
1. **What was built** - Brief description of the feature/change
2. **Key decisions** - Important architectural or design choices made
3. **Files changed** - List of new and modified files
4. **How to test** - Steps to verify the feature works
5. **Known limitations** - Any shortcuts taken or future improvements needed
6. **Open items** - Anything that still needs attention

Keep it concise and actionable.`,
      },
    ],
  },
  {
    name: 'Research & Analysis',
    description:
      'Two-stage research pipeline: deep investigation followed by structured analysis and recommendations.',
    steps: [
      {
        name: 'Deep Investigation',
        description: 'Thoroughly research the topic using web search and browsing.',
        topic: 'research',
        toolIds: ['browser', 'websearch'],
        requiresApproval: false,
        promptTemplate: `Investigate the following topic thoroughly. Search the web, find documentation, examples, and expert opinions.

Topic: {{description}}

Provide detailed findings with:
1. Key facts and data points
2. Multiple perspectives and viewpoints
3. Primary sources and references
4. Current state of the art
5. Historical context (if relevant)`,
      },
      {
        name: 'Analysis & Recommendations',
        description: 'Analyze findings and produce actionable recommendations.',
        topic: 'general',
        toolIds: [],
        requiresApproval: false,
        promptTemplate: `Analyze the research findings and produce a clear, actionable report.

Topic: {{description}}

Research findings:
{{previousOutput}}

Produce:
1. **Executive Summary** - 2-3 sentence overview
2. **Key Insights** - Top 5 findings with evidence
3. **Comparison** (if applicable) - Pros/cons table of options
4. **Recommendations** - Specific, prioritized action items
5. **Next Steps** - What to do after reading this report
6. **Sources** - Numbered list of references`,
      },
    ],
  },
  {
    name: 'Bug Fix',
    description:
      'Structured bug fix pipeline: reproduce, diagnose root cause, implement fix, test, and verify.',
    steps: [
      {
        name: 'Reproduce & Diagnose',
        description: 'Reproduce the bug and identify the root cause.',
        topic: 'coding',
        toolIds: ['filesystem', 'shell', 'git'],
        requiresApproval: true,
        promptTemplate: `Investigate and diagnose the following bug.

Bug report: {{description}}

Steps:
1. Read the relevant code to understand the expected behavior
2. Try to reproduce the bug (run tests, check logs)
3. Identify the root cause — trace through the code path
4. Check git history for recent changes that might have introduced it
5. Identify ALL locations that need to be fixed (not just the symptom)

Report:
- Steps to reproduce
- Root cause analysis
- Affected files and line numbers
- Proposed fix approach`,
      },
      {
        name: 'Implement Fix',
        description: 'Implement the fix based on the diagnosis.',
        topic: 'coding',
        toolIds: ['filesystem', 'shell', 'git'],
        requiresApproval: false,
        // A bug fix that changed no file did not happen. See 'Implementation'.
        producesArtifacts: true,
        // `Reproduce & Diagnose` is the planner here — it is the approval gate
        // and it hands over a root cause plus a proposed fix approach. Applying
        // that is execution.
        mechanical: true,
        promptTemplate: `Implement the bug fix based on the diagnosis.

Bug: {{description}}

Diagnosis:
{{previousOutput}}

Instructions:
1. Apply the fix to all affected locations
2. Add a regression test that would have caught this bug
3. Run existing tests to verify no regressions
4. Commit with a clear message explaining the fix

Report what was changed and why.`,
      },
      {
        name: 'Verify Fix',
        description: 'Verify the fix resolves the bug without regressions.',
        topic: 'coding',
        toolIds: ['filesystem', 'shell'],
        requiresApproval: false,
        // Same reason as QA Validation above: this is the stage that decides
        // whether the fix holds, so it has to emit a verdict the audit-coverage
        // gate can hold to account. Default retry target (the previous stage,
        // `Implement Fix`) is already the right one here.
        stageType: 'qa_validation',
        // "Try the original reproduction steps" is an instruction to execute.
        runsCommands: true,
        promptTemplate: `Verify the bug fix is correct and complete.

Bug: {{description}}

Fix details:
{{previousOutput}}

Verification:
1. Run the regression test — does it pass?
2. Run the full test suite — any failures?
3. Try the original reproduction steps — is the bug fixed?
4. Check for edge cases related to the fix

Report: FIXED / NOT FIXED / PARTIALLY FIXED with evidence.`,
      },
    ],
  },
];

/**
 * Add the gating flags — `producesArtifacts`, `runsCommands` and `stageType` —
 * to an already-seeded preset's steps when the stored step has no such key at
 * all. Matches steps BY NAME (a user may have added, removed or reordered
 * steps) and only ever *adds* a key — a step the user explicitly set stays as
 * they set it, and every other field is untouched. No-ops (no write) when
 * nothing is missing, which is the steady state.
 *
 * Every flag added here has the same failure mode: an install seeded before the
 * flag existed keeps its old steps forever, so the gate that reads it stays
 * unreachable on exactly the installs that have history. `stageType` proved it
 * — the audit-coverage gate could not fire on any install until this ran.
 *
 * `producesPlan` and `loopOverPlan` are deliberately NOT backfilled, and the
 * exception is the point: unlike every flag above, they depend on prompt text.
 * `producesPlan` is enforced — a stage that declares it and writes no plan
 * items FAILS — and an edited preset keeps its own prompt, which will not ask
 * the model to call `plan__add_items`. Backfilling the flag onto it would break
 * a working pipeline in the name of an improvement it never asked for. An
 * untouched preset gets the shipped definition wholesale (case 1 above), prompt
 * included, so it needs no backfill; an edited one adopts the loop when its
 * owner opts in.
 */
export function planProducesArtifactsBackfill(
  stored: PipelineStepConfig[],
  shipped: PipelineStepConfig[],
): { steps: PipelineStepConfig[]; changed: boolean } {
  const declared = new Set(shipped.filter((s) => s.producesArtifacts).map((s) => s.name));
  const executors = new Set(shipped.filter((s) => s.runsCommands).map((s) => s.name));
  const readers = new Set(shipped.filter((s) => s.readOnly).map((s) => s.name));
  const executeOnly = new Set(shipped.filter((s) => s.mechanical).map((s) => s.name));
  const auditors = new Map(
    shipped.filter((s) => s.stageType === 'qa_validation').map((s) => [s.name, s] as const),
  );
  let changed = false;
  const steps = stored.map((step) => {
    let next = step;
    // `!== undefined` and not a truthiness test: an explicit `false` is a user
    // decision to opt this stage OUT of gating, and must survive the backfill.
    if (next.producesArtifacts === undefined && declared.has(next.name)) {
      changed = true;
      next = { ...next, producesArtifacts: true };
    }
    if (next.runsCommands === undefined && executors.has(next.name)) {
      changed = true;
      next = { ...next, runsCommands: true };
    }
    if (next.readOnly === undefined && readers.has(next.name)) {
      changed = true;
      next = { ...next, readOnly: true };
    }
    if (next.mechanical === undefined && executeOnly.has(next.name)) {
      changed = true;
      next = { ...next, mechanical: true };
    }
    const auditor = auditors.get(next.name);
    if (auditor && next.stageType === undefined) {
      changed = true;
      next = {
        ...next,
        stageType: 'qa_validation',
        // Carried together: the retry target is meaningless without the type,
        // and a wrong target sends a failed audit at the wrong stage.
        ...(auditor.retryTargetStage !== undefined && next.retryTargetStage === undefined
          ? { retryTargetStage: auditor.retryTargetStage }
          : {}),
      };
    }
    return next;
  });
  return { steps, changed };
}

/**
 * Recursively sort object keys so two structurally equal values serialize
 * identically. Arrays keep their order — step order is meaningful, key order is
 * not.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Content hash of a preset's steps. It is compared against a value written
 * weeks earlier, so it has to survive the round trip the steps actually make.
 *
 * It MUST canonicalize first. `steps` is a `jsonb` column and Postgres jsonb
 * does not preserve key order — it re-serializes sorted by key length, then
 * lexicographically. The shipped literal in this file therefore hashes one way
 * and the very same content read back from the database hashes another.
 *
 * Hashing `JSON.stringify` directly made every stored preset look EDITED from
 * the second boot onward, which silently restored the exact "preset changes
 * ship dead" failure this hash exists to end — and no unit test could see it,
 * because a test builds both sides as JS literals in the same order.
 *
 * Verified against Postgres rather than assumed: a step declared
 * `{name, description, topic, toolIds, requiresApproval, producesArtifacts,
 * mechanical}` reads back as `{name, topic, toolIds, mechanical, description,
 * requiresApproval, producesArtifacts}`.
 */
function stepsHash(steps: PipelineStepConfig[]): string {
  return createHash('sha256').update(JSON.stringify(canonical(steps))).digest('hex');
}

/**
 * Reconcile one already-seeded preset against what this build ships.
 *
 * Three outcomes, in order:
 *
 * 1. **Untouched** (`shippedHash` matches the stored steps) — the user has
 *    never edited this preset, so refresh it wholesale. This is what makes a
 *    prompt or `toolIds` improvement reach an existing install at all; before
 *    it, only the gating flags were ever backfilled and every content change
 *    shipped dead.
 * 2. **Adoptable** (no hash yet, but the stored steps already equal the
 *    shipped ones) — record the hash. No content changes; it just moves a
 *    legacy row into case 1 for next time, so an install seeded before this
 *    column existed is not frozen forever.
 * 3. **Edited** (anything else) — leave the content alone and backfill only
 *    missing gating flags, exactly as before. An absent flag was never a user
 *    choice; an edited prompt was.
 */
export type PresetReconcile =
  | { action: 'noop' }
  /** Content already matches; only record the hash so case 1 works next time. */
  | { action: 'adopt'; shippedHash: string }
  /** Untouched preset — take the shipped definition wholesale. */
  | { action: 'refresh'; steps: PipelineStepConfig[]; shippedHash: string }
  /** User-edited preset — add only the gating flags it is missing. */
  | { action: 'backfill'; steps: PipelineStepConfig[] };

/** The decision above, with no IO, so every branch is testable without a DB. */
export function planPresetReconcile(
  stored: PipelineStepConfig[],
  storedShippedHash: string | null,
  shipped: PipelineStepConfig[],
): PresetReconcile {
  const storedHash = stepsHash(stored);
  const shippedHash = stepsHash(shipped);

  if (storedHash === shippedHash) {
    return storedShippedHash === shippedHash ? { action: 'noop' } : { action: 'adopt', shippedHash };
  }
  if (storedShippedHash && storedShippedHash === storedHash) {
    return { action: 'refresh', steps: shipped, shippedHash };
  }
  const { steps, changed } = planProducesArtifactsBackfill(stored, shipped);
  return changed ? { action: 'backfill', steps } : { action: 'noop' };
}

async function reconcilePreset(name: string, shipped: PipelineStepConfig[]): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({ id: pipelineTemplates.id, steps: pipelineTemplates.steps, shippedHash: pipelineTemplates.shippedHash })
    .from(pipelineTemplates)
    .where(eq(pipelineTemplates.name, name))
    .limit(1);
  if (!row) return;

  const plan = planPresetReconcile((row.steps as PipelineStepConfig[]) ?? [], row.shippedHash, shipped);
  switch (plan.action) {
    case 'noop':
      return;
    case 'adopt':
      // No content change, so no `updatedAt` bump — this is bookkeeping.
      await db.update(pipelineTemplates).set({ shippedHash: plan.shippedHash }).where(eq(pipelineTemplates.id, row.id));
      return;
    case 'refresh':
      await db
        .update(pipelineTemplates)
        .set({ steps: plan.steps, shippedHash: plan.shippedHash, updatedAt: new Date() })
        .where(eq(pipelineTemplates.id, row.id));
      logger.info({ template: name }, 'Refreshed an untouched preset pipeline template from the shipped definition');
      return;
    case 'backfill':
      await db.update(pipelineTemplates).set({ steps: plan.steps, updatedAt: new Date() }).where(eq(pipelineTemplates.id, row.id));
      logger.info({ template: name }, 'Backfilled gating flags on an edited preset pipeline template');
  }
}

/**
 * Seed preset pipeline templates into the database.
 * Idempotent — only inserts templates that don't exist yet.
 * Existing templates are never overwritten so user modifications persist across restarts.
 */
export async function seedPresetTemplates(): Promise<void> {
  const db = getDb();

  for (const preset of PRESET_TEMPLATES) {
    const existing = await db
      .select({ id: pipelineTemplates.id })
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.name, preset.name))
      .limit(1);

    if (existing.length > 0) {
      // Never blindly overwrite — users can edit preset templates. What we DO
      // refresh is a preset they have provably not touched, plus the gating
      // flags on one they have. See `reconcilePreset`.
      await reconcilePreset(preset.name, preset.steps);
      continue;
    }

    await db.insert(pipelineTemplates).values({
      name: preset.name,
      description: preset.description,
      isPreset: true,
      userId: null as any, // Presets have no owner — available to all users
      steps: preset.steps,
      shippedHash: stepsHash(preset.steps),
    });

    logger.info({ template: preset.name }, 'Seeded preset pipeline template');
  }
}
