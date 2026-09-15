/**
 * Task 5: the worker resumes the vendor CLI session across turns of one
 * octipus session when cli.reuseSessions is on, with a cold fallback when
 * the vendor reports the stored session is gone.
 *
 * Spawn-stubbing pattern lifted from cli-agent-bridge.test.ts: `spawn` is
 * mocked to launch a small Node script standing in for the real `claude`
 * binary, so the worker's actual arg-building / close-handling code runs
 * unmodified. The fake binary runs with cwd = the session's workspace (a
 * devMode `projectPath`, per WorkspaceFS.forSession), so a fixed marker file
 * there — not an env var, which the worker's allowlisted child env would
 * strip — tells it whether to fail this invocation.
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIAgentWorker } from './cli-agent-worker';
import { fingerprintRun, loadCliSession } from './cli-session-store';
import type { AgentContext } from './types';
import type { SessionContext } from '@/db/schema/sessions';

const fixture = vi.hoisted(() => ({
  script: '',
  codexScript: '',
  dir: '',
  reuseSessions: false,
  cliAgent: {} as { model?: string; permissionMode?: string },
  spawnCount: 0,
  sessions: new Map<string, { id: string; userId: string; context: SessionContext }>(),
  history: [] as string[],
}));

vi.mock('@/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@/config')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), cli: { reuseSessions: fixture.reuseSessions } }) };
});
function mockChildProcess(actual: typeof import('child_process')) {
  return {
    ...actual,
    // discoverCodexMcpServers shells out to `codex mcp list --json` before the
    // worker ever spawns codex itself; stub it so the test doesn't need a
    // real codex install.
    execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out: string) => void) => {
      if (cmd === 'codex' && args[0] === 'mcp') { cb(null, '[]'); return; }
      return actual.execFile(cmd, args, opts as object, cb as (...a: unknown[]) => void);
    },
    spawn: (binary: string, args: string[], opts: object) => {
      const script = binary === 'claude' ? fixture.script : binary === 'codex' ? fixture.codexScript : null;
      if (!script) throw new Error(`Unexpected CLI invocation: ${binary}`);
      fixture.spawnCount++;
      const shell = (opts as { shell?: boolean }).shell === true;
      const quote = (p: string) => (shell && /\s/.test(p) ? `"${p}"` : p);
      return actual.spawn(quote(process.execPath), [quote(script), ...args], opts);
    },
  };
}
// cli-agent-worker.ts imports 'child_process'; cli-adapters.ts (discoverCodexMcpServers)
// imports 'node:child_process' — mock both specifiers, same stub.
vi.mock('child_process', async importOriginal => mockChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('node:child_process', async importOriginal => mockChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({ getModel: async () => ({ metadata: { cliAgent: fixture.cliAgent } }), getModelByModelId: async () => ({}) }),
}));
vi.mock('@/models/quota-tracker', () => ({ getQuotaTracker: () => ({ getStatus: async () => ({ exhausted: false }) }) }));
vi.mock('@/core/agent-task-recorder', () => ({ recordAgentCompletion: async () => {} }));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: {
    findById: async (id: string) => {
      const row = fixture.sessions.get(id);
      return row ? { ...row } : undefined;
    },
    update: async (id: string, data: { context?: SessionContext }) => {
      const row = fixture.sessions.get(id);
      if (!row) return null;
      if (data.context !== undefined) row.context = data.context;
      return { ...row };
    },
    incrementMessageCount: async () => {},
  },
}));
vi.mock('@/db/repositories/work-plan-repository', () => ({ workPlanRepository: { read: async () => ({ current: null, revision: 0, previous: [] }) } }));
vi.mock('@/db/repositories/message-repository', () => ({
  messageRepository: {
    create: async () => ({}),
    // Turn n's `history` fixture is that turn's view of everything said so
    // far — alternating user/assistant, oldest first — matching what a real
    // messageRepository row-per-turn history would look like.
    findBySession: async () => fixture.history.map((content, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content, createdAt: new Date(),
    })),
  },
}));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { updateStatus: async () => {} } }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: new Proxy({}, { get: () => async () => {} }) }));
vi.mock('@/db/repositories/tool-action-repository', () => ({ toolActionRepository: { pending: async () => [], start: async () => {}, finish: async () => {} } }));
vi.mock('@/models/cost-tracker', () => ({ getCostTracker: () => ({ logUsageWithCost: async () => {} }) }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW' }), cancelWaits: () => {}, requestApproval: async () => 'approval', waitForApproval: async () => false, onWaitStateChange: () => () => {} }) }));
vi.mock('@/hooks/manager', () => ({ getHookManager: () => ({ triggerToolHooks: async () => ({ decision: 'allow' }) }) }));

function makeSession(sessionId: string, dir: string) {
  if (!fixture.sessions.has(sessionId)) {
    fixture.sessions.set(sessionId, { id: sessionId, userId: 'u', context: { devMode: true, projectPath: dir } as SessionContext });
  }
}

function makeWorker(model: string, opts: { sessionId: string; reuseSessions: boolean; model?: string; permissionMode?: string; history?: string[]; maxTokenBudget?: number }) {
  fixture.reuseSessions = opts.reuseSessions;
  fixture.cliAgent = { model: opts.model, permissionMode: opts.permissionMode };
  fixture.history = opts.history ?? [];
  makeSession(opts.sessionId, fixture.dir);

  const context: AgentContext = {
    id: `agent-${opts.sessionId}-${Math.random().toString(36).slice(2)}`,
    sessionId: opts.sessionId, userId: 'u', workspaceId: 'w', root: true,
    model, role: 'general', topic: 'general', status: 'idle',
    createdAt: new Date(), updatedAt: new Date(), metadata: {},
  };
  const worker = new CLIAgentWorker(context, { maxIterations: 5, maxTokenBudget: opts.maxTokenBudget ?? 10000, timeout: 10000, contextWindowSize: 10000 });
  const stdinFile = join(fixture.dir, 'claude-last-stdin.txt');

  return {
    worker,
    // Mirrors agent-manager.createAgent: loadHistory() runs once, before the
    // turn's message is added and the worker is run.
    run: async (message: string) => {
      await worker.loadHistory();
      return worker.run(message);
    },
    fingerprint: fingerprintRun({ model: opts.model, permissionMode: opts.permissionMode, planMode: false, workingDirectory: fixture.dir }),
    // What actually reached the vendor CLI over stdin (claude, with an
    // active bridge, always sends the prompt as a stream-json 'user' message).
    get lastPrompt(): string {
      const raw = readFileSync(stdinFile, 'utf-8');
      return (JSON.parse(raw) as { message: { content: string } }).message.content;
    },
  };
}

const makeClaudeWorker = (opts: { sessionId: string; reuseSessions: boolean; model?: string; permissionMode?: string; history?: string[]; maxTokenBudget?: number }) => makeWorker('cli/claude-code', opts);
const makeCodexWorker = (opts: { sessionId: string; reuseSessions: boolean; model?: string; permissionMode?: string }) => makeWorker('cli/codex', opts);

const failMarker = () => join(fixture.dir, 'fail-marker');

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), 'octipus-cli-resume-'));
  fixture.script = join(fixture.dir, 'fake-claude.mjs');
  fixture.codexScript = join(fixture.dir, 'fake-codex.mjs');
  fixture.sessions = new Map();
  fixture.spawnCount = 0;
  writeFileSync(fixture.script, `
    import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const sessionIdx = args.indexOf('--session-id');
    const resumeIdx = args.indexOf('--resume');
    const idArg = sessionIdx >= 0 ? args[sessionIdx + 1] : resumeIdx >= 0 ? args[resumeIdx + 1] : null;
    const marker = join(process.cwd(), 'fail-marker');
    if (existsSync(marker)) {
      const text = readFileSync(marker, 'utf-8');
      unlinkSync(marker);
      process.stderr.write(text);
      process.exit(1);
    }
    // Captures the real stream-json 'user' message written to stdin — the
    // actual prompt sent to the vendor, not a value the worker hands the test
    // directly — so the resume/cold assertions verify the real spawn seam.
    let stdinData = '';
    process.stdin.on('data', c => { stdinData += c; });
    process.stdin.on('end', () => { writeFileSync(join(process.cwd(), 'claude-last-stdin.txt'), stdinData); });
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'answer for ' + idArg, num_turns: 1 }));
  `);
  // Codex mints its own thread id — it never appears as a CLI argument on a
  // first run (no --resume yet), so the fake binary generates one and reports
  // it via thread.started, exactly like the real vendor.
  writeFileSync(fixture.codexScript, `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    // Dumped so the test can assert on the real argv the worker built
    // (whether --ephemeral is present, whether it's 'exec resume <id>').
    writeFileSync(join(process.cwd(), 'codex-last-args.json'), JSON.stringify(args));
    const resumeIdx = args.indexOf('resume');
    const resumedId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
    const threadId = resumedId || 'codex-thread-' + Math.random().toString(36).slice(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer for ' + threadId } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  `);
});

afterEach(() => { try { unlinkSync(failMarker()); } catch { /* not there */ } rmSync(fixture.dir, { recursive: true, force: true }); });

