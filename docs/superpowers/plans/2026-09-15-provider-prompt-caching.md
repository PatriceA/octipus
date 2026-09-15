# Direct-Provider Prompt Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache everything a direct API provider will let us cache — the growing conversation and tool-result history as well as the system prefix — and make a missed cache split visible instead of silent.

**Architecture:** Anthropic allows four cache breakpoints; octipus uses one, on the system block. A second breakpoint goes on the last message before the newest turn, which is what makes an agent loop's accumulated tool results cheap on iterations 2..N. Two prompt-assembly sites emit a date header that does not match `VOLATILE_MARKER`, so their prompts are never split at all; both are one-character fixes. Finally the "did we split?" signal, which both callers currently discard, gets logged along with the cache token counts.

**Tech Stack:** TypeScript, Bun, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-session-prompt-strategy.md`

**Depends on:** `2026-09-15-token-accounting-correctness.md` (Task 1 in particular — without it the new breakpoints bill the cache-write premium as ordinary input).

## Global Constraints

- No new dependency.
- Anthropic's cache prefix order is `tools -> system -> messages`; the existing system breakpoint therefore already covers tool schemas. Do not add a breakpoint to tool definitions.
- Maximum 4 breakpoints per request. After this plan: 2.
- A breakpoint below a model's minimum cacheable prefix is a silent no-op — respect `minCacheableChars(model)` (`src/models/providers/prompt-cache.ts:30-43`).
- `cachePolicy === 'off'` must continue to disable every breakpoint.
- Run tests with `npx vitest run <path>`. Typecheck with `npx tsc --noEmit -p tsconfig.json`.

---

### Task 1: Fix the two prompt sites whose date header never matches the marker

`VOLATILE_MARKER` is `/\n\nCURRENT DATE ?&? ?\/?\s?TIME/` (`prompt-cache.ts:16`) and needs a blank line before it. `direct-response.ts:89` emits a single `\n`; `swarm/spawner.ts:2295` emits none because the block is `parts[0]`. Both prompts are therefore never split and never cached, silently.

**Files:**
- Modify: `src/core/agent/direct-response.ts:89`
- Modify: `src/core/swarm/spawner.ts:2295`
- Test: `src/models/providers/prompt-cache.test.ts`

**Interfaces:**
- Consumes: `splitVolatileSystem` from `src/models/providers/prompt-cache.ts:51`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/models/providers/prompt-cache.test.ts`:

```ts
import { buildDirectResponseSystem } from '@/core/agent/direct-response';

describe('every prompt-assembly site is splittable', () => {
  it('splits the direct-response system prompt', () => {
    const system = buildDirectResponseSystem({
      persona: 'x'.repeat(5000),      // over the 4000-char floor
      dateContext: 'CURRENT DATE/TIME: 2026-09-15T10:00:00Z',
    });
    expect(splitVolatileSystem(system)).not.toBeNull();
  });
});
```

If `direct-response.ts` has no exported seam for building the system string, extract one in Step 3 rather than testing through the whole response path: a pure `buildDirectResponseSystem(parts): string` that the existing caller uses.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/providers/prompt-cache.test.ts`
Expected: FAIL — `splitVolatileSystem` returns `null` because the marker needs `\n\n`.

- [ ] **Step 3: Implement**

In `src/core/agent/direct-response.ts:89`, change the date block to carry a blank line before it:

```ts
  const dateContext = `\n\nCURRENT DATE/TIME: ${now}`;
```

In `src/core/swarm/spawner.ts:2295`, the date block is the first element of `parts`, so give it the same leading blank line and keep it first in the volatile tier:

```ts
  parts.push(`\n\nCURRENT DATE/TIME: ${now}`);
```

Extract `buildDirectResponseSystem` if Step 1 needed it, and have the existing call site use it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/models/providers/prompt-cache.test.ts src/core/agent/root-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/direct-response.ts src/core/swarm/spawner.ts src/models/providers/prompt-cache.test.ts
git commit -m "Make every assembled system prompt splittable at the volatile marker"
```

---

### Task 2: Add a history breakpoint to the native Anthropic path

Both native builders funnel through `toAnthropicMessages` (`custom/anthropic-compat-provider.ts:295-380`), so one edit covers `anthropic-provider.ts:232` and `anthropic-compat-provider.ts:133`. The breakpoint goes on the last content block of the turn BEFORE the newest one: everything up to it is stable across iterations of an agent loop, and the newest turn is the only part that changed.

**Files:**
- Modify: `src/models/providers/custom/anthropic-compat-provider.ts:295-380`
- Test: `src/models/providers/anthropic-native.test.ts`

**Interfaces:**
- Consumes: `AgentMessage[]`.
- Produces: `markHistoryCacheBreakpoint(messages: AnthropicMessage[]): boolean` exported from `src/models/providers/custom/anthropic-compat-provider.ts` — returns whether a breakpoint was placed. Task 4 logs it.

- [ ] **Step 1: Write the failing test**

Append to `src/models/providers/anthropic-native.test.ts`:

```ts
describe('history cache breakpoint', () => {
  it('marks the last block of the turn before the newest one', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'first', timestamp: new Date() },
      { role: 'assistant', content: 'answer', timestamp: new Date() },
      { role: 'user', content: 'second', timestamp: new Date() },
    ]);
    markHistoryCacheBreakpoint(messages);
    const marked = messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.cache_control);
    expect(marked).toHaveLength(1);
    // The newest turn must stay uncached — it is what changed.
    const newest = messages[messages.length - 1].content as any[];
    expect(newest.some(b => b.cache_control)).toBe(false);
  });

  it('places no breakpoint when there is only the newest turn', () => {
    const { messages } = toAnthropicMessages([{ role: 'user', content: 'only', timestamp: new Date() }]);
    expect(markHistoryCacheBreakpoint(messages)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/providers/anthropic-native.test.ts`
