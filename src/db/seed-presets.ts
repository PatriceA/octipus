import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import { logger } from '@/utils/logger';

/**
 * Preset pipeline templates that ship out-of-the-box.
 * These are inserted with isPreset=true and no userId (available to all users).
 */
const PRESET_TEMPLATES: Array<{
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
        toolIds: ['filesystem'],
        requiresApproval: true,
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

Present this clearly so the user can review and approve before coding begins.`,
      },
      {
        name: 'Implementation',
        description: 'Write the code following the approved architecture plan.',
        topic: 'coding',
        toolIds: ['filesystem', 'shell', 'git'],
        requiresApproval: false,
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
        toolIds: ['filesystem', 'shell', 'browser'],
        requiresApproval: false,
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
        requiresApproval: false,
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
        requiresApproval: false,
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
      // Do not overwrite — users can edit preset templates and we must not
      // clobber their changes on restart.
      continue;
    }

    await db.insert(pipelineTemplates).values({
      name: preset.name,
      description: preset.description,
      isPreset: true,
      userId: null as any, // Presets have no owner — available to all users
      steps: preset.steps,
    });

    logger.info({ template: preset.name }, 'Seeded preset pipeline template');
  }
}
