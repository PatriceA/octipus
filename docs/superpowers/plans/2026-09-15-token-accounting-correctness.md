# Token Accounting Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cache-aware token usage correct on every provider path, and stop cache reads from being charged against budgets and quotas as if they were fresh tokens.

**Architecture:** One shared fold helper in `src/models/providers/usage.ts` replaces three hand-written copies of "fold exclusive cache counters into inputTokens" and fills the two places that had none. Separately, the single "tokens" concept splits into `contextTokens` (what the model read, cache reads included) and billable tokens (fresh input + output); the budget and quota gates move to the billable number while every display keeps the total.

**Tech Stack:** TypeScript, Bun, Vitest, Drizzle.

**Spec:** `docs/superpowers/specs/2026-09-15-session-prompt-strategy.md`

## Global Constraints

- No new dependency.
- `inputTokens` remains the grand total INCLUDING cache reads and cache creation; `cacheReadTokens` / `cacheCreationTokens` remain subsets of it (`src/models/cost-tracker.ts:65-74`).
- No change may turn a cost row that reads `estimated` today into `unknown`.
- Never invent a cache discount: if a model row has no `cacheRead` / `cacheWrite` price, cost stays `null` (`src/models/pricing.ts:17`). Missing rates are reported, not guessed.
- Run tests with `npx vitest run <path>`. Typecheck with `npx tsc --noEmit -p tsconfig.json`.

---

### Task 1: Recognise Anthropic cache fields in `normalizeUsage`

Anthropic, LiteLLM and OpenRouter all emit `cache_creation_input_tokens` / `cache_read_input_tokens`. `normalizeUsage` looks for `cache_write_tokens`, which none of them send, so cache creation reads as 0 and the 1.25x write premium is billed as ordinary input.

Anthropic's native `input_tokens` EXCLUDES both counters, while OpenAI-compat `prompt_tokens` INCLUDES its `prompt_tokens_details.cached_tokens`. The helper must fold only when folding is needed, which is detectable: if `read + write > input`, the counters were exclusive.

**Files:**
- Modify: `src/models/providers/usage.ts:11-57`
- Test: `src/models/providers/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `foldCacheCounters(raw: unknown): { inputTokens: number; cacheReadTokens?: number; cacheCreationTokens: number }` exported from `src/models/providers/usage.ts`. Tasks 2 and 3 both call it.

- [ ] **Step 1: Write the failing test**

Append to `src/models/providers/usage.test.ts`:

```ts
import { foldCacheCounters, normalizeUsage } from './usage';

describe('foldCacheCounters', () => {
  it('folds Anthropic-native exclusive counters into inputTokens', () => {
    // Native /v1/messages: input_tokens excludes both cache counters.
    expect(foldCacheCounters({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }))
      .toEqual({ inputTokens: 35, cacheReadTokens: 20, cacheCreationTokens: 5 });
  });

  it('leaves OpenAI-compat inclusive counters alone', () => {
    // prompt_tokens already includes cached_tokens.
    expect(foldCacheCounters({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } }))
      .toEqual({ inputTokens: 100, cacheReadTokens: 60, cacheCreationTokens: 0 });
  });

  it('reads cache creation under the Anthropic name on a compat body', () => {
    expect(foldCacheCounters({ prompt_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 50 }))
      .toEqual({ inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 40 });
  });

  it('reports no counters when the provider sends none', () => {
    expect(foldCacheCounters({ prompt_tokens: 7 })).toEqual({ inputTokens: 7, cacheCreationTokens: 0 });
  });
});

