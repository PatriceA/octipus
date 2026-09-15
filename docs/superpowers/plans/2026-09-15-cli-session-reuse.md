# CLI Session Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One octipus session keeps using one vendor CLI session for as long as the vendor supports it, sends only the new turn once the vendor holds the history, and pushes octipus's own compaction through to the vendor instead of re-sending a summary of context the vendor already has.

**Architecture:** The vendor session id lives on the octipus session (`sessions.context.cliSessions`), keyed by CLI adapter. Claude mints its id on our side (`--session-id <uuid>`, then `--resume <uuid>`); Codex hands its `thread_id` back and we store it. Everything that resume cannot change — model, permission mode, plan mode, working directory — is fingerprinted alongside the id, and a mismatch throws the id away. When a session is resumed, the worker sends only this turn's message and root-runner drops the history blocks the vendor already holds. Antigravity and Vibe are excluded and keep today's behaviour.

**Tech Stack:** TypeScript, Bun, Vitest, Drizzle (JSONB session context).

**Spec:** `docs/superpowers/specs/2026-09-15-session-prompt-strategy.md`

**Depends on:** `2026-09-15-token-accounting-correctness.md` — mandatory. Without it a resumed session's cache reads trip the CLI budget kill-switch (`cli-agent-worker.ts:736`), zero out vibe's `--max-tokens`, and exhaust daily quotas.

## Global Constraints

- Reuse is opt-in: setting `cli.reuseSessions`, default `false`, until it has been exercised.
- Claude Code and Codex only. Antigravity 1.1.5 emits no conversation id in print mode and silently forks a fresh conversation when handed a stale one; Vibe is not installed and its resume depends on `log_interactions` staying true. Both keep full replay.
- A new octipus session must always start a new vendor session. This follows from storing the id on the octipus session — do not add any cross-session lookup.
- Resume must never lose a user turn: a stale id falls back to one cold run with the full prompt.
- Claude requires `--mcp-config` on every resume and does not restore it, so the per-run MCP config file must outlive the run while a session id referencing it is stored.
- `codex exec` must not be launched with `--ephemeral` when reuse is enabled — ephemeral runs are unresumable.
- Windows is the primary platform: prompts keep going via stdin / temp file, no shell quoting assumptions.
- Run tests with `npx vitest run <path>`. Typecheck with `npx tsc --noEmit -p tsconfig.json`.

---

### Task 1: Declare which adapters can resume

**Files:**
- Modify: `src/shared/cli-capabilities.ts`
- Test: `src/shared/cli-capabilities.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `CLI_RESUME: Record<string, { style: 'caller-minted' | 'captured'; flag: string }>` and `canResume(adapterKey: string): boolean`, both exported from `src/shared/cli-capabilities.ts`. Tasks 3, 4 and 5 consume them.

- [ ] **Step 1: Write the failing test**

Create `src/shared/cli-capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canResume, CLI_RESUME } from './cli-capabilities';