describe('CLI session reuse', () => {
  it('starts fresh and stores the id on the first turn', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question');
    const stored = await loadCliSession('s1', 'Claude Code', worker.fingerprint);
    expect(stored).toMatchObject({ id: expect.any(String) });
  });

  it('resumes the stored id on the second turn', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question');
    const first = await loadCliSession('s1', 'Claude Code', worker.fingerprint);

    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    const answer = await second.run('second question');
    const stored = await loadCliSession('s1', 'Claude Code', second.fingerprint);

    expect(stored).toMatchObject({ id: expect.any(String) });
    // The vendor id is stable across turns (the second run resumed it, not
    // minted a new one) and the fake CLI echoes back whichever id argument it
    // was actually given.
    expect(stored!.id).toBe(first!.id);
    expect(answer).toContain(first!.id);
  });

  it('falls back to a cold run and forgets the id when the session is gone', async () => {
    writeFileSync(failMarker(), 'No conversation found with session ID: dead', 'utf-8');
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    const before = fixture.spawnCount;
    const answer = await worker.run('question');
    expect(answer).not.toBe('');
    expect(fixture.spawnCount - before).toBe(2); // cold retry happened
    expect(await loadCliSession('s1', 'Claude Code', worker.fingerprint)).toBeNull();
  });

  it('does not resume when the model changed', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, model: 'sonnet' });
    await worker.run('first');
    const sonnetRecord = await loadCliSession('s1', 'Claude Code', worker.fingerprint);

    const other = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, model: 'opus' });
    const answer = await other.run('second');
    const opusRecord = await loadCliSession('s1', 'Claude Code', other.fingerprint);

    // Different fingerprint => no record yet => a freshly minted id, not a resume.
    expect(opusRecord!.id).not.toBe(sonnetRecord!.id);
    expect(answer).toContain(opusRecord!.id);
  });

  it('does not resume when the setting is off', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: false });
    await worker.run('first');
    expect(await loadCliSession('s1', 'Claude Code', worker.fingerprint)).toBeNull();
    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: false });
    await second.run('second');
    expect(await loadCliSession('s1', 'Claude Code', second.fingerprint)).toBeNull();
  });

  // Codex is 'captured' style (CLI_RESUME): the worker never mints an id for
  // it, so the first run must still participate in reuse (no --ephemeral)
  // and store whatever id the vendor reports via thread.started — otherwise
  // every Codex run is thrown away as ephemeral and reuse can never engage.
  const lastCodexArgs = (): string[] => JSON.parse(readFileSync(join(fixture.dir, 'codex-last-args.json'), 'utf-8'));

  it('leaves a first Codex run resumable (no --ephemeral) and stores the captured thread id', async () => {
    const worker = makeCodexWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question');
    expect(lastCodexArgs()).not.toContain('--ephemeral');
    const stored = await loadCliSession('s1', 'Codex CLI', worker.fingerprint);
    expect(stored).toMatchObject({ id: expect.any(String) });
    expect(stored!.id).not.toBe('');
  });

  it('resumes the captured Codex thread on the second turn', async () => {
    const worker = makeCodexWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question');
    const first = await loadCliSession('s1', 'Codex CLI', worker.fingerprint);

    const second = makeCodexWorker({ sessionId: 's1', reuseSessions: true });
    const answer = await second.run('second question');
    const stored = await loadCliSession('s1', 'Codex CLI', second.fingerprint);

    expect(lastCodexArgs().slice(0, 3)).toEqual(['exec', 'resume', first!.id]);
    // The captured id is unchanged across turns (the fake codex echoes back
    // the id it was told to resume) — proof the second run issued
    // `exec resume <id>` rather than starting a fresh ephemeral thread.
    expect(stored!.id).toBe(first!.id);
    expect(answer).toContain(first!.id);
  });

  // Task 6: once the vendor holds a turn, octipus must stop re-sending it —
  // paying for the same history twice (our prompt + the vendor's own replay)
  // is what makes resume cost MORE than not reusing at all.
  it('sends only the new turn once the vendor holds the history', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, history: ['old question', 'old answer'] });
    await worker.run('first');
    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, history: ['old question', 'old answer', 'first'] });
    await second.run('second question');
    expect(second.lastPrompt).toContain('second question');
    expect(second.lastPrompt).not.toContain('old question');
  });

  // Task 7 fix round 1: cross-process token subtraction was reverted (see
  // task-7-report.md). The real defect was that CLIAgentWorker had no
  // context-vs-spend split at all — the budget kill-switch compared the
  // grand total, which would SIGKILL a well-cached resumed session that
  // replays its whole history as cheap cache reads. These tests cover the
  // fix: getTotalTokens() (context proxy) counts everything the model read,
  // cache reads included; getBillableTokens() (spend proxy) counts only
  // fresh input + output.
  function usageScript(freshInputResumed: number, outputResumed: number, cacheReadResumed: number) {
    return `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const args = process.argv.slice(2);
      const sessionIdx = args.indexOf('--session-id');
      const resumeIdx = args.indexOf('--resume');
      const idArg = sessionIdx >= 0 ? args[sessionIdx + 1] : resumeIdx >= 0 ? args[resumeIdx + 1] : null;
      let stdinData = '';
      process.stdin.on('data', c => { stdinData += c; });
      process.stdin.on('end', () => { writeFileSync(join(process.cwd(), 'claude-last-stdin.txt'), stdinData); });
      const usage = resumeIdx >= 0
        ? { input_tokens: ${freshInputResumed}, output_tokens: ${outputResumed}, cache_read_input_tokens: ${cacheReadResumed}, cache_creation_input_tokens: 0 }
        : { input_tokens: 60, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'answer for ' + idArg, num_turns: 1, usage }));
    `;
  }

  it('splits context (grand total) from spend (fresh + output) on a resumed run with heavy cache reads', async () => {
    writeFileSync(fixture.script, usageScript(50, 100, 2000));
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await worker.run('first question'); // cold: 60 + 40, no cache
    expect(worker.worker.getTotalTokens()).toBe(100);
    expect(worker.worker.getBillableTokens()).toBe(100);

    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: true });
    await second.run('second question'); // resumed: 50 + 100 + 2000 cache read
    expect(second.worker.getTotalTokens()).toBe(2150); // grand total, cache reads included
    expect(second.worker.getBillableTokens()).toBe(150); // 50 + 100 only, cache read excluded
  });

  it('does not trip maxTokenBudget on a resumed run that is almost entirely cache reads', async () => {
    // Fresh + output is 100 — nowhere near the 200 cap. Grand total is 5100,
    // far past it. Without the getBillableTokens() override the kill-switch
    // compared the grand total and would SIGKILL this run.
    writeFileSync(fixture.script, usageScript(50, 50, 5000));
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, maxTokenBudget: 200 });
    await worker.run('first question');

    const second = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, maxTokenBudget: 200 });
    const answer = await second.run('second question');
    expect(answer).not.toBe('');
    expect(second.worker.getTotalTokens()).toBe(5100);
    expect(second.worker.getBillableTokens()).toBe(100);
  });

  // Task 7 fix round 2: the `result`-event fallback used to emit RAW
  // full-run input/output/cacheRead alongside a delta-scoped `total` — so
  // whenever per-message tracking under-reported and the fallback bridged
  // the gap, getBillableTokens() was bumped by roughly the WHOLE run's
  // fresh+output a second time, on top of what per-message tracking had
  // already billed. Fails against the code from fix round 1: it would
  // assert 270 (120 already billed + 150 raw-fallback bill) instead of 150.
  it('bills only the shortfall when the result event bridges an under-report', async () => {
    writeFileSync(fixture.script, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      let stdinData = '';
      process.stdin.on('data', c => { stdinData += c; });
      process.stdin.on('end', () => { writeFileSync(join(process.cwd(), 'claude-last-stdin.txt'), stdinData); });
      // Per-message tracking reports 100 fresh input + 20 output for this turn.
      console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 100, output_tokens: 20 } } }));
      // The result event reports the whole run: same 100 fresh input, 900 NEW
      // cache-read tokens, and 30 more output than per-message tracking saw
      // (50 total vs 20 already reported) — a genuine under-report.
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', num_turns: 1, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }));
    `);
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: false });
    await worker.run('question');
    // Grand total: 100 fresh + 50 output + 900 cache read = 1050.
    expect(worker.worker.getTotalTokens()).toBe(1050);
    // Billable: 100 fresh + 50 output = 150 for the whole run — the
    // shortfall the fallback bridges (0 new fresh, 30 new output, 900 cache
    // read excluded) added to what per-message tracking already billed
    // (100 fresh + 20 output = 120), not 120 + (1000 - 900) fresh again.
    expect(worker.worker.getBillableTokens()).toBe(150);
  });

  it('sends the full transcript on a cold run', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', reuseSessions: true, history: ['old question', 'old answer'] });
    await worker.run('first');
    expect(worker.lastPrompt).toContain('old question');
  });
});