describe('normalizeUsage cache fields', () => {
  it('surfaces Anthropic cache creation through the shared fold', () => {
    const u = normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 });
    expect(u.inputTokens).toBe(35);
    expect(u.cacheReadTokens).toBe(20);
    expect(u.cacheCreationTokens).toBe(5);
    // pricing.ts refuses to cost a row where read + write > input.
    expect((u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0)).toBeLessThanOrEqual(u.inputTokens);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/providers/usage.test.ts`
Expected: FAIL — `foldCacheCounters is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/models/providers/usage.ts`, add below `extractCachedTokens`:

```ts
/**
 * Reconcile prompt-cache counters into one convention: `inputTokens` is the
 * grand total and the two cache figures are subsets of it.
 *
 * Providers disagree on whether the counters are already included. Anthropic's
 * native endpoint reports `input_tokens` EXCLUSIVE of both cache figures;
 * OpenAI-compat bodies report `prompt_tokens` INCLUSIVE of
 * `prompt_tokens_details.cached_tokens`. Proxies (LiteLLM, OpenRouter) pass the
 * Anthropic names through on an otherwise OpenAI-shaped body, in either style.
 *
 * Rather than keying off the provider, detect it: counters that sum to more
 * than the reported input can only have been exclusive. That is the same
 * invariant `pricing.ts` refuses to cost, so folding here is what keeps cost
 * rows out of `unknown`.
 */
export function foldCacheCounters(raw: unknown): {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens: number;
} {
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const u = raw as Record<string, any> | undefined;

  const reported = count(u?.prompt_tokens ?? u?.input_tokens);
  const read = extractCachedTokens(raw).cacheReadTokens ?? count(u?.cache_read_input_tokens);
  const write = count(
    u?.cache_creation_input_tokens
      ?? u?.prompt_tokens_details?.cache_write_tokens
      ?? u?.input_tokens_details?.cache_write_tokens,
  );

  const inputTokens = read + write > reported ? reported + read + write : reported;
  return { inputTokens, ...(read > 0 ? { cacheReadTokens: read } : {}), cacheCreationTokens: write };
}
```

Then rewrite `normalizeUsage` to use it:

```ts
export function normalizeUsage(raw: any): import('../litellm-client').CompletionResult['usage'] {
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = foldCacheCounters(raw);
  const outputTokens = count(raw?.completion_tokens ?? raw?.output_tokens);
  return {
    inputTokens, outputTokens,
    totalTokens: count(raw?.total_tokens ?? inputTokens + outputTokens),
    available: [raw?.prompt_tokens, raw?.input_tokens, raw?.completion_tokens, raw?.output_tokens, raw?.total_tokens].some(v => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    cacheCreationTokens,
    reasoningTokens: count(raw?.completion_tokens_details?.reasoning_tokens ?? raw?.output_tokens_details?.reasoning_tokens),
    ...(typeof raw?.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? { reportedCost: raw.cost } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/models/providers/usage.test.ts src/models/pricing.test.ts src/models/cost-tracker.test.ts`
Expected: PASS. Existing cases are unchanged because `foldCacheCounters` returns `reported` untouched whenever the counters were already inclusive.

- [ ] **Step 5: Commit**

```bash
git add src/models/providers/usage.ts src/models/providers/usage.test.ts
git commit -m "Recognise Anthropic cache counters in shared usage normalization"
```

---

### Task 2: Route the native Anthropic provider through the shared fold

`custom/anthropic-compat-provider.ts:211-236` hand-rolls the same fold. Two copies of one rule drift; this copy currently defines correct behaviour, so it moves into the helper and the test that locks it stays green.

**Files:**
- Modify: `src/models/providers/custom/anthropic-compat-provider.ts:211-236`
- Test: `src/models/providers/anthropic-native.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: `foldCacheCounters` from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Run the existing test to capture current behaviour**

Run: `npx vitest run src/models/providers/anthropic-native.test.ts`
Expected: PASS — `input 10 + cache_read 20 + create 5 -> inputTokens 35, cacheReadTokens 20` (`anthropic-native.test.ts:101-109`).

- [ ] **Step 2: Replace the local fold with the helper**

In `src/models/providers/custom/anthropic-compat-provider.ts` add the import:

```ts
import { foldCacheCounters } from '../usage';
```

and inside `anthropicAccountingResponse`, replace the hand-written read/creation extraction and the `inputTokens` sum with:

```ts
  // One convention, one implementation: see foldCacheCounters in usage.ts.
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = foldCacheCounters(raw);
```

keeping the existing `outputTokens`, `totalTokens` and return shape, and emitting `cacheReadTokens` / `cacheCreationTokens` from the helper.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/models/providers/anthropic-native.test.ts src/models/providers/custom/anthropic-compat-provider.test.ts`
Expected: PASS, identical numbers.

- [ ] **Step 4: Commit**

```bash
git add src/models/providers/custom/anthropic-compat-provider.ts
git commit -m "Fold Anthropic cache counters through the shared helper"
```

---

### Task 3: Count cache tokens on the one-shot CLI provider

`parseClaudeStyleOutput` (`src/models/providers/cli-provider.ts:351-373`) reads only `input_tokens` / `output_tokens`. A `claude --output-format json` completion with a 95% cache hit records almost no input, so quota tracking (`quota-tracker.ts:73`) under-counts CLI usage.

**Files:**
- Modify: `src/models/providers/cli-provider.ts:351-373`
- Test: `src/models/providers/cli-claude.test.ts`

**Interfaces:**
- Consumes: `foldCacheCounters` from Task 1.
- Produces: no new exports; `claudeCodeConfig.parseOutput(...).usage` gains `cacheReadTokens` / `cacheCreationTokens`.

- [ ] **Step 1: Write the failing test**

Append to `src/models/providers/cli-claude.test.ts`:

```ts
it('counts cache reads and cache creation from nested usage', () => {
  const stdout = JSON.stringify({
    result: 'ok',
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
  });
  const r = claudeCodeConfig.parseOutput(stdout, Date.now());
  expect(r.usage.inputTokens).toBe(35);
  expect(r.usage.cacheReadTokens).toBe(20);
  expect(r.usage.cacheCreationTokens).toBe(5);
  expect(r.usage.totalTokens).toBe(38);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/providers/cli-claude.test.ts`
Expected: FAIL — `inputTokens` is 10, `cacheReadTokens` undefined.

- [ ] **Step 3: Implement**

In `src/models/providers/cli-provider.ts`, inside `parseClaudeStyleOutput`, replace the input/output extraction with the shared fold over whichever usage object was found (nested `usage` first, then the top-level fields the existing code already supports):

```ts
    const { inputTokens, cacheReadTokens, cacheCreationTokens } = foldCacheCounters(usageSource);
    const outputTokens = count(usageSource?.output_tokens ?? usageSource?.completion_tokens);
    const usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      cacheCreationTokens,
      available: inputTokens > 0 || outputTokens > 0,
    };
```

with `import { foldCacheCounters } from './usage';` at the top.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/models/providers/cli-claude.test.ts src/models/providers/cli-vendor.test.ts`
Expected: PASS. The existing "plain text -> zero usage" case still passes because `foldCacheCounters(undefined)` returns zeros.

- [ ] **Step 5: Commit**

```bash
git add src/models/providers/cli-provider.ts src/models/providers/cli-claude.test.ts
git commit -m "Count CLI one-shot cache tokens instead of dropping them"
```

---

### Task 4: Separate context tokens from billable tokens

Once caching works, "tokens used" stops being a cost proxy: a cached read costs about a tenth of a fresh one, and a resumed session reports the entire reconstructed context as cache reads every turn. Budget gates that compare a flat token count will abort cheap runs (`agent-worker.ts:964`, `:1090`), starve swarm pools (`swarm/spawn-budget.ts:61`) and trip daily quotas (`security/quotas.ts:120`).

Context-fill displays must keep counting cache reads — the model really did read them. Only the gates move.

**Files:**
- Create: `src/models/billable-tokens.ts`
- Test: `src/models/billable-tokens.test.ts`

**Interfaces:**
- Consumes: `CompletionResult['usage']` from `src/models/litellm-client.ts:85-97`.
- Produces: `billableTokens(usage: CompletionResult['usage']): number` — fresh input + output, with cache reads and cache creation excluded. Task 5 consumes it.

- [ ] **Step 1: Write the failing test**

Create `src/models/billable-tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { billableTokens } from './billable-tokens';

describe('billableTokens', () => {
  it('excludes cache reads from the billable figure', () => {
    // 35 input of which 20 were cache reads and 5 cache creation -> 10 fresh.
    expect(billableTokens({ inputTokens: 35, outputTokens: 3, totalTokens: 38, cacheReadTokens: 20, cacheCreationTokens: 5 })).toBe(13);
  });

  it('equals input + output when nothing was cached', () => {
    expect(billableTokens({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })).toBe(120);
  });

  it('never goes negative on inconsistent provider numbers', () => {
    expect(billableTokens({ inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 999 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/billable-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/models/billable-tokens.ts`:

```ts
import type { CompletionResult } from './litellm-client';

/**
 * Tokens that actually cost near full price: fresh input plus output.
 *
 * `inputTokens` is the grand total and includes cache reads, which bill at
 * roughly a tenth of the fresh rate. Budget gates and quotas are spend
 * proxies, so they compare this; context-fill meters are not, so they keep
 * using the grand total. Cache creation is excluded too — it is re-read
 * context, and counting it would make a well-cached session look expensive
 * exactly once per prefix.
 */
export function billableTokens(usage: CompletionResult['usage']): number {
  const fresh = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0));
  return fresh + usage.outputTokens;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/models/billable-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/billable-tokens.ts src/models/billable-tokens.test.ts
git commit -m "Add a billable-token figure that excludes cache reads"
```

---

### Task 5: Point the budget gates at billable tokens

**Files:**
- Modify: `src/core/agent-worker.ts:458-462` (`accountedTokens`), `:962-971`, `:1085-1100`, `:1199`
- Modify: `src/core/swarm/spawn-budget.ts:57-107`
- Test: `src/core/swarm/budget-enforcement.test.ts`

**Interfaces:**
- Consumes: `billableTokens` from Task 4.
- Produces: `AgentWorker.getBillableTokens(): number`, alongside the existing `getTotalTokens(): number`, which keeps its context-proxy meaning.

- [ ] **Step 1: Write the failing test**

Append to `src/core/swarm/budget-enforcement.test.ts`, building the worker the way the neighbouring tests in that file do:

```ts
it('does not abort a run whose tokens are almost all cache reads', async () => {
  // 200k read from cache, 2k fresh: costs like 2k, must not trip a 100k budget.
  const worker = makeWorkerWithUsage({ inputTokens: 202_000, outputTokens: 500, totalTokens: 202_500, cacheReadTokens: 200_000 });
  expect(worker.getTotalTokens()).toBe(202_500);   // context proxy unchanged
  expect(worker.getBillableTokens()).toBe(2_500);  // spend proxy
  await expect(worker.assertWithinBudget(100_000)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/swarm/budget-enforcement.test.ts`
Expected: FAIL — `getBillableTokens is not a function`.

- [ ] **Step 3: Implement**

In `src/core/agent-worker.ts`, next to the existing `totalTokensUsed` accumulation at `:1199`, add a `billableTokensUsed` accumulator fed by `billableTokens(completion.usage)`, and expose both:

```ts
  /** Context proxy: everything the model read, cache reads included. */
  getTotalTokens(): number { return this.totalTokensUsed; }

  /** Spend proxy: fresh input + output. Budget gates compare this. */
  getBillableTokens(): number { return this.billableTokensUsed; }
```

Change the two budget comparisons (`:964`, `:1090`) and `swarm/spawn-budget.ts:61-68` to read `getBillableTokens()`. Leave `recordContextFill`, `sessions.token_count` and every display on the total.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/swarm/budget-enforcement.test.ts src/core/swarm/contract-retry.test.ts src/core/agent-worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-worker.ts src/core/swarm/spawn-budget.ts src/core/swarm/budget-enforcement.test.ts
git commit -m "Compare budgets against billable tokens, not cache reads"
```

---

### Task 6: Report models missing cache prices

`pricing.ts:17` returns `null` the moment a cached read meets a model row with no `cacheRead` rate — correct (never invent a discount), but silent: the session cost drops toward zero and the dashboard reads `$0.0000 saved` exactly on the models where caching works.

**Files:**
- Modify: `src/models/cost-tracker.ts:98-149`
- Test: `src/models/cost-tracker.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports; adds a deduplicated warn carrying `{ model, cachedInputTokens, cacheCreationTokens }`.

- [ ] **Step 1: Write the failing test**

Append to `src/models/cost-tracker.test.ts`, reusing the file's existing tracker fixture:

```ts
it('warns when cache tokens appear on a model with no cache pricing', async () => {
  const warn = vi.spyOn(modelLogger, 'warn');
  await tracker.logUsageWithCost({
    ...baseUsageRow,
    model: 'model-without-cache-rates',
    cachedInputTokens: 400,
    cacheCreationTokens: 0,
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'model-without-cache-rates' }),
    expect.stringContaining('cache pricing'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/cost-tracker.test.ts`
Expected: FAIL — no warn emitted.

- [ ] **Step 3: Implement**

In `logUsageWithCost`, where `costSource` resolves to `unknown` while `cachedInputTokens > 0 || cacheCreationTokens > 0`, emit a warn naming the model and which rate is missing, deduplicated through a module-level `Set<string>` of already-warned model ids:

```ts
const warnedMissingCachePricing = new Set<string>();
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/models/cost-tracker.test.ts src/models/pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/cost-tracker.ts src/models/cost-tracker.test.ts
git commit -m "Warn when cache tokens arrive on a model with no cache pricing"
```

---

### Task 7: Full typecheck and suite

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 2: Run the affected suites**

Run: `npx vitest run src/models src/core/swarm src/core/agent-worker.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "Fix fallout from cache-aware token accounting"
```