describe('CLI resume capability', () => {
  it('lets Claude mint its own session id', () => {
    expect(CLI_RESUME['Claude Code']).toEqual({ style: 'caller-minted', flag: '--resume' });
  });

  it('captures the id for Codex', () => {
    expect(CLI_RESUME.Codex.style).toBe('captured');
  });

  it('refuses Antigravity — 1.1.5 emits no id and silently forks on a stale one', () => {
    expect(canResume('Antigravity')).toBe(false);
  });

  it('refuses Vibe', () => {
    expect(canResume('Vibe')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/cli-capabilities.test.ts`
Expected: FAIL — `canResume is not a function`.

- [ ] **Step 3: Implement**

In `src/shared/cli-capabilities.ts`:

```ts
/**
 * Which CLIs can continue a previous session, and how the id is obtained.
 *
 * `caller-minted` means we generate the id and pass it on the first run
 * (Claude's `--session-id <uuid>`), so there is nothing to scrape and no
 * window where a run has no id. `captured` means the CLI assigns the id and
 * we read it out of its machine output (Codex `thread.started.thread_id`).
 *
 * Antigravity is deliberately absent: the installed 1.1.5 print mode emits no
 * conversation id at all, and handing it a stale id starts a fresh
 * conversation SILENTLY, which is worse than not reusing. Vibe is absent
 * because its resume depends on `log_interactions` staying enabled in the
 * user's own config, which we do not control.
 */
export const CLI_RESUME: Record<string, { style: 'caller-minted' | 'captured'; flag: string }> = {
  'Claude Code': { style: 'caller-minted', flag: '--resume' },
  Codex: { style: 'captured', flag: 'resume' },
};

export function canResume(adapterKey: string): boolean {
  return adapterKey in CLI_RESUME;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/cli-capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/cli-capabilities.ts src/shared/cli-capabilities.test.ts
git commit -m "Declare which CLI adapters can resume a session"
```

---

### Task 2: Store the vendor session id on the octipus session

**Files:**
- Modify: `src/db/schema/sessions.ts:65-110` (`SessionContext`)
- Create: `src/core/cli-session-store.ts`
- Modify: `src/core/gateway/commands.ts:383` (`/clear` must drop stored ids)
- Test: `src/core/cli-session-store.test.ts`

**Interfaces:**
- Consumes: `canResume` from Task 1; `sessionRepository` from `src/db/repositories/session-repository.ts`.
- Produces, all from `src/core/cli-session-store.ts`:
  - `type CliSessionRecord = { id: string; fingerprint: string; lastUsedAt: string; mcpConfigPath?: string }`
  - `fingerprintRun(run: { model?: string; permissionMode?: string; planMode?: boolean; workingDirectory?: string }): string`
  - `loadCliSession(sessionId: string, adapterKey: string, fingerprint: string): Promise<CliSessionRecord | null>`
  - `saveCliSession(sessionId: string, adapterKey: string, rec: CliSessionRecord): Promise<void>`
  - `dropCliSession(sessionId: string, adapterKey: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/core/cli-session-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fingerprintRun, loadCliSession, saveCliSession, dropCliSession } from './cli-session-store';

describe('fingerprintRun', () => {
  it('changes when the model changes', () => {
    const a = fingerprintRun({ model: 'sonnet', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' });
    const b = fingerprintRun({ model: 'opus', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' });
    expect(a).not.toBe(b);
  });

  it('changes when plan mode changes — resume cannot switch it', () => {
    const a = fingerprintRun({ model: 'sonnet', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' });
    const b = fingerprintRun({ model: 'sonnet', permissionMode: 'acceptEdits', planMode: true, workingDirectory: '/w' });
    expect(a).not.toBe(b);
  });

  it('is stable for identical runs', () => {
    const r = { model: 'sonnet', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' };
    expect(fingerprintRun(r)).toBe(fingerprintRun(r));
  });
});

describe('cli session store', () => {
  it('returns null when the stored fingerprint does not match', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    expect(await loadCliSession('s1', 'Claude Code', 'fp-b')).toBeNull();
  });

  it('round-trips a matching record', async () => {
    const rec = { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() };
    await saveCliSession('s1', 'Claude Code', rec);
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toMatchObject({ id: 'u1' });
  });

  it('forgets a dropped session', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    await dropCliSession('s1', 'Claude Code');
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toBeNull();
  });

  it('never returns another octipus session’s vendor session', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    expect(await loadCliSession('s2', 'Claude Code', 'fp-a')).toBeNull();
  });
});
```

Use the repository stubbing pattern the neighbouring `src/core/*.test.ts` files already use, so the test does not need a live database.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `SessionContext` in `src/db/schema/sessions.ts`:

```ts
  /**
   * Vendor CLI sessions this octipus session is continuing, keyed by adapter.
   * Scoped to the octipus session on purpose: a new octipus session finds an
   * empty map and therefore starts a new vendor session, which is the rule.
   */
  cliSessions?: Record<string, { id: string; fingerprint: string; lastUsedAt: string; mcpConfigPath?: string }>;
```

Create `src/core/cli-session-store.ts` with the five exports above. `fingerprintRun` is a SHA-256 over the four fields, hex-truncated to 16 chars — it only needs to detect change, not be reversible. `loadCliSession` reads `context.cliSessions?.[adapterKey]` and returns `null` unless the fingerprint matches exactly.

In `src/core/gateway/commands.ts:383`, where `/clear` sets `clearedAt`, also delete `cliSessions` — a cleared conversation must not continue in the vendor.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-session-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema/sessions.ts src/core/cli-session-store.ts src/core/cli-session-store.test.ts src/core/gateway/commands.ts
git commit -m "Store vendor CLI session ids on the octipus session"
```

---

### Task 3: Build resume arguments for Claude and Codex

**Files:**
- Modify: `src/core/cli-adapters.ts:387-412` (`build` dispatch), `:473-543` (`buildClaudeArgs`), `:596-662` (`buildCodexArgs`)
- Test: `src/core/cli-adapters.test.ts`

**Interfaces:**
- Consumes: `CLI_RESUME` from Task 1.
- Produces: `CLIArgumentBuilder.build(...)` accepts a new optional field on its options object, `resume?: { id: string; isFirstRun: boolean }`, and returns args that continue that session.

- [ ] **Step 1: Write the failing test**

Append to `src/core/cli-adapters.test.ts`:

```ts
describe('resume arguments', () => {
  it('mints the session id on the first Claude run', () => {
    const { args } = builder.build('Claude Code', 'hello', settings, [], 'agent-1', connection, { id: 'a3f1-uuid', isFirstRun: true });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('a3f1-uuid');
    expect(args).not.toContain('--resume');
  });

  it('resumes that id on later Claude runs', () => {
    const { args } = builder.build('Claude Code', 'hello', settings, [], 'agent-1', connection, { id: 'a3f1-uuid', isFirstRun: false });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('a3f1-uuid');
    expect(args).not.toContain('--session-id');
  });

  it('still passes --mcp-config on a resumed Claude run', () => {
    // Claude does not restore --mcp-config across resume.
    const { args } = builder.build('Claude Code', 'hello', settings, [], 'agent-1', connection, { id: 'a3f1-uuid', isFirstRun: false });
    expect(args).toContain('--mcp-config');
  });

  it('resumes a Codex thread and drops --ephemeral', () => {
    const { args } = builder.build('Codex', 'hello', settings, [], 'agent-1', connection, { id: 'thread-9', isFirstRun: false });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(args).not.toContain('--ephemeral');
  });

  it('leaves a first Codex run ephemeral-free so it can be resumed later', () => {
    const { args } = builder.build('Codex', 'hello', settings, [], 'agent-1', connection, { id: '', isFirstRun: true });
    expect(args).not.toContain('--ephemeral');
  });

  it('ignores resume for adapters that cannot do it', () => {
    const { args } = builder.build('Antigravity', 'hello', settings, [], 'agent-1', connection, { id: 'x', isFirstRun: false });
    expect(args).not.toContain('--conversation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-adapters.test.ts`
Expected: FAIL — `build` does not accept a resume argument.

- [ ] **Step 3: Implement**

Thread `resume` through `build` into the two builders.

In `buildClaudeArgs`, after the existing `-p` / output-format push:

```ts
    // Claude is the only CLI that lets the caller mint the id, so the first
    // run declares it and every later run resumes it. Nothing has to be
    // scraped, and there is no window in which a run has no id.
    if (resume) {
      args.push(resume.isFirstRun ? '--session-id' : '--resume', resume.id);
    }
```

Leave the `--mcp-config` push exactly where it is — it must be re-passed on resume — and leave `--append-system-prompt*` in place on the first run only, since Claude replays the recorded system prompt on resume (`--system-prompt-snapshot on`):

```ts
    if (systemMessages.length > 0 && (!resume || resume.isFirstRun)) {
      // Claude records the system prompt on the first request and replays it
      // verbatim on every resume; re-appending it would stack a second copy.
      ...existing code...
    }
```

In `buildCodexArgs`, when `resume` is present and not the first run, the argv becomes `['exec', 'resume', resume.id, ...]` instead of `['exec', ...]`; in every reuse case drop `--ephemeral`, because an ephemeral run is not resumable.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-adapters.test.ts src/core/cli-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-adapters.ts src/core/cli-adapters.test.ts
git commit -m "Build resume arguments for Claude and Codex runs"
```

---

### Task 4: Capture Codex's thread id through a parser callback

Claude needs no capture (we mint the id), but Codex assigns its own. The id is already parsed at `cli-adapters.ts:1042` and thrown away into an event payload.

**Files:**
- Modify: `src/core/cli-adapters.ts:666-691` (`CLIParserCallbacks`), `:1024-1044` (`parseCodexEvent`)
- Test: `src/core/cli-parser.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CLIParserCallbacks.onVendorSession?: (id: string) => void`, invoked once per run with the vendor's session/thread id. Task 5 supplies it.

- [ ] **Step 1: Write the failing test**

Append to `src/core/cli-parser.test.ts`:

```ts
it('reports the Codex thread id to the caller', () => {
  const seen: string[] = [];
  const parser = new CLIOutputParser('Codex', { onVendorSession: id => seen.push(id) });
  parser.handleLine(JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }));
  expect(seen).toEqual(['0199a213-81c0-7800-8aa1-bbab2a035a53']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-parser.test.ts`
Expected: FAIL — callback never invoked.

- [ ] **Step 3: Implement**

Add `onVendorSession?: (id: string) => void` to `CLIParserCallbacks` and call it from `parseCodexEvent` where `thread.started` is handled, next to the existing `emit('thought', ...)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-adapters.ts src/core/cli-parser.test.ts
git commit -m "Surface the Codex thread id through a parser callback"
```

---

### Task 5: Resume from the worker, with a cold fallback

**Files:**
- Modify: `src/core/cli-agent-worker.ts:607-700` (`executeCLI`), `:679-688` (`launchCleanup`), `:944-1049` (close handler)
- Modify: `src/config/settings-registry.ts` (add `cli.reuseSessions`)
- Test: `src/core/cli-agent-resume.test.ts` (create)

**Interfaces:**
- Consumes: `canResume` (Task 1); `loadCliSession` / `saveCliSession` / `dropCliSession` / `fingerprintRun` (Task 2); the `resume` build argument (Task 3); `onVendorSession` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `src/core/cli-agent-resume.test.ts`:

```ts
describe('CLI session reuse', () => {
  it('starts fresh and stores the id on the first turn', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question');
    expect(await loadCliSession('s1', 'Claude Code', worker.fingerprint)).toMatchObject({ id: expect.any(String) });
  });

  it('resumes the stored id on the second turn', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question');
    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await second.run('second question');
    expect(second.lastArgs).toContain('--resume');
  });

  it('falls back to a cold run and forgets the id when the session is gone', async () => {
    // Claude: "No conversation found with session ID: <id>", non-zero exit.
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, failFirstWith: 'No conversation found with session ID: dead' });
    const answer = await worker.run('question');
    expect(answer).not.toBe('');                               // the turn is not lost
    expect(worker.runCount).toBe(2);                           // cold retry happened
    expect(await loadCliSession('s1', 'Claude Code', worker.fingerprint)).toBeNull();
  });

  it('does not resume when the model changed', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, model: 'sonnet' });
    await worker.run('first');
    const other = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, model: 'opus' });
    await other.run('second');
    expect(other.lastArgs).not.toContain('--resume');
  });

  it('does not resume when the setting is off', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: false });
    await worker.run('first');
    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: false });
    await second.run('second');
    expect(second.lastArgs).not.toContain('--resume');
  });
});
```

Build the worker fixture on the spawn-stubbing pattern already used by `src/core/cli-agent-bridge.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-agent-resume.test.ts`
Expected: FAIL — no resume behaviour exists.

- [ ] **Step 3: Implement**

Register the setting in `src/config/settings-registry.ts`:

```ts
    {
      key: 'cli.reuseSessions',
      default: false,
      description: 'Continue the same vendor CLI session across turns of one octipus session (Claude Code, Codex). Off re-runs each turn from scratch.',
    },
