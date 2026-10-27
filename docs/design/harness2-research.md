# Harness²: possible use in Octipus

Research note, 2026-10-26. This is a proposal, not an implemented feature.

## What it is

Google Research's Harness² improves the setup around a fixed model: prompts,
skills, memory, tool guidance, scripts, delegation, and runtime plugins.
It does not train model weights. The code is Apache-2.0 and is not an officially
supported Google product.

Task-level refinement runs a baseline, proposes a general procedural candidate
and a domain-specific candidate, probes both on the same task, then composes
an improved harness from the observed execution differences. A second loop
retains adopted harnesses and evidence-supported lessons to guide future edits.
New tasks start from the common base; earlier changes are selectively reused.
Behavioral comparisons do not establish correctness.

The authors report gains up to 11.5 points on WorkBuddy-Bench, 4.5 on JobBench,
and 11.8 percentage points on LAB partial pass rate. These are research results,
not predictions for Octipus.

## Recommended application

Start with offline role and skill improvement, using existing Octipus pieces:

- Editable role prompts, skills, and tool guidance define candidate configurations.
- Execution events and verification records supply evidence.
- Session learning and skill proposals retain lessons and support review.
- Integration evaluations and the sibling harness-arena measure outcomes.

The missing addition is controlled testing of proposed improvements. Existing
session learning extracts lessons from recorded work; it does not establish
that rerunning with a proposed change improves results.

1. Select 20–30 representative coding, research, document, and tool tasks;
   reserve held-out tasks to check transfer.
2. Snapshot a role's prompt, skill selection, and tool guidance.
3. Run baseline, two candidates, and composition with the same model and starting
   state in isolated environments. Let the baseline win.
4. Compare actual artifacts, independent verification, cost, latency, and
   unnecessary tool calls. Repeat promising comparisons to reduce sampling noise.
5. Submit successful changes through the existing proposal/review flow. Store
   applicability conditions, configuration versions, and supporting evidence.

Example: investigate a coding role that claims completion without running
checks. Compare a general verification procedure with a project testing skill;
measure actual command execution and independently tested output, then validate
on held-out tasks.

Keep permissions, approval enforcement, and spend limits outside the optimizer's
editable surface. Prefer skills and concise guidance over growing global prompts.
Do not replay live email/calendar/external writes: use mocks or disposable state.

One refinement step involves roughly four task executions plus editing and
reflection calls. Begin with one coding role and harness-arena before considering
expensive live refinement. Upstream currently supports OpenCode and Codex;
Octipus requires an executor adapter or a native implementation of the loop.

## Sources and local starting points

- https://github.com/google-research/harness2
- https://arxiv.org/html/2610.14224v1
- https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md
- ../SESSION-LEARNING.md
- ../../src/core/learning/
- ../../src/eval/runner.ts
- ../../../harness-arena/README.md
