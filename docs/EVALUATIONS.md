# Model Evaluation & Provider Testing

Automated testing and quality scoring for LLM providers. Inspired by Genkit's evaluation patterns, implemented natively in Bun + TypeScript without any Genkit dependency.

Two distinct systems:
- **Provider Conformance** — validates that a provider *works correctly* (pass/fail per feature)
- **Model Evaluation** — scores how *well* a model performs (quality metrics 0–1)

---

## Provider Conformance Tests

Runs a battery of 10 tests against every enabled model to verify the provider integration is working. Tests auto-skip when the model's capability flags indicate it doesn't support that feature.

### Test Cases

| Test | Required Capability | What it validates |
|------|--------------------|--------------------|
| `basic-completion` | — | `complete()` returns a response containing "4" for "What is 2+2?" |
| `streaming` | `streaming` | `stream()` yields multiple chunks, last chunk has `finishReason` |
| `multi-turn` | `multiturn` | Second turn in a conversation retains context from the first |
| `system-prompt` | `systemRole` | System message instructing French produces a French response |
| `tool-calling` | `tools` | Model calls `add_numbers(5, 3)` with correct arguments |
| `tool-result-handling` | `tools` | Model incorporates a tool result message into its final response |
| `structured-output` | `structuredOutput` | `responseFormat: { type: 'json_object' }` returns parseable JSON |
| `vision` | `media` | Vision completion returns non-empty response for a test image |
| `embeddings` | `embeddings` | `embed()` returns `number[][]` with non-zero dimensions |
| `error-handling` | — | Invalid model name throws an error rather than hanging |

Capability flags are derived from model DB fields (`supportsStreaming`, `supportsTools`, `supportsVision`) plus a check for the `embedding` topic. See `capabilitiesFromModel()` in `src/models/testing/conformance.ts`.

### Running Conformance Tests

**CLI** (requires database + provider access):

```bash
# All enabled models
bun run src/models/testing/run.ts

# Filter by provider
bun run src/models/testing/run.ts --provider=ollama

# Test a specific model
bun run src/models/testing/run.ts --model=qwen3:14b

# Run only selected tests
bun run src/models/testing/run.ts --test=basic-completion,tool-calling

# Increase timeout (default 30000ms)
bun run src/models/testing/run.ts --timeout=60000

# JSON output only (no table, writes report file too)
bun run src/models/testing/run.ts --json
```

Exit code is 1 if any tests fail. JSON report is written to `conformance-report-<timestamp>.json`.

**Chat command:**

```
/eval conformance              # all enabled models
/eval conformance qwen3:14b    # specific model by modelId or name
```

**API:**

```http
POST /api/evaluations/conformance/run
Authorization: Bearer <token>
Content-Type: application/json

{
  "models": ["qwen3:14b", "gemma3:12b"],  // omit for all enabled models
  "tests": ["basic-completion", "tool-calling"],  // omit for all tests
  "timeout": 30000
}
```

### Example Output

```
MODEL CONFORMANCE TEST RESULTS
================================================================================

--- qwen3:14b (ollama) ---
  basic-completion    PASS       412ms
  streaming           PASS      1204ms
  multi-turn          PASS       893ms
  system-prompt       PASS       756ms
  tool-calling        PASS      1102ms
  tool-result-handling PASS      988ms
  structured-output   PASS       671ms
  vision              SKIP               Requires capability "media" which is false
  embeddings          SKIP               Requires capability "embeddings" which is false
  error-handling      PASS        38ms

--------------------------------------------------------------------------------
Total: 10  |  Passed: 8  |  Failed: 0  |  Skipped: 2  |  Duration: 6.1s
================================================================================
```

The chat command produces a markdown matrix:

| Model | basic comp | streaming | multi turn | system pro | tool calli | tool resul | structured | vision | embeddings | error hand |
|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| `qwen3:14b` | PASS | PASS | PASS | PASS | PASS | PASS | PASS | SKIP | SKIP | PASS |

---

## Model Evaluation (Quality Scoring)