```

In `executeCLI`, before building args: when the setting is on and `canResume(adapterKey)`, compute `fingerprintRun({ model, permissionMode, planMode, workingDirectory })`, load the record, and build `resume` — `{ id: existing?.id ?? randomUUID(), isFirstRun: !existing }` for Claude, `{ id: existing.id, isFirstRun: false }` only when a record exists for Codex. Pass `onVendorSession` so a captured id is stored via `saveCliSession`. For Claude, store the minted id as soon as the process starts, together with the `mcpConfigPath` that run used.

In the close handler, detect a dead session from the vendor's own error text before the generic non-zero-exit rejection:

```ts
        // Claude: "No conversation found with session ID: <id>".
        // Codex: resume errors out rather than silently starting a new thread.
        if (resume && !resume.isFirstRun && /no conversation found|session not found/i.test(stderrTail)) {
          await dropCliSession(sessionId, adapterKey);
          modelLogger.warn({ adapterKey, id: resume.id }, 'Vendor CLI session is gone — retrying cold with the full prompt');
          resolve(this.executeCLI({ ...opts, forceCold: true }));
          return;
        }
```

`forceCold` skips the resume lookup and restores the full-history prompt for that one run.

In `launchCleanup`, keep the MCP config file when its path is recorded on a stored session, and sweep it in the existing stale-file sweep instead.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-agent-resume.test.ts src/core/cli-agent-bridge.test.ts src/core/cli-agent-detach.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-agent-worker.ts src/config/settings-registry.ts src/core/cli-agent-resume.test.ts
git commit -m "Resume the vendor CLI session across turns, with a cold fallback"
```

