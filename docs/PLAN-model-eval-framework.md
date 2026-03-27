# Plan: Model Evaluation & Provider Testing Framework

**Inspired by Genkit's patterns, adapted to our Bun + TypeScript + Elysia architecture.**

---

## Phase 1: Model Capability Metadata Enhancement

**Goal:** Enrich our model config with structured capability flags (like Genkit's `supports` object) so tests can skip unsupported features automatically.

### What to implement

**File: `src/db/schema/models.ts`**
- Add `ModelCapabilities` interface to `ModelMetadata`:
```typescript
interface ModelCapabilities {
  multiturn?: boolean;     // multi-turn conversation
  media?: boolean;         // vision/image input
  tools?: boolean;         // function/tool calling
  streaming?: boolean;     // streaming responses
  systemRole?: boolean;    // system messages
  embeddings?: boolean;    // text embeddings
  structuredOutput?: boolean; // JSON mode / structured output
  constrained?: 'none' | 'all' | 'no-tools'; // constrained generation
}
```
- Store in `metadata.capabilities` field (no migration needed — JSONB)

**File: `src/models/model-registry.ts`**
- Add `getModelCapabilities(name: string): Promise<ModelCapabilities>` that merges:
  1. DB-stored `metadata.capabilities`
  2. Inferred from existing flags (`supportsVision`, `supportsTools`, `supportsStreaming`)
  3. Provider defaults (e.g., Ollama models default to `multiturn: true, systemRole: true`)

**File: `src/api/routes/models.ts`**
- Expose capabilities in model detail responses

### Verification
- `bun test src/models/model-registry.test.ts` passes
- GET /api/models/:name returns `capabilities` object
- Existing `supportsTools`, `supportsVision`, `supportsStreaming` still work (backward compatible)

---

## Phase 2: Provider Conformance Test Suite

**Goal:** Build a `testModels()` equivalent that validates each provider against standard test cases, gated by capabilities.

### What to implement

**File: `src/models/testing/conformance.ts`** (NEW)

Core types:
```typescript
interface ConformanceTestCase {
  name: string;
  description: string;
  requiredCapability?: keyof ModelCapabilities;
  run: (provider: ModelProvider, model: ModelConfigEntry, client: LiteLLMClient) => Promise<void>;
}

interface ConformanceResult {
  model: string;
  provider: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped';
  latencyMs?: number;
  error?: string;
}

interface ConformanceReport {
  timestamp: Date;
  results: ConformanceResult[];
  summary: { passed: number; failed: number; skipped: number; totalMs: number };
}
```

Test cases (adapted from Genkit's model_tester.ts):

| Test | Capability Gate | What it validates |
|------|----------------|-------------------|
| `basic-completion` | none | `complete()` returns non-empty content with valid usage |
| `streaming` | `streaming` | `stream()` yields chunks, final chunk has finishReason |
| `multi-turn` | `multiturn` | Completion with message history retains context |
| `system-prompt` | `systemRole` | System message influences output |
| `tool-calling` | `tools` | Model calls a defined tool with correct arguments |
| `structured-output` | `structuredOutput` | JSON mode returns parseable JSON |
| `vision` | `media` | Vision completion describes an image |
| `embeddings` | `embeddings` | `embed()` returns vectors of correct dimensionality |
| `health-check` | none | `checkHealth()` returns healthy status |
| `error-handling` | none | Invalid model name returns error, not crash |

Runner function:
```typescript
async function runConformanceTests(
  models: ModelConfigEntry[],
  options?: { tests?: string[]; timeout?: number }
): Promise<ConformanceReport>
```

**File: `src/models/testing/test-fixtures.ts`** (NEW)
- Standard test prompts, tool definitions, test images (base64 tiny PNG)
- Reusable across all test cases

**File: `src/models/testing/index.ts`** (NEW)
- Exports `runConformanceTests`, `ConformanceReport`, `ConformanceResult`

### Verification
- `bun test src/models/testing/conformance.test.ts` — unit tests with mocked providers
- Manual: `bun run src/models/testing/run.ts` against live Ollama

---

## Phase 3: Evaluation Framework

**Goal:** Build an evaluator system (inspired by Genkit's `defineEvaluator`) for scoring model outputs on quality metrics.

### What to implement

**File: `src/models/evaluation/types.ts`** (NEW)
```typescript
interface EvalDataPoint {
  id: string;
  input: string;           // the prompt
  output: string;          // model's response
  context?: string[];      // optional RAG context
  reference?: string;      // expected/ideal answer
  model: string;
  provider: string;
  latencyMs?: number;
}

interface EvalScore {
  metric: string;          // evaluator name
  score: number | boolean; // numeric (0-1) or pass/fail
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  reasoning?: string;      // why this score
}

interface EvalResult {
  dataPointId: string;
  scores: EvalScore[];
  timestamp: Date;
}

interface EvalRun {
  id: string;
  name: string;
  model: string;
  evaluators: string[];
  results: EvalResult[];
  summary: Record<string, { mean: number; passRate: number; count: number }>;
  createdAt: Date;
}
```

**File: `src/models/evaluation/evaluators.ts`** (NEW)

Built-in evaluators (each is a function `(dataPoint: EvalDataPoint) => Promise<EvalScore>`):

| Evaluator | What it measures | Method |
|-----------|-----------------|--------|
| `relevance` | Does the output answer the input? | LLM-as-judge (uses default model) |
| `faithfulness` | Is the output grounded in provided context? | LLM-as-judge |
| `coherence` | Is the output well-structured and logical? | LLM-as-judge |
| `toxicity` | Is the output harmful or inappropriate? | Keyword + LLM check |
| `format-compliance` | Does output match requested format? | Regex/parse check |
| `latency` | Is response time acceptable? | Threshold check (< 5s pass) |

```typescript
function defineEvaluator(
  name: string,
  description: string,
  fn: (dataPoint: EvalDataPoint) => Promise<EvalScore>
): Evaluator

function runEvaluation(
  dataset: EvalDataPoint[],
  evaluators: Evaluator[],
  options?: { batchSize?: number; concurrency?: number }
): Promise<EvalRun>
```

**File: `src/models/evaluation/datasets.ts`** (NEW)
- Standard eval datasets:
  - `generalQA` — 20 diverse questions with reference answers
  - `toolCalling` — 10 scenarios requiring tool use
  - `codeGeneration` — 10 coding tasks with test cases
  - `summarization` — 10 texts with reference summaries

**File: `src/models/evaluation/index.ts`** (NEW)
- Exports all types, evaluators, datasets, runner

### Verification
- `bun test src/models/evaluation/evaluators.test.ts` — unit tests with mock LLM responses
- Manual: run eval against Ollama model, verify scores are reasonable

---

## Phase 4: Database Storage & API

**Goal:** Persist conformance and evaluation results, expose via REST API.

### What to implement

**File: `src/db/schema/evaluations.ts`** (NEW)
```sql
-- Conformance test runs
conformance_runs (id, models, results JSONB, summary JSONB, createdAt)

-- Evaluation runs
eval_runs (id, name, model, evaluators, results JSONB, summary JSONB, datasetName, createdAt)

-- Evaluation datasets (user-defined)
eval_datasets (id, name, description, dataPoints JSONB, createdAt, updatedAt)
```

**File: `src/db/repositories/evaluation-repository.ts`** (NEW)
- CRUD for conformance runs, eval runs, datasets

**File: `src/api/routes/evaluations.ts`** (NEW)

| Method | Path | Description |
|--------|------|-------------|
| POST | /evaluations/conformance/run | Run conformance tests against specified models |
| GET | /evaluations/conformance/runs | List past conformance runs |
| GET | /evaluations/conformance/runs/:id | Get conformance run details |
| POST | /evaluations/eval/run | Run evaluation with specified evaluators and dataset |
| GET | /evaluations/eval/runs | List past eval runs |
| GET | /evaluations/eval/runs/:id | Get eval run details |
| GET | /evaluations/eval/datasets | List available datasets |
| POST | /evaluations/eval/datasets | Create custom dataset |
| GET | /evaluations/eval/summary | Aggregated scores across models |

### Verification
- API endpoints return correct data
- Results persist across restarts
- `bun test src/api/routes/evaluations.test.ts`

---

## Phase 5: Web UI Dashboard

**Goal:** Visualize conformance and evaluation results in the web UI.

### What to implement

**File: `web/app/evaluations/page.tsx`** (NEW)
- Two tabs: "Conformance" and "Evaluations"
- **Conformance tab:**
  - "Run Tests" button with model selector
  - Results table: model × test matrix with pass/fail/skip badges
  - Historical runs list with date, pass rate
- **Evaluations tab:**
  - "Run Evaluation" button with model + evaluator + dataset selectors
  - Score cards per evaluator (mean score, pass rate, chart)
  - Comparison view: side-by-side model scores
  - Drill-down: click a score to see individual data points with reasoning

**File: `web/components/evaluations/conformance-matrix.tsx`** (NEW)
- Grid component showing model × test results with color coding

**File: `web/components/evaluations/eval-scores.tsx`** (NEW)
- Score visualization components (bar charts, radar charts for multi-metric)

### Verification
- UI renders conformance matrix correctly
- Eval scores display with drill-down
- Run buttons trigger API calls and update in real-time

---

## Phase 6: CI Integration & Test Runner

**Goal:** Make conformance tests runnable in CI and as a CLI command.

### What to implement

**File: `src/models/testing/run.ts`** (NEW)
- CLI entry point: `bun run src/models/testing/run.ts [--models=ollama,openai] [--tests=basic,tools]`
- Outputs JSON report + human-readable summary
- Exit code 1 if any required test fails

**File: `.github/workflows/model-conformance.yml`** (NEW)
- GitHub Action that runs conformance tests on push to `src/models/providers/**`
- Uses local Ollama for provider tests (only Ollama in CI, others need API keys)
- Stores report as artifact

**File: `src/core/commands/eval.ts`** (NEW)
- Chat command `/eval [model]` to run quick evaluation from within the assistant
- Reports results inline in the chat

### Verification
- `bun run src/models/testing/run.ts --models=ollama` produces valid report
- GitHub Action runs on PR
- `/eval` command works in chat

---

## Phase 7: Final Verification & Documentation

### Test coverage
- Unit tests for all evaluators (mocked LLM)
- Unit tests for conformance runner (mocked providers)
- Integration test: run conformance against Ollama (requires running instance)
- Integration test: run evaluation with a small dataset against default model
- API endpoint tests for all /evaluations routes

### Anti-patterns to avoid
- Do NOT depend on Genkit as a library — implement patterns natively
- Do NOT require all providers to be available for tests to pass — use capability gating
- Do NOT store raw model outputs in the DB report — truncate to 1000 chars max
- Do NOT run evaluations synchronously on API requests — use background jobs for large datasets
- Do NOT hardcode model names in test cases — use the model registry

### Documentation
- Add section to docs/CONFIGURATION.md about eval framework
- Add inline JSDoc to all public functions
- Update docs/CHANGELOG.md

---

## Execution Order

| Phase | Depends on | Estimated complexity |
|-------|-----------|---------------------|
| 1. Capability Metadata | None | Small — schema addition, registry method |
| 2. Conformance Tests | Phase 1 | Medium — 10 test cases, runner, fixtures |
| 3. Evaluation Framework | None (parallel with 2) | Medium — evaluators, datasets, runner |
| 4. DB Storage & API | Phases 2+3 | Medium — schema, repository, routes |
| 5. Web UI Dashboard | Phase 4 | Medium — 3 new components |
| 6. CI Integration | Phase 2 | Small — CLI runner, GH Action |
| 7. Final Verification | All | Small — tests, docs |

Phases 2 and 3 can be executed in parallel. Phases 4-6 are sequential.