Scores model output quality across 8 metrics. Results are stored per model and support cross-model comparison.

### Evaluators

| Evaluator | Method | What it measures |
|-----------|--------|-----------------|
| `relevance` | LLM-as-judge | Does the response address the question? |
| `faithfulness` | LLM-as-judge | Is the response grounded in provided context? Returns `UNKNOWN` when no context is supplied. |
| `coherence` | LLM-as-judge | Is the response logically structured and readable? |
| `format-compliance` | Programmatic | Does output match the expected format (JSON, bullets)? Detected from `reference` field. |
| `latency` | Threshold | <3s = 1.0 (PASS), 3–10s = 0.7 (PASS), 10–30s = 0.4 (FAIL), >30s = 0.0 (FAIL) |
| `tool-accuracy` | Programmatic | Compares expected vs actual tool call: tool name (0.3), argument keys (0.3), argument values (0.4). |
| `instruction-following` | LLM-as-judge | Does the response comply with system prompt and constraints? Returns `UNKNOWN` when neither is provided. |
| `completeness` | LLM-as-judge | Does the response address all parts of the question? |

Scores are `0.0–1.0`. Status is `PASS` at ≥ 0.7, `FAIL` below, `UNKNOWN` when the metric can't be computed. LLM-as-judge uses the model registered for the `evaluation` topic (falls back to the default model).

### Standard Datasets

| Dataset | Items | Description |
|---------|-------|-------------|
| `generalQA` | 5 | Factual questions with reference answers |
| `toolCalling` | 5 | Scenarios requiring tool use with expected tool calls |
| `instructionFollowing` | 5 | Prompts with system prompt constraints |
| `codeGeneration` | 5 | Coding tasks with reference solutions |

Datasets are defined in `src/models/evaluation/datasets.ts`. `output`, `model`, and `provider` fields are filled at eval time.

### Running Quality Evaluation

**Chat command:**

```
/eval quality qwen3:14b     # runs generalQA dataset + relevance/coherence/completeness/latency
/eval compare               # cross-model comparison table from DB
```

Example quality output:

```
**Quality Evaluation: `qwen3:14b`**

| Metric       | Score | Pass Rate    | Samples |
|--------------|-------|--------------|---------|
| relevance    | 87%   | 100% (PASS)  | 5       |
| coherence    | 92%   | 100% (PASS)  | 5       |
| completeness | 78%   | 80% (PASS)   | 5       |
| latency      | 70%   | 80% (PASS)   | 5       |
```

**API:**

```http
POST /api/evaluations/eval/run
Authorization: Bearer <token>
Content-Type: application/json

{
  "model": "qwen3:14b",
  "dataset": "generalQA",
  "evaluators": ["relevance", "coherence", "completeness"],
  "name": "my-eval-run"
}
```

Cross-model comparison:

```http
GET /api/evaluations/eval/summary
Authorization: Bearer <token>
```

### Custom Evaluators

Use `defineEvaluator` to add project-specific metrics:

```typescript
import { defineEvaluator } from '@/models/evaluation/evaluators';
import type { EvalScore } from '@/models/evaluation/types';

const brevity = defineEvaluator(
  'brevity',
  'Penalizes responses over 500 characters',
  async (dp): Promise<EvalScore> => {
    const tooLong = dp.output.length > 500;
    return {
      metric: 'brevity',
      score: tooLong ? 0.0 : 1.0,
      status: tooLong ? 'FAIL' : 'PASS',
      reasoning: `${dp.output.length} chars`,
    };
  },
);
```

---

## Model Capabilities

Capabilities are derived from model DB fields — they are not manually editable outside of the model configuration.

| Capability | Source | Default |
|-----------|--------|---------|
| `streaming` | `model.supportsStreaming` | `false` |
| `tools` | `model.supportsTools` | `false` |
| `structuredOutput` | same as `tools` | `false` |
| `media` | `model.supportsVision` | `false` |
| `embeddings` | topic includes `embedding` | `false` |
| `multiturn` | `true` unless embedding model | `true` |
| `systemRole` | `true` unless embedding model | `true` |