---

### Task 6: Send only the delta when resuming

Without this task resume costs *more*, not less: the vendor holds the history and octipus re-sends it anyway.

**Files:**
- Modify: `src/core/cli-agent-worker.ts:282-293` (`loadHistory`), `:553-566` (`buildPrompt`)
- Modify: `src/core/agent/root-runner.ts:388-420`
- Test: `src/core/cli-agent-resume.test.ts`

**Interfaces:**
- Consumes: the resume state from Task 5.
- Produces: `willResumeCliSession(sessionId: string, adapterKey: string, fingerprint: string): Promise<boolean>` exported from `src/core/cli-session-store.ts`, so root-runner can decide before assembling the prompt.

- [ ] **Step 1: Write the failing test**

Append to `src/core/cli-agent-resume.test.ts`:

```ts
it('sends only the new turn once the vendor holds the history', async () => {
  const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, history: ['old question', 'old answer'] });
  await worker.run('first');
  const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, history: ['old question', 'old answer', 'first'] });
  await second.run('second question');
  expect(second.lastPrompt).toContain('second question');
  expect(second.lastPrompt).not.toContain('old question');
});

it('sends the full transcript on a cold run', async () => {
  const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, history: ['old question', 'old answer'] });
  await worker.run('first');
  expect(worker.lastPrompt).toContain('old question');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-agent-resume.test.ts`