Expected: FAIL — `markHistoryCacheBreakpoint is not a function`.

- [ ] **Step 3: Implement**

In `src/models/providers/custom/anthropic-compat-provider.ts`:

```ts
/**
 * Put a cache breakpoint at the end of the settled history, so an agent loop
 * re-reads its accumulated tool results at cache rates instead of full price
 * on every iteration. The newest turn is deliberately left outside the
 * breakpoint: it is the only part that changed, and marking it would write a
 * new cache entry per turn instead of reading the previous one.
 *
 * Anthropic allows four breakpoints; with the system split this is the second.
 */
export function markHistoryCacheBreakpoint(messages: AnthropicMessage[]): boolean {
  if (messages.length < 2) return false;
  const prev = messages[messages.length - 2];
  if (!Array.isArray(prev.content) || prev.content.length === 0) return false;
  const last = prev.content[prev.content.length - 1] as { cache_control?: { type: 'ephemeral' } };
  last.cache_control = { type: 'ephemeral' };
  return true;
}
```

Call it from both body builders, respecting `cachePolicy`:

```ts
  if (options.cachePolicy !== 'off') markHistoryCacheBreakpoint(body.messages);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/models/providers/anthropic-native.test.ts src/models/providers/custom/anthropic-compat-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/providers/custom/anthropic-compat-provider.ts src/models/providers/anthropic-native.test.ts
git commit -m "Cache the settled history on the native Anthropic path"
```

---

### Task 3: Add the same breakpoint to the OpenAI-compat pass-through

LiteLLM and OpenRouter forward `cache_control` to an Anthropic upstream, and both call `applyAnthropicCacheControl` (`prompt-cache.ts:98-107`), which today returns after marking the first system message. Extending the helper covers `litellm-client.ts:471,659` and `openrouter-provider.ts:56,155` with no call-site change.

**Files:**
- Modify: `src/models/providers/prompt-cache.ts:98-107`
- Test: `src/models/providers/prompt-cache.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyAnthropicCacheControl` keeps its signature but its boolean now means "at least one breakpoint was placed".

- [ ] **Step 1: Write the failing test**

Append to `src/models/providers/prompt-cache.test.ts`:

```ts
it('marks the settled history as well as the system prefix', () => {
  const messages = [
    { role: 'system', content: `${'x'.repeat(5000)}\n\nCURRENT DATE/TIME: now` },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ] as any[];
  expect(applyAnthropicCacheControl(messages, 'claude-sonnet-4-5')).toBe(true);
  const marked = messages.filter(m => Array.isArray(m.content) && m.content.some((b: any) => b.cache_control));
  expect(marked).toHaveLength(2);                      // system + settled history
  expect(messages[messages.length - 1].content).toBe('second'); // newest turn untouched
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/models/providers/prompt-cache.test.ts`
Expected: FAIL — only one marked message.

- [ ] **Step 3: Implement**

In `src/models/providers/prompt-cache.ts`, after the existing system pass, add a second pass that converts the last non-system message before the newest turn from a string to a one-block array carrying `cache_control`, leaving the newest turn as-is. Keep the lossless-reassembly property the existing test at `:51` asserts.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/models/providers/prompt-cache.test.ts src/models/litellm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/providers/prompt-cache.ts src/models/providers/prompt-cache.test.ts
git commit -m "Cache the settled history on the OpenAI-compat pass-through too"
```

---

### Task 4: Make cache behaviour observable

`applyAnthropicCacheControl` returns whether it split and all four call sites discard it, so a prompt that silently stopped being cacheable (exactly the Task 1 bug) is invisible. The completion log line (`providers/index.ts:267-276`) carries no cache fields either.

**Files:**
- Modify: `src/models/providers/index.ts:260-276`
- Modify: `src/models/litellm-client.ts:471,659`
- Modify: `src/models/providers/openrouter-provider.ts:56,155`
- Test: `src/models/providers/prompt-cache.test.ts`

**Interfaces:**
- Consumes: the boolean from `applyAnthropicCacheControl`, `cacheReadTokens` / `cacheCreationTokens` from Task 1 of the accounting plan.
- Produces: no new exports.

- [ ] **Step 1: Add the cache fields to the completion log**

In `src/models/providers/index.ts`, extend the existing `'LLM completion'` log object with:

```ts
        cacheReadTokens: result.usage.cacheReadTokens ?? 0,
        cacheCreationTokens: result.usage.cacheCreationTokens ?? 0,
```

- [ ] **Step 2: Log a missed split once per model**

At each `applyAnthropicCacheControl` call site, capture the boolean and, when it is `false` for a model `isAnthropicFamily` matches, emit a deduplicated `modelLogger.debug` naming the model. Debug, not warn: a short prompt legitimately does not split.

- [ ] **Step 3: Verify by hand against a real run**

Run one chat turn against an Anthropic-family model and confirm the completion log now shows non-zero `cacheCreationTokens` on the first turn and non-zero `cacheReadTokens` on the second.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/models` then `npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/models/providers/index.ts src/models/litellm-client.ts src/models/providers/openrouter-provider.ts
git commit -m "Log cache tokens and missed cache splits"
```