Capabilities gate conformance tests (test is `skipped` rather than `failed` when the required capability is absent) and are also used by the orchestrator's model routing logic.

---

## Web UI

The Evaluations page is at `/eval` and has three tabs.

**Suite Tests** — results from the `bun test` eval suite run against the live service.

**Conformance** — matrix view of model × test results. Run controls let you trigger a new conformance run against all enabled models or a specific model. Past runs are listed with date and pass rate.

**Model Eval** — score cards per evaluator with mean score and pass rate. Cross-model comparison table shows pass rates side-by-side across all models that have stored runs. Click any score cell to drill into the individual data points and LLM-as-judge reasoning.

---

## API Reference

All endpoints require `Authorization: Bearer <token>`. Prefix: `/api/evaluations`.

### Conformance

| Method | Path | Body / Query | Response |
|--------|------|-------------|----------|
| `POST` | `/conformance/run` | `{ models?: string[], tests?: string[], timeout?: number }` | `{ id, timestamp, models, summary, results }` |
| `GET` | `/conformance/runs` | `?limit=20` | `{ runs: [{ id, models, summary, createdAt }] }` |
| `GET` | `/conformance/runs/:id` | — | Full run with all results |

### Evaluation

| Method | Path | Body / Query | Response |
|--------|------|-------------|----------|
| `POST` | `/eval/run` | `{ model: string, dataset?: string, evaluators?: string[], name?: string }` | `{ id, name, model, datasetName, evaluators, summary, results, createdAt }` |
| `GET` | `/eval/runs` | `?limit=20` | `{ runs: [{ id, name, model, datasetName, evaluators, summary, createdAt }] }` |
| `GET` | `/eval/runs/:id` | — | Full run with per-data-point scores and reasoning |
| `GET` | `/eval/datasets` | — | `{ datasets: [{ name, count }] }` |
| `GET` | `/eval/evaluators` | — | `{ evaluators: [{ name, description }] }` |
| `GET` | `/eval/summary` | — | Aggregated pass rates per model per evaluator |

Full interactive docs at `http://localhost:3005/swagger` (tag: `evaluations`).

---

## Quick Start

```bash
# 1. Start services (PostgreSQL, Redis, Ollama)
docker compose -f /path/to/docker-services/docker-compose.yml up -d

# 2. Start the backend
bun run dev

# 3. Run conformance against local Ollama models
bun run src/models/testing/run.ts --provider=ollama

# 4. Run quality evaluation via chat
/eval quality qwen3:14b

# 5. Compare all models
/eval compare
```

### Environment Variables for Conformance

Provider tests run only when the corresponding key is set:

| Variable | Provider |
|----------|---------|
| `OPENAI_API_KEY` | openai |
| `ANTHROPIC_API_KEY` | anthropic |
| `GEMINI_API_KEY` | gemini |
| `DEEPSEEK_API_KEY` | deepseek |
| `VOYAGE_API_KEY` | voyage (embeddings) |

Ollama and LiteLLM are always attempted. The `cli` provider is excluded from conformance runs.

---

## Source Layout

```
src/models/testing/
  conformance.ts        # 10 test cases, runner, capability gating
  test-fixtures.ts      # prompts, tool definitions, validators, test image
  conformance.test.ts   # unit tests with mocked providers
  run.ts                # CLI entry point
  index.ts              # public API exports

src/models/evaluation/
  types.ts              # EvalDataPoint, EvalScore, EvalRun, Evaluator
  evaluators.ts         # 8 built-in evaluators + defineEvaluator factory
  datasets.ts           # generalQA, toolCalling, instructionFollowing, codeGeneration
  runner.ts             # runEvaluation() with batching + concurrency
  index.ts              # public API exports

src/api/routes/
  evaluations.ts        # all /evaluations/* REST endpoints

src/core/commands/
  eval.ts               # /eval chat command (conformance, quality, compare)
```