Expected: FAIL — the resumed prompt still contains the whole transcript.

- [ ] **Step 3: Implement**

In `buildPrompt()`, when the run is resuming, emit only this turn's user message and the run-context block:

```ts
    // The vendor session already holds every earlier turn. Re-sending them
    // would pay for the same history twice — once in our prompt and again in
    // the vendor's own replay — which is the whole cost this change removes.
    if (this.resuming) {
      return [runContextBlock, currentUserMessage].filter(Boolean).join('\n\n');
    }
```

Skip `loadHistory()` entirely on a resuming run.

In `src/core/agent/root-runner.ts`, call `willResumeCliSession(...)` before assembling and, when it is true, omit the "Previous conversation summary" block (`:399-402`) and the "Recent conversation history" block (`:405-420`) from `volatileParts`. Keep every other volatile block — date, memory, security reminder — since those change per turn and the vendor's snapshot is stale for them.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-agent-resume.test.ts src/core/agent/root-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-agent-worker.ts src/core/agent/root-runner.ts src/core/cli-session-store.ts src/core/cli-agent-resume.test.ts
git commit -m "Send only the new turn to a resumed CLI session"
```

---

### Task 7: Keep the token counter honest across invocations

`CLIOutputParser.reportedTokens` resets with each new parser (`cli-agent-worker.ts:700`), while a resumed Claude session reports usage cumulatively for the session. Left alone, turn two counts turn one again.

**Files:**
- Modify: `src/core/cli-adapters.ts:908-946` (result reconciliation), `:1007-1022` (`reportClaudeUsage`)
- Modify: `src/core/cli-agent-worker.ts:696-745`
- Test: `src/core/cli-parser.test.ts`

**Interfaces:**
- Consumes: `billableTokens` from the accounting plan, Task 4.
- Produces: `CLIOutputParser` accepts `seedReportedTokens: number` in its options, so a resumed run starts its reconciliation from what the session already reported.

- [ ] **Step 1: Write the failing test**

Append to `src/core/cli-parser.test.ts`:

```ts
it('does not re-count usage a resumed session replays', () => {
  const seen: number[] = [];
  // Turn one already reported 310 tokens for this vendor session.
  const parser = new CLIOutputParser('Claude Code', { onTokenUsage: u => seen.push(u.total) }, { seedReportedTokens: 310 });
  // Turn two's result event reports the session-cumulative 450.
  parser.handleLine(JSON.stringify({ type: 'result', usage: { input_tokens: 40, output_tokens: 100, cache_read_input_tokens: 310, cache_creation_input_tokens: 0 } }));
  expect(seen).toEqual([140]); // 450 - 310, not 450
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-parser.test.ts`
Expected: FAIL — reports 450.

- [ ] **Step 3: Implement**

Accept `seedReportedTokens` in the parser options and initialise `this.reportedTokens` from it. In `cli-agent-worker.ts`, persist the per-vendor-session reported total alongside the session id (extend `CliSessionRecord` with `reportedTokens: number`) and seed each resumed run's parser from it, updating it at run end — the same treatment `pastParserCounters` already gets for side-effect counters at `:247-253`.

Also guard the turn counter: Claude's `num_turns` is session-cumulative on a resumed session, so `onTurnCount` must apply a delta against the seeded value rather than adding the raw number to `this.iteration` (`:722`, `:730`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-parser.test.ts src/core/cli-agent-resume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-adapters.ts src/core/cli-agent-worker.ts src/core/cli-parser.test.ts
git commit -m "Seed CLI usage reconciliation from the resumed session"
```

---

### Task 8: Pipe octipus compaction through to the vendor

Octipus compacts its own copy of a history the vendor still holds in full (`session-compaction.ts:92`, fired after every root turn). Claude can be compacted non-interactively; Codex cannot, so its thread is rotated instead and the next run is seeded from the summary.

**Files:**
- Modify: `src/core/agent/session-compaction.ts:144-240`
- Create: `src/core/cli-session-compact.ts`
- Test: `src/core/cli-session-compact.test.ts`

**Interfaces:**
- Consumes: `loadCliSession` / `dropCliSession` (Task 2), `CLI_RESUME` (Task 1).
- Produces: `compactVendorSession(sessionId: string, adapterKey: string, instructions?: string): Promise<'compacted' | 'rotated' | 'skipped'>` from `src/core/cli-session-compact.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/core/cli-session-compact.test.ts`:

```ts
describe('compactVendorSession', () => {
  it('sends /compact to a live Claude session', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp', lastUsedAt: new Date().toISOString() });
    const result = await compactVendorSession('s1', 'Claude Code', 'focus on the migration');
    expect(result).toBe('compacted');
    expect(spawned.lastArgs).toContain('--resume');
    expect(spawned.lastPrompt).toBe('/compact focus on the migration');
  });

  it('rotates a Codex thread, which cannot be compacted non-interactively', async () => {
    await saveCliSession('s1', 'Codex', { id: 't1', fingerprint: 'fp', lastUsedAt: new Date().toISOString() });
    expect(await compactVendorSession('s1', 'Codex')).toBe('rotated');
    expect(await loadCliSession('s1', 'Codex', 'fp')).toBeNull();
  });

  it('skips when there is no live vendor session', async () => {
    expect(await compactVendorSession('s-none', 'Claude Code')).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cli-session-compact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/cli-session-compact.ts`. For Claude, run `claude -p --resume <id> "/compact <instructions>"` through the same guarded `execCli` path as any other CLI completion, so it is subject to the concurrency gate and the kill-tree timeout. For Codex and anything else, drop the stored id and return `'rotated'`; the next turn starts a fresh vendor session whose prompt includes the octipus compaction summary through the normal cold path.

Call it from `compactSessionContext` after the `compaction_entries` row is written, passing `userInstructions`, and record the outcome on that row's metadata so a rotation is auditable. Failure is non-fatal: log and continue, exactly as the existing entry-write failure does at `:237-239`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/cli-session-compact.test.ts src/core/agent/session-compaction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-session-compact.ts src/core/cli-session-compact.test.ts src/core/agent/session-compaction.ts
git commit -m "Pipe octipus compaction through to the vendor CLI session"
```

---

### Task 9: Fix the channel event that mistakes a vendor id for an octipus id

`src/channels/index.ts:601` computes `data.sessionId || event.sessionId`, but for CLI `thought` events `data.sessionId` is the *vendor* session id, so the `!== resolvedSessionId` comparison at `:602` fails and channel typing indicators are dropped for every CLI run. Reuse makes these ids longer-lived and the confusion worse.

**Files:**
- Modify: `src/core/cli-adapters.ts:838-841`, `:926-939` (rename the event field)
- Modify: `src/channels/index.ts:601`
- Test: `src/channels/index.test.ts` (or the nearest existing channel test)

**Interfaces:**
- Consumes: nothing.
- Produces: CLI `thought` events carry `vendorSessionId` instead of `sessionId`.

- [ ] **Step 1: Write the failing test**

Assert that a CLI `thought` event carrying a vendor id still reaches the channel for the octipus session it belongs to:

```ts
it('does not drop a channel event because the CLI reported its own session id', () => {
  const delivered = deliverThought({ sessionId: 'octipus-1' }, { vendorSessionId: 'vendor-9', status: 'running' });
  expect(delivered).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/index.test.ts`
Expected: FAIL — the event is filtered out.

- [ ] **Step 3: Implement**

Rename the field at both Claude emit sites and the Codex one to `vendorSessionId`, and drop `data.sessionId` from the comparison in `src/channels/index.ts:601`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/channels src/core/cli-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli-adapters.ts src/channels/index.ts
git commit -m "Stop mistaking a vendor CLI session id for an octipus session id"
```

---

### Task 10: End-to-end verification and documentation

- [ ] **Step 1: Typecheck and full suite**

Run: `npx tsc --noEmit -p tsconfig.json` then `npx vitest run src/core src/models src/channels`
Expected: no errors, PASS.

- [ ] **Step 2: Exercise a real session**

Enable `cli.reuseSessions`, ask a CLI-backed agent four questions in one octipus session, and confirm from the logs that: run one passes `--session-id`, runs two to four pass `--resume` with the same id, each prompt after the first contains only the new question, and the reported per-turn token totals do not restate earlier turns.

- [ ] **Step 3: Confirm a new octipus session starts fresh**

Start a second octipus session and confirm its first run passes a different `--session-id`.

- [ ] **Step 4: Document it**

Add a "Session reuse" section to `docs/CLI-AGENTS.md`: which CLIs support it and why the other two do not, the `cli.reuseSessions` setting, what invalidates a vendor session, and the fact that resume saves octipus from re-sending context but does not stop the vendor from re-reading its own history.

- [ ] **Step 5: Commit**

```bash
git add docs/CLI-AGENTS.md
git commit -m "Document CLI session reuse"
```
