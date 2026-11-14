vi.mock('@/security/credential-redaction', () => ({ redactAgentDiagnostics: async (_user: string, _workspace: string, data: unknown) => data }));
vi.mock('./cli-executable', () => ({ configuredCliBinary: (binary: string) => binary }));
/**
 * Task 5: the worker resumes the vendor CLI session across turns of one
 * octipus session for every adapter the capability table marks resumable
 * (always on — no setting gates it), with a cold fallback when the vendor
 * reports the stored session is gone.
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
// Not under test here: the install-model gate (install-access.isolation.test.ts) lets these fake ids through.
vi.mock('@/models/install-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/models/install-access')>()),
  mayUseInstallModels: async () => true,
  assertInstallModelAccess: async () => {},
}));
import { boundColdHistory, CLIAgentWorker } from './cli-agent-worker';
import { childCliSessionKey, claimCliSession, cliSessionHolder, fingerprintRun, loadCliSession, releaseCliSessions } from './cli-session-store';
import type { AgentContext } from './types';
import type { SessionContext } from '@/db/schema/sessions';

const fixture = vi.hoisted(() => ({
  script: '',
  codexScript: '',
  museScript: '',
  dir: '',
  cliAgent: {} as { model?: string; permissionMode?: string },
  spawnCount: 0,
  quotaExhausted: false,
  sessions: new Map<string, { id: string; userId: string; context: SessionContext }>(),
  history: [] as string[],
}));

function mockChildProcess(actual: typeof import('child_process')) {
  return {
    ...actual,
    // discoverCodexMcpServers shells out to `codex mcp list --json` before the
    // worker ever spawns codex itself; stub it so the test doesn't need a
    // real codex install.
    execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out: string) => void) => {
      if (cmd === 'codex' && args[0] === 'mcp') { cb(null, '[]'); return; }
      if (cmd === 'muse' && args[0] === 'skills') { cb(null, JSON.stringify({ skills: [{ scope: 'bundled', path: 'bundled://muse-core/skills/git/SKILL.md', activation: 'on' }] })); return; }
      return actual.execFile(cmd, args, opts as object, cb as (...a: unknown[]) => void);
    },
    spawn: (binary: string, args: string[], opts: object) => {
      const script = binary === 'claude' || binary === 'agy' || binary === 'vibe' ? fixture.script : binary === 'codex' ? fixture.codexScript : binary === 'muse' ? fixture.museScript : null;
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
vi.mock('@/db/repositories/inline-ui-repository', () => ({ inlineUiRepository: {
  countForSession: async () => 0,
  create: async (row: Record<string, unknown>) => ({ ...row, id: '11111111-1111-4111-8111-111111111111' }),
} }));
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({ getModel: async () => ({ metadata: { cliAgent: fixture.cliAgent } }), getModelByModelId: async () => ({}) }),
}));
vi.mock('@/models/quota-tracker', () => ({ cliQuotaKey: (provider: string) => provider, getQuotaTracker: () => ({
  getStatus: async () => ({ exhausted: fixture.quotaExhausted }),
  markExhausted: async () => { fixture.quotaExhausted = true; },
}) }));
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
    // Mirrors the real jsonb patch: touch one key, leave every sibling alone.
    setContextKey: async (id: string, path: string[], value: unknown) => {
      const row = fixture.sessions.get(id);
      if (!row) return;
      let node = row.context as Record<string, unknown>;
      for (const seg of path.slice(0, -1)) {
        if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
        node = node[seg] as Record<string, unknown>;
      }
      const leaf = path[path.length - 1];
      if (value === undefined) delete node[leaf];
      else node[leaf] = value;
    },
    patchContextIfGeneration: async (id: string, generation: string, patch: Record<string, unknown>) => {
      const row = fixture.sessions.get(id);
      if (!row || (row.context.conversationGeneration ?? row.context.clearedAt ?? '') !== generation) return false;
      Object.assign(row.context, patch); return true;
    },
    // Mirrors the real per-key write: one cliSessions entry, generation-checked.
    setContextKeyIfGeneration: async (id: string, generation: string, path: string[], value: unknown) => {
      const row = fixture.sessions.get(id);
      if (!row || (row.context.conversationGeneration ?? row.context.clearedAt ?? '') !== generation) return false;
      const map = { ...row.context.cliSessions } as Record<string, unknown>;
      if (value === undefined) delete map[path[1]]; else map[path[1]] = value;
      row.context.cliSessions = map as SessionContext['cliSessions']; return true;
    },
    incrementMessageCount: async () => {},
  },
}));
vi.mock('@/db/repositories/work-plan-repository', () => ({ workPlanRepository: { read: async () => ({ current: null, revision: 0, previous: [] }) } }));
vi.mock('@/db/repositories/message-repository', () => ({
  messageRepository: {
    create: async (data: { content: string }) => {
      fixture.history.push(data.content);
      const index = fixture.history.length - 1;
      return { id: `message-${index}`, createdAt: new Date(1700000000000 + index * 1000) };
    },
    findContextMessages: async (_id: string, since?: string, after?: { createdAt: string }) => fixture.history.map((content, i) => ({
      id: `message-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content, createdAt: new Date(1700000000000 + i * 1000),
    })).filter(m => (!since || m.createdAt >= new Date(since)) && (!after || m.createdAt > new Date(after.createdAt))),
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

function makeWorker(model: string, opts: { sessionId: string; model?: string; permissionMode?: string; history?: string[]; maxTokenBudget?: number; inlineUiOffered?: boolean }) {
  fixture.cliAgent = { model: opts.model, permissionMode: opts.permissionMode };
  fixture.history = opts.history ?? [];
  makeSession(opts.sessionId, fixture.dir);

  const context: AgentContext = { space: null, trigger: 'user', funding: 'own', 
    id: `agent-${opts.sessionId}-${Math.random().toString(36).slice(2)}`,
    sessionId: opts.sessionId, userId: 'u', workspaceId: 'w', root: true,
    model, role: 'general', topic: 'general', status: 'idle',
    createdAt: new Date(), updatedAt: new Date(), metadata: { inlineUiOffered: opts.inlineUiOffered },
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
    get fingerprint() { return fixture.sessions.get(opts.sessionId)?.context.cliSessions?.[model.includes('codex') ? 'Codex CLI' : model.includes('muse') ? 'Muse Code' : 'Claude Code']?.fingerprint ?? ''; },
    // What actually reached the vendor CLI over stdin (claude, with an
    // active bridge, always sends the prompt as a stream-json 'user' message).
    get lastPrompt(): string {
      const raw = readFileSync(stdinFile, 'utf-8');
      return (JSON.parse(raw) as { message: { content: string } }).message.content;
    },
  };
}

const makeClaudeWorker = (opts: { sessionId: string; model?: string; permissionMode?: string; history?: string[]; maxTokenBudget?: number; inlineUiOffered?: boolean }) => makeWorker('cli/claude-code', opts);
const makeCodexWorker = (opts: { sessionId: string; model?: string; permissionMode?: string }) => makeWorker('cli/codex', opts);

const failMarker = () => join(fixture.dir, 'fail-marker');

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), 'octipus-cli-resume-'));
  fixture.script = join(fixture.dir, 'fake-claude.mjs');
  fixture.codexScript = join(fixture.dir, 'fake-codex.mjs');
  fixture.museScript = join(fixture.dir, 'fake-muse.mjs');
  // muse serve: an MSP host on stdio. It keeps a session log per started
  // session under $HOME/.local/share (the test points HOME at the fixture),
  // refuses to resume one it does not hold, dumps what the turn was launched
  // with, answers with the session id, and reports the allowance an
  // 'allowance-marker' names. A 'budget-marker' makes the turn report usage
  // and then never finish, so only a mid-run budget stop ends it.
  writeFileSync(fixture.museScript, `
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createInterface } from 'node:readline';
    const args = process.argv.slice(2);
    const home = process.env.XDG_CONFIG_HOME;
    const logDir = id => join(process.env.HOME, '.local', 'share', 'muse', 'sessions', '2026', '11', '13', id);
    const out = e => console.log(JSON.stringify({ jsonrpc: '2.0', ...e }));
    const note = (method, params = {}) => out({ method, params });
    let opened;
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return out({ id: m.id, result: {} });
      if (m.method === 'session/start') {
        if (!args.includes('--no-session-log')) { mkdirSync(logDir(m.params.sessionId), { recursive: true }); writeFileSync(join(logDir(m.params.sessionId), 'session.jsonl'), ''); }
        opened = m; return out({ id: m.id, result: { session: { sessionId: m.params.sessionId } } });
      }
      if (m.method === 'session/resume') {
        if (!existsSync(logDir(m.params.sessionId)) || existsSync(join(process.cwd(), 'refuse-resume')))
          return out({ id: m.id, error: { code: -32020, data: { kind: 'sessionNotFound', retryable: false }, message: 'session ' + m.params.sessionId + ' not found' } });
        opened = m; return out({ id: m.id, result: { session: { sessionId: m.params.sessionId } } });
      }
      if (m.method !== 'turn/start') return;
      // Live 1.4.20: a resumed session whose recorded workspace root is no
      // longer the trusted one loads no MCP server, so the toolset names fail.
      if (opened.method === 'session/resume' && existsSync(join(process.cwd(), 'moved-workspace'))) {
        out({ id: m.id, result: { status: 'accepted', turnId: m.params.commandId } });
        return note('turn/completed', { terminal: 'failed', error: { kind: 'invalidRunConfiguration', message: 'invalid run configuration: unknown tool names: mcp__octipus__read_file', retryable: false } });
      }
      const id = m.params.sessionId;
      writeFileSync(join(process.cwd(), 'muse-last.json'), JSON.stringify({ args, home, open: opened,
        settings: JSON.parse(readFileSync(join(home, 'muse', 'settings.json'), 'utf8')),
        trust: JSON.parse(readFileSync(join(home, 'muse', 'trust.json'), 'utf8')),
        prompt: m.params.input[0].text, bridge: !!process.env.OCTIPUS_AGENT_URL && !!process.env.OCTIPUS_AGENT_KEY }));
      out({ id: m.id, result: { status: 'accepted', turnId: m.params.commandId } });
      note('turn/started');
      note('turn/modelAttemptStarted');
      note('session/tokenUsage', { usage: { inputTokens: 10, cachedTokens: 4, outputTokens: 2, reasoningTokens: 0 } });
      if (existsSync(join(process.cwd(), 'budget-marker'))) {
        writeFileSync(join(process.cwd(), 'budget-reported'), '');
        for (let i = 0; i < 5; i++) note('session/tokenUsage', { usage: { inputTokens: 5000, cachedTokens: 0, outputTokens: 500, reasoningTokens: 0 } });
        return; // never completes: the turn would run on
      }
      note('item/started', { item: { itemId: 'a1', kind: 'agentMessage', text: '' } });
      note('item/delta', { itemId: 'a1', delta: 'answer for ' + id });
      note('item/completed', { item: { itemId: 'a1', kind: 'agentMessage', status: 'completed', text: 'answer for ' + id } });
      const marker = join(process.cwd(), 'allowance-marker');
      const used = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 5;
      note('usage/changed', { window: { usedPercent: used, resetsAtMs: 1794599619000 }, weekly: { usedPercent: 1, resetsAtMs: 1794787200000 } });
      note('turn/completed', { terminal: 'completed' });
    }).on('close', () => process.exit(0));
  `);
  fixture.sessions = new Map();
  fixture.spawnCount = 0;
  fixture.quotaExhausted = false;
  writeFileSync(fixture.script, `
    import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    writeFileSync(join(process.cwd(), 'claude-last-args.json'), JSON.stringify(args));
    const sessionIdx = args.indexOf('--session-id');
    const resumeIdx = args.indexOf('--resume');
    const idArg = sessionIdx >= 0 ? args[sessionIdx + 1] : resumeIdx >= 0 ? args[resumeIdx + 1] : null;
    const marker = join(process.cwd(), 'fail-marker');
    if (existsSync(marker)) {
      const text = readFileSync(marker, 'utf-8');
      unlinkSync(marker);
      // Real Claude handed a stale session id reports it on BOTH channels: a
      // stream-json result with is_error (which sets the worker's runError)
      // AND a non-zero exit with the message on stderr. The fake used to write
      // only stderr, which is why the dead-session recovery looked reachable.
      if (!text.startsWith('STDERR-ONLY:')) {
        console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text }));
      }
      process.stderr.write(text.replace('STDERR-ONLY:', ''));
      process.exit(1);
    }
    // hang-marker: stay alive until killed, like a vendor mid-turn. Content
    // 'init' first confirms the session (system/init), 'budget' also reports
    // usage far past any cap; 'maxturns' ends on Claude's own turn limit.
    const hang = join(process.cwd(), 'hang-marker');
    if (existsSync(hang)) {
      const mode = readFileSync(hang, 'utf-8');
      if (mode) console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: idArg }));
      if (mode === 'reply') console.log(JSON.stringify({ type: 'assistant', message: { id: 'm-reply', content: [{ type: 'text', text: 'working on it' }] } }));
      if (mode === 'budget') console.log(JSON.stringify({ type: 'assistant', message: { id: 'm-big', content: [], usage: { input_tokens: 1000000, output_tokens: 1 } } }));
      if (mode === 'maxturns') {
        const said = join(process.cwd(), 'answer-marker');
        if (existsSync(said)) console.log(JSON.stringify({ type: 'assistant', message: { id: 'm-said', content: [{ type: 'text', text: readFileSync(said, 'utf-8') }] } }));
        console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 5 }));
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    // Captures the real stream-json 'user' message written to stdin — the
    // actual prompt sent to the vendor, not a value the worker hands the test
    // directly — so the resume/cold assertions verify the real spawn seam.
    let stdinData = '';
    process.stdin.on('data', c => { stdinData += c; });
    process.stdin.on('end', () => { writeFileSync(join(process.cwd(), 'claude-last-stdin.txt'), stdinData); });
    // bg-marker: launch a native background Agent; content 'done' also reports it finished.
    const bgMarker = join(process.cwd(), 'bg-marker');
    if (existsSync(bgMarker)) {
      console.log(JSON.stringify({ type: 'assistant', message: { id: 'm-bg', content: [{ type: 'tool_use', id: 'tu-bg', name: 'Agent', input: { description: 'audit docs', prompt: 'x', run_in_background: true } }] } }));
      console.log(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu-bg', description: 'audit docs' }));
      console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-bg', content: 'Async agent launched' }] } }));
      if (readFileSync(bgMarker, 'utf-8') === 'done') console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' }));
    }
    const answerMarker = join(process.cwd(), 'answer-marker');
    const answer = existsSync(answerMarker) ? readFileSync(answerMarker, 'utf-8') : 'answer for ' + idArg;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: answer, num_turns: 1 }));
  `);
  // Codex mints its own thread id — it never appears as a CLI argument on a
  // first run (no --resume yet), so the fake binary generates one and reports
  // it via thread.started, exactly like the real vendor.
  writeFileSync(fixture.codexScript, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    // Dumped so the test can assert on the real argv the worker built
    // (whether --ephemeral is present, whether it's 'exec resume <id>').
    writeFileSync(join(process.cwd(), 'codex-last-args.json'), JSON.stringify(args));
    const resumeIdx = args.indexOf('resume');
    const resumedId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
    const threadId = resumedId || 'codex-thread-' + Math.random().toString(36).slice(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
    const hang = join(process.cwd(), 'hang-marker');
    if (existsSync(hang)) {
      if (readFileSync(hang, 'utf-8') === 'reply') {
        console.log(JSON.stringify({ type: 'turn.started' }));
        console.log(JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'reasoning', text: 'thinking' } }));
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    console.log(JSON.stringify({ type: 'turn.started' }));
    const answerMarker = join(process.cwd(), 'answer-marker');
    const answer = existsSync(answerMarker) ? readFileSync(answerMarker, 'utf-8') : 'answer for ' + threadId;
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  `);
});

afterEach(() => { try { unlinkSync(failMarker()); } catch { /* not there */ } rmSync(fixture.dir, { recursive: true, force: true }); });

describe('CLI session reuse', () => {
  it('reports a buffered CLI as running before its output arrives without inventing iterations', async () => {
    writeFileSync(fixture.script, `await new Promise(r => setTimeout(r, 100)); console.log('QA finished');`);
    const { worker, run } = makeWorker('cli/vibe', { sessionId: 'buffered-status' });
    const events: Array<{ type: string; data: unknown }> = [];
    worker.onEvent(event => { events.push({ type: event.type, data: event.data }); });
    await run('Check the implementation');
    const running = events.findIndex(event => event.type === 'thought'
      && (event.data as { status?: string }).status === 'running');
    const completed = events.findIndex(event => event.type === 'complete');
    expect(running).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(running);
    expect(events[running].data).toMatchObject({ message: expect.stringContaining('Live progress and iteration counts are unavailable') });
    expect(events.some(event => (event.data as { type?: string }).type === 'iteration_update')).toBe(false);
  });

  it('stores CLI widget output before emitting completion', async () => {
    writeFileSync(join(fixture.dir, 'answer-marker'), 'Here:\n```octi-ui title="Counter"\n<button type="button">Next</button>\n```');
    const { worker, run } = makeClaudeWorker({ sessionId: 'inline-output', inlineUiOffered: true });
    const completions: unknown[] = [];
    worker.onEvent(event => { if (event.type === 'complete') completions.push(event.data); });
    const result = await run('Make a counter');
    expect(result).toContain('[[octi-ui:11111111-1111-4111-8111-111111111111|Counter]]');
    expect(result).not.toContain('<button');
    expect(completions).toEqual([{ result }]);
  });

  it.each([
    ['cli/claude-code', 'Claude Code'], ['cli/codex', 'Codex CLI'],
  ])('interactive turns retain and resume the same %s session after widget output', async (model, adapter) => {
    writeFileSync(join(fixture.dir, 'answer-marker'), 'Here:\n```octi-ui title="Counter"\n<button type="button">Next</button>\n```');
    const first = makeWorker(model, { sessionId: 'inline', inlineUiOffered: true });
    const result = await first.run('Make a counter');
    expect(result).toContain('[[octi-ui:11111111-1111-4111-8111-111111111111|Counter]]');
    expect(result).not.toContain('<button');
    const stored = await loadCliSession('inline', adapter, first.fingerprint);
    expect(stored).toMatchObject({ id: expect.any(String) });
    unlinkSync(join(fixture.dir, 'answer-marker'));
    const second = makeWorker(model, { sessionId: 'inline', inlineUiOffered: true });
    await second.run('Change it');
    expect(await loadCliSession('inline', adapter, second.fingerprint)).toMatchObject({ id: stored!.id });
    if (adapter === 'Codex CLI') expect(lastCodexArgs().slice(0, 3)).toEqual(['exec', 'resume', stored!.id]);
    else {
      const args = JSON.parse(readFileSync(join(fixture.dir, 'claude-last-args.json'), 'utf-8')) as string[];
      expect(args[args.indexOf('--resume') + 1]).toBe(stored!.id);
      expect(second.lastPrompt).toContain('Change it');
    }
  });

  it('starts fresh and stores the id on the first turn', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1' });
    await worker.run('first question');
    const stored = await loadCliSession('s1', 'Claude Code', worker.fingerprint);
    expect(stored).toMatchObject({ id: expect.any(String) });
  });

  it('resumes the stored id on the second turn', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1' });
    await worker.run('first question');
    const first = await loadCliSession('s1', 'Claude Code', worker.fingerprint);

    const second = makeClaudeWorker({ sessionId: 's1' });
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
    const worker = makeClaudeWorker({ sessionId: 's1' });
    const before = fixture.spawnCount;
    const answer = await worker.run('question');
    expect(answer).not.toBe('');
    expect(fixture.spawnCount - before).toBe(2); // cold retry happened
    expect(await loadCliSession('s1', 'Claude Code', worker.fingerprint)).not.toBeNull();
  });

  it('I6 — recovers even when the vendor reports the dead session only as a structured error', async () => {
    // The `runError` rejection used to run BEFORE the dead-session branch, so a
    // vendor that reports the stale id through its own result stream never
    // reached recovery: the id was never dropped and every later turn failed
    // identically — permanent, not a one-off.
    const worker = makeClaudeWorker({ sessionId: 's1' });
    await worker.run('first question');
    expect(await loadCliSession('s1', 'Claude Code', worker.fingerprint)).not.toBeNull();

    writeFileSync(failMarker(), 'No conversation found with session ID: dead', 'utf-8');
    const second = makeClaudeWorker({ sessionId: 's1' });
    const before = fixture.spawnCount;
    const answer = await second.run('second question');

    expect(answer).not.toBe('');
    expect(fixture.spawnCount - before).toBe(2); // cold retry happened
    expect(await loadCliSession('s1', 'Claude Code', second.fingerprint)).not.toBeNull();
  });

  it('does not resume when the model changed', async () => {
    const worker = makeClaudeWorker({ sessionId: 's1', model: 'sonnet' });
    await worker.run('first');
    const sonnetRecord = await loadCliSession('s1', 'Claude Code', worker.fingerprint);

    const other = makeClaudeWorker({ sessionId: 's1', model: 'opus' });
    const answer = await other.run('second');
    const opusRecord = await loadCliSession('s1', 'Claude Code', other.fingerprint);

    // Different fingerprint => no record yet => a freshly minted id, not a resume.
    expect(opusRecord!.id).not.toBe(sonnetRecord!.id);
    expect(answer).toContain(opusRecord!.id);
  });

  // Codex is 'captured' style (CLI_RESUME): the worker never mints an id for
  // it, so the first run must still participate in reuse (no --ephemeral)
  // and store whatever id the vendor reports via thread.started — otherwise
  // every Codex run is thrown away as ephemeral and reuse can never engage.
  const lastCodexArgs = (): string[] => JSON.parse(readFileSync(join(fixture.dir, 'codex-last-args.json'), 'utf-8'));

  it('leaves a first Codex run resumable (no --ephemeral) and stores the captured thread id', async () => {
    const worker = makeCodexWorker({ sessionId: 's1' });
    await worker.run('first question');
    expect(lastCodexArgs()).not.toContain('--ephemeral');
    const stored = await loadCliSession('s1', 'Codex CLI', worker.fingerprint);
    expect(stored).toMatchObject({ id: expect.any(String) });
    expect(stored!.id).not.toBe('');
  });

  it('resumes the captured Codex thread on the second turn', async () => {
    const worker = makeCodexWorker({ sessionId: 's1' });
    await worker.run('first question');
    const first = await loadCliSession('s1', 'Codex CLI', worker.fingerprint);

    const second = makeCodexWorker({ sessionId: 's1' });
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
    const worker = makeClaudeWorker({ sessionId: 's1', history: ['old question', 'old answer'] });
    await worker.run('first');
    const second = makeClaudeWorker({ sessionId: 's1', history: ['old question', 'old answer', 'first'] });
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
    const worker = makeClaudeWorker({ sessionId: 's1' });
    await worker.run('first question'); // cold: 60 + 40, no cache
    expect(worker.worker.getTotalTokens()).toBe(100);
    expect(worker.worker.getBillableTokens()).toBe(100);

    const second = makeClaudeWorker({ sessionId: 's1' });
    await second.run('second question'); // resumed: 50 + 100 + 2000 cache read
    expect(second.worker.getTotalTokens()).toBe(2150); // grand total, cache reads included
    expect(second.worker.getBillableTokens()).toBe(150); // 50 + 100 only, cache read excluded
  });

  it('does not trip maxTokenBudget on a resumed run that is almost entirely cache reads', async () => {
    // Fresh + output is 100 — nowhere near the 200 cap. Grand total is 5100,
    // far past it. Without the getBillableTokens() override the kill-switch
    // compared the grand total and would SIGKILL this run.
    writeFileSync(fixture.script, usageScript(50, 50, 5000));
    const worker = makeClaudeWorker({ sessionId: 's1', maxTokenBudget: 200 });
    await worker.run('first question');

    const second = makeClaudeWorker({ sessionId: 's1', maxTokenBudget: 200 });
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
    const worker = makeClaudeWorker({ sessionId: 's1' });
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
    const worker = makeClaudeWorker({ sessionId: 's1', history: ['old question', 'old answer'] });
    await worker.run('first');
    expect(worker.lastPrompt).toContain('old question');
  });
});


describe('session boundary regressions', () => {
  it('does not replay pre-clear text on a cold launch', async () => {
    const w = makeClaudeWorker({ sessionId: 'clear', history: ['CLEARED SECRET', 'old answer'] });
    fixture.sessions.get('clear')!.context.clearedAt = '2026-01-01T00:00:00.000Z';
    await w.run('new question');
    expect(w.lastPrompt).not.toContain('CLEARED SECRET');
  });
  it('keeps a specialist out of the root vendor conversation', async () => {
    const root = makeClaudeWorker({ sessionId: 'child' });
    await root.run('root question');
    const first = await loadCliSession('child', 'Claude Code', root.fingerprint);
    const child = makeClaudeWorker({ sessionId: 'child' });
    Object.assign(child.worker.getContext(), { root: false, role: 'coding', parentAgentId: root.worker.getContext().id });
    const result = await child.run('specialist task');
    expect(result).not.toContain(first!.id);
    expect((await loadCliSession('child', 'Claude Code', root.fingerprint))!.id).toBe(first!.id);
  });
  it('sends intervening messages that another provider handled', async () => {
    const first = makeClaudeWorker({ sessionId: 'switch' });
    await first.run('first question');
    const next = makeClaudeWorker({ sessionId: 'switch', history: ['first question', 'answer', 'NEW CORRECTION', 'other provider answer'] });
    await next.run('continue');
    expect(next.lastPrompt).toContain('NEW CORRECTION');
    expect(next.lastPrompt).toContain('other provider answer');
    expect(next.lastPrompt).not.toContain('first question');
  });
});

describe('child CLI session reuse, keyed per (role, task)', () => {
  const key = childCliSessionKey('Claude Code', 'coding:parser-fix');
  const stored = (sessionId: string) => fixture.sessions.get(sessionId)?.context.cliSessions?.[key];
  // A spawner-built child: not a root, and resumable only with metadata.resumeKey.
  const makeChild = (sessionId: string, resumeKey?: string, model?: string) => {
    const child = makeClaudeWorker({ sessionId, model });
    Object.assign(child.worker.getContext(), { root: false, role: 'coding', parentAgentId: 'parent', metadata: resumeKey ? { resumeKey } : {} });
    return child;
  };

  it('resumes the previous child session when given the same key', async () => {
    await makeChild('kid', 'coding:parser-fix').run('fix the parser');
    const first = stored('kid');
    expect(first?.id).toEqual(expect.any(String));
    const answer = await makeChild('kid', 'coding:parser-fix').run('now add the test');
    expect(answer).toContain(first!.id);
    expect(stored('kid')!.id).toBe(first!.id);
    // The root's own vendor session is untouched by a child's.
    expect(fixture.sessions.get('kid')!.context.cliSessions?.['Claude Code']).toBeUndefined();
  });

  it('stays cold without a key', async () => {
    await makeChild('kid').run('fix the parser');
    // The fake echoes the --session-id/--resume it was handed: none at all.
    expect(await makeChild('kid').run('fix the parser')).toBe('answer for null');
    expect(fixture.sessions.get('kid')!.context.cliSessions ?? {}).toEqual({});
  });

  it('starts cold while another live agent holds the key', async () => {
    await makeChild('kid', 'coding:parser-fix').run('fix the parser');
    const first = stored('kid')!;
    expect(claimCliSession('kid', key, 'still-running')).toBe(true);
    try {
      const answer = await makeChild('kid', 'coding:parser-fix').run('fix the parser too');
      expect(answer).not.toContain(first.id);
      // The cold one neither resumed nor overwrote the holder's record.
      expect(stored('kid')).toEqual(first);
    } finally {
      releaseCliSessions('still-running');
    }
  });

  // A keyed child's prompt as the spawner and agent-manager build it: stable
  // instructions, then VOLATILE_MARKER, then brief- and session-selected skills.
  const skilled = (tail: string, stable = 'You are a coding agent.') => {
    const child = makeChild('kid', 'coding:parser-fix');
    child.worker.addSystemMessage(`${stable}\n\nCURRENT DATE/TIME: as stated in the task message.\n\n${tail}`);
    child.worker.addSystemMessage('Stable worker guidance.');
    return child;
  };

  it('resumes when the brief- and session-selected skills differ, and re-sends the new ones', async () => {
    await skilled('# Domain Knowledge (topic index)\n- parsing: grammar notes\n\n# User-selected skills\n- house style A').run('fix the parser');
    const firstId = stored('kid')!.id;
    const second = skilled('# Domain Knowledge (topic index)\n- testing: vitest conventions\n\n# User-selected skills\n- house style B');
    expect(await second.run('now add a regression test for empty input')).toContain(firstId);
    // The vendor keeps the first run's stable prompt; the tail is re-sent.
    expect(second.lastPrompt).toContain('vitest conventions');
    expect(second.lastPrompt).toContain('house style B');
    expect(second.lastPrompt).toContain('now add a regression test for empty input');
    expect(second.lastPrompt).not.toContain('grammar notes');
    expect(second.lastPrompt).not.toContain('You are a coding agent.');
    // Stable guidance after the marker message is in the vendor's snapshot.
    expect(second.lastPrompt).not.toContain('Stable worker guidance.');
    expect(second.lastPrompt).not.toContain('You are connected to your Octipus run');
  });

  it('starts cold when the stable instructions changed', async () => {
    await skilled('').run('fix the parser');
    const firstId = stored('kid')!.id;
    expect(await skilled('', 'You are a careful coding agent.').run('fix the parser')).not.toContain(firstId);
  });

  it('starts cold when stable worker guidance outside the prompt changed', async () => {
    await skilled('').run('fix the parser');
    const firstId = stored('kid')!.id;
    const second = skilled('');
    second.worker.addSystemMessage('Extra stable guidance.');
    expect(await second.run('fix the parser')).not.toContain(firstId);
  });

  it('frees the key at once when the stopped holder never started a process', async () => {
    const holder = makeChild('kid', 'coding:parser-fix');
    expect(claimCliSession('kid', key, holder.worker.getContext().id)).toBe(true);
    expect(claimCliSession('kid', key, 'retry')).toBe(false);
    holder.worker.stop();
    expect(claimCliSession('kid', key, 'retry')).toBe(true);
    releaseCliSessions('retry');
  });

  it('holds the key until a stopped child\'s vendor process has exited', async () => {
    writeFileSync(join(fixture.dir, 'hang-marker'), '');
    const child = makeChild('kid', 'coding:parser-fix');
    const running = child.worker.run('fix the parser').catch(() => 'stopped');
    await vi.waitFor(() => expect(fixture.spawnCount).toBe(1));
    expect(cliSessionHolder('kid', key)).toBe(child.worker.getContext().id);
    child.worker.stop();
    // SIGTERM sent, process not yet gone: a retry must not resume it yet.
    expect(claimCliSession('kid', key, 'retry')).toBe(false);
    await running;
    expect(claimCliSession('kid', key, 'retry')).toBe(true);
    releaseCliSessions('retry');
  });

  // Starts a keyed child on the hanging fake and resolves once the vendor
  // confirmed its session (when `mode` makes it) or the process is up.
  const startHanging = async (mode: string) => {
    writeFileSync(join(fixture.dir, 'hang-marker'), mode);
    const child = makeChild('kid', 'coding:parser-fix');
    let confirmed = false;
    child.worker.onEvent(e => { if (e.type === 'thought' && (e.data as { vendorSessionId?: string }).vendorSessionId) confirmed = true; });
    const running = child.worker.run('fix the parser').catch(() => 'stopped');
    await vi.waitFor(() => expect(mode ? confirmed : fixture.spawnCount === 1).toBe(true));
    return { child, running };
  };

  it('a stopped keyed child keeps a vendor-confirmed session for the next run on the task', async () => {
    const { child, running } = await startHanging('init');
    child.worker.stop();
    await running;
    const kept = stored('kid');
    expect(kept?.id).toEqual(expect.any(String));
    unlinkSync(join(fixture.dir, 'hang-marker'));
    expect(await makeChild('kid', 'coding:parser-fix').run('carry on')).toContain(kept!.id);
  });

  it('a stopped keyed child saves nothing when the vendor never confirmed the session', async () => {
    const { child, running } = await startHanging('');
    child.worker.stop();
    await running;
    expect(stored('kid')).toBeUndefined();
  });

  it('keeps the session when Claude stops on its own max-turns limit', async () => {
    writeFileSync(join(fixture.dir, 'hang-marker'), 'maxturns');
    await expect(makeChild('kid', 'coding:parser-fix').run('fix the parser')).rejects.toThrow(/max-turns/);
    expect(stored('kid')?.id).toEqual(expect.any(String));
  });

  it('drops the stored session when a keyed child blows its budget', async () => {
    await makeChild('kid', 'coding:parser-fix').run('fix the parser');
    expect(stored('kid')).toBeDefined();
    writeFileSync(join(fixture.dir, 'hang-marker'), 'budget');
    await expect(makeChild('kid', 'coding:parser-fix').run('carry on')).rejects.toThrow();
    expect(stored('kid')).toBeUndefined();
  });

  it('starts cold on a fingerprint mismatch', async () => {
    await makeChild('kid', 'coding:parser-fix', 'sonnet').run('fix the parser');
    const first = stored('kid')!;
    const answer = await makeChild('kid', 'coding:parser-fix', 'opus').run('now add the test');
    expect(answer).not.toContain(first.id);
    expect(stored('kid')!.id).not.toBe(first.id);
  });

  it('does not resume a child key across /clear', async () => {
    await makeChild('kid', 'coding:parser-fix').run('fix the parser');
    const first = stored('kid')!;
    // What sessionRepository.clearContext writes: the whole cliSessions map
    // goes, child keys included, and a new generation starts.
    const row = fixture.sessions.get('kid')!;
    row.context = { ...row.context, cliSessions: undefined, clearedAt: new Date().toISOString() };
    const answer = await makeChild('kid', 'coding:parser-fix').run('fix the parser');
    expect(answer).not.toContain(first.id);
    expect(stored('kid')!.id).not.toBe(first.id);
  });
});

describe('native background work lost at CLI exit', () => {
  const runWithMarker = async (content: string) => {
    writeFileSync(join(fixture.dir, 'bg-marker'), content, 'utf-8');
    const worker = makeClaudeWorker({ sessionId: 'bg' });
    const warnings: string[] = [];
    worker.worker.onEvent(e => { if (e.type === 'observation') warnings.push((e.data as { message: string }).message); });
    const answer = await worker.run('question');
    return { answer, warnings: warnings.filter(w => w.includes('background task')) };
  };

  it('warns and notes the result when a background Agent never finished', async () => {
    const { answer, warnings } = await runWithMarker('open');
    expect(warnings).toEqual(['CLI exited with 1 background task(s) still running: Agent: audit docs — their work was lost']);
    expect(answer).toContain('CLI exited with 1 background task(s) still running: Agent: audit docs — their work was lost');
  });

  it('stays quiet when the background Agent reported completion', async () => {
    const { answer, warnings } = await runWithMarker('done');
    expect(warnings).toEqual([]);
    expect(answer).not.toContain('background task');
  });
});

describe('Muse Code runs', () => {
  beforeEach(() => { vi.stubEnv('HOME', fixture.dir); });
  afterEach(() => { vi.unstubAllEnvs(); });
  const last = () => JSON.parse(readFileSync(join(fixture.dir, 'muse-last.json'), 'utf8')) as {
    args: string[]; home: string; open: { method: string; params: { sessionId: string; workspaceRoots?: string[] } };
    settings: Record<string, any>; trust: { projects: Record<string, unknown> }; prompt: string; bridge: boolean };

  it('runs muse serve with the bridge as its only tools in a per-run config home, removed afterwards', async () => {
    const answer = await makeWorker('cli/muse', { sessionId: 'muse-tools' }).run('first');
    const launch = last();
    expect(launch.args.slice(0, 2)).toEqual(['serve', '--disable-request-user-input']);
    expect(launch.bridge).toBe(true);
    const toolset = launch.settings.run.toolset as string[];
    expect(toolset.length).toBeGreaterThan(0);
    expect(toolset.every(name => name.startsWith('mcp__octipus__'))).toBe(true);
    expect(toolset).toContain('mcp__octipus__get_cli_run_context');
    expect(Object.keys(launch.settings.mcpServers)).toEqual(['octipus']);
    expect(launch.settings.skills.activation.bundled).toEqual({ 'bundled://muse-core/skills/git/SKILL.md': 'off' });
    expect(launch.open.method).toBe('session/start');
    expect(Object.keys(launch.trust.projects)).toEqual(launch.open.params.workspaceRoots);
    expect(launch.open.params.workspaceRoots).not.toEqual([fixture.dir]);
    expect(launch.prompt).toContain(`This run's files are in ${fixture.dir}`);
    expect((await import('node:fs')).existsSync(launch.home)).toBe(false);
    expect(answer).toContain(launch.open.params.sessionId);
  });

  it('starts its session under a minted id, resumes it, and starts cold once the session log is gone', async () => {
    const first = makeWorker('cli/muse', { sessionId: 'muse-resume' });
    await first.run('first');
    const id = last().open.params.sessionId;
    expect(await loadCliSession('muse-resume', 'Muse Code', first.fingerprint)).toMatchObject({ id });
    await makeWorker('cli/muse', { sessionId: 'muse-resume' }).run('second');
    expect(last().open).toMatchObject({ method: 'session/resume', params: { sessionId: id } });
    rmSync(join(fixture.dir, '.local', 'share', 'muse', 'sessions'), { recursive: true, force: true });
    const third = makeWorker('cli/muse', { sessionId: 'muse-resume' });
    await third.run('third');
    const fresh = last().open;
    expect(fresh.method).toBe('session/start');
    expect(fresh.params.sessionId).not.toBe(id);
    expect(await loadCliSession('muse-resume', 'Muse Code', third.fingerprint)).toMatchObject({ id: fresh.params.sessionId });
  });

  it('starts cold when muse refuses to resume a session it still has a log for', async () => {
    await makeWorker('cli/muse', { sessionId: 'muse-refused' }).run('first');
    const id = last().open.params.sessionId;
    writeFileSync(join(fixture.dir, 'refuse-resume'), '');
    const answer = await makeWorker('cli/muse', { sessionId: 'muse-refused' }).run('second');
    expect(last().open.method).toBe('session/start');
    expect(last().open.params.sessionId).not.toBe(id);
    expect(answer).toContain(last().open.params.sessionId);
  });

  it('starts cold when a resumed session lost its workspace and with it the bridge tools', async () => {
    await makeWorker('cli/muse', { sessionId: 'muse-moved' }).run('first');
    const id = last().open.params.sessionId;
    writeFileSync(join(fixture.dir, 'moved-workspace'), '');
    const answer = await makeWorker('cli/muse', { sessionId: 'muse-moved' }).run('second');
    expect(last().open.method).toBe('session/start');
    expect(last().open.params.sessionId).not.toBe(id);
    expect(answer).toContain(last().open.params.sessionId);
  });

  it('stops a run mid-turn once per-call usage passes the token budget', async () => {
    writeFileSync(join(fixture.dir, 'budget-marker'), '');
    await expect(makeWorker('cli/muse', { sessionId: 'muse-budget', maxTokenBudget: 8000 }).run('work')).rejects.toThrow(/budget/i);
    expect((await import('node:fs')).existsSync(join(fixture.dir, 'budget-reported'))).toBe(true);
  });

  it('marks the subscription quota exhausted when the vendor reports a spent allowance', async () => {
    writeFileSync(join(fixture.dir, 'allowance-marker'), '100');
    await makeWorker('cli/muse', { sessionId: 'muse-quota' }).run('work');
    expect(fixture.quotaExhausted).toBe(true);
  });

  it('refuses a permission mode before launching', async () => {
    await expect(makeWorker('cli/muse', { sessionId: 'muse-perm', permissionMode: 'safe' }).run('work')).rejects.toThrow(/permission mode does not apply/);
    expect(fixture.spawnCount).toBe(0);
  });
});

describe('CLI quota detection', () => {
  it('classifies exhausted providers for backup and blocks another CLI launch', async () => {
    const { ClassifiedError, FailoverReason, RecoveryAction } = await import('./errors/classification');
    writeFileSync(join(fixture.dir, 'fail-marker'), 'Quota exhausted', 'utf-8');
    const worker = makeClaudeWorker({ sessionId: 'quota-failed' });
    await expect(worker.run('work')).rejects.toMatchObject({
      reason: FailoverReason.QUOTA_EXHAUSTED, recovery: RecoveryAction.FALLBACK_PROVIDER,
    });
    expect(fixture.quotaExhausted).toBe(true);
    expect(fixture.spawnCount).toBe(1);
    await expect(makeClaudeWorker({ sessionId: 'quota-known' }).run('work')).rejects.toBeInstanceOf(ClassifiedError);
    expect(fixture.spawnCount).toBe(1);
  });
  it('does not treat a successful answer that mentions quota as a quota failure', async () => {
    // Real incident: the root's final answer quoted "Quota exhausted for
    // Claude Code" and "rate limit exceeded"; the clean run was rejected as a
    // quota error and the provider marked exhausted for an hour.
    const text = 'Arms died: Quota exhausted for Claude Code. The rate limit was exceeded.';
    writeFileSync(join(fixture.dir, 'answer-marker'), text, 'utf-8');
    const worker = makeClaudeWorker({ sessionId: 'sq' });
    await expect(worker.run('status?')).resolves.toContain('Quota exhausted for Claude Code');
  });

  it('does not treat a failed run whose answer mentions quota as a quota failure', async () => {
    // A run that fails for another reason (here: max-turns) must not be
    // re-labelled a quota failure because the agent's own text quoted one.
    writeFileSync(join(fixture.dir, 'answer-marker'), 'Earlier: rate limit exceeded, quota exhausted.', 'utf-8');
    writeFileSync(join(fixture.dir, 'hang-marker'), 'maxturns');
    await expect(makeClaudeWorker({ sessionId: 'sq2' }).run('status?')).rejects.toThrow(/max-turns/);
  });
});

describe('chat image transport through the worker', () => {
  it('sends the exact current image bytes on fresh and resumed Claude turns', async () => {
    const path = join(fixture.dir, 'screen with spaces.png');
    for (const bytes of [Buffer.from([137, 80, 78, 71, 1]), Buffer.from([137, 80, 78, 71, 2])]) {
      writeFileSync(path, bytes);
      const turn = makeClaudeWorker({ sessionId: 'image-transport' });
      turn.worker.getContext().metadata.imageAttachments = [path];
      await turn.run('Inspect the screenshot');
      const input = JSON.parse(readFileSync(join(fixture.dir, 'claude-last-stdin.txt'), 'utf8'));
      expect(input.message.content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
    }
    expect(fixture.spawnCount).toBe(2);
  });
  it('refuses an image outside the session workspace before launching the CLI', async () => {
    const turn = makeClaudeWorker({ sessionId: 'image-containment' });
    turn.worker.getContext().metadata.imageAttachments = [join(fixture.dir, '..', 'other-user.png')];
    await expect(turn.run('Inspect')).rejects.toThrow();
    expect(fixture.spawnCount).toBe(0);
  });
});

describe('cache-preserving resume of root conversations', () => {
  const lastClaudeArgs = (): string[] => JSON.parse(readFileSync(join(fixture.dir, 'claude-last-args.json'), 'utf-8'));
  const lastCodexArgs = (): string[] => JSON.parse(readFileSync(join(fixture.dir, 'codex-last-args.json'), 'utf-8'));
  const record = (sessionId: string, key = 'Claude Code') => fixture.sessions.get(sessionId)?.context.cliSessions?.[key];
  // A root turn as agent-manager builds it: the transcript loaded, then the
  // root prompt (stable part, the date marker, this turn's volatile tail).
  const runRoot = async (root: ReturnType<typeof makeClaudeWorker>, stamp: string, message: string) => {
    await root.worker.loadHistory();
    root.worker.addSystemMessage(`Root rules.\n\nCURRENT DATE & TIME: ${stamp}`);
    return root.worker.run(message);
  };

  it('puts the bridge and vault blocks before the volatile tail and never re-sends them on resume', async () => {
    const { VAULT_USAGE_GUIDANCE } = await import('@/core/agent/vault-guidance');
    await runRoot(makeClaudeWorker({ sessionId: 'tail' }), 'TURN-ONE-STAMP', 'first question');
    const firstArgs = lastClaudeArgs();
    const system = firstArgs[firstArgs.indexOf('--append-system-prompt') + 1];
    expect(system.indexOf('Root rules.')).toBeLessThan(system.indexOf('You are connected to your Octipus run'));
    expect(system.indexOf('You are connected to your Octipus run')).toBeLessThan(system.indexOf('TURN-ONE-STAMP'));
    const id = record('tail')!.id;

    const second = makeClaudeWorker({ sessionId: 'tail', history: ['first question', 'answer'] });
    expect(await runRoot(second, 'TURN-TWO-STAMP', 'second question')).toContain(id);
    expect(lastClaudeArgs()).not.toContain('--append-system-prompt');
    expect(second.lastPrompt).toContain('TURN-TWO-STAMP');
    expect(second.lastPrompt).toContain('second question');
    expect(second.lastPrompt).not.toContain('You are connected to your Octipus run');
    expect(second.lastPrompt).not.toContain(VAULT_USAGE_GUIDANCE.slice(0, 60));
    expect(second.lastPrompt).not.toContain('Root rules.');
  });

  it('names request_user_approval only to a CLI that has it', async () => {
    const systemOf = () => { const args = lastClaudeArgs(); return args[args.indexOf('--append-system-prompt') + 1]; };
    // A child: no root-only tool, so it is told where its decisions go instead.
    await makeClaudeWorker({ sessionId: 'ask-child' }).run('work');
    expect(systemOf()).not.toContain('request_user_approval');
    expect(systemOf()).toContain('put to the user automatically');
    const root = makeClaudeWorker({ sessionId: 'ask-root' });
    root.worker.registerTool({ name: 'request_user_approval', description: 'ask', parameters: { type: 'object', properties: {} }, execute: async () => '' });
    await root.run('work');
    expect(systemOf()).toContain('Use request_user_approval when a user decision is required');
  });

  it('keeps the vendor conversation across a plan-mode toggle and passes the mode on the resumed run', async () => {
    // A root's tools as root-runner hands them over; plan mode strips the
    // file-changing ones, and the fingerprint must not see that either.
    const withTools = (worker: ReturnType<typeof makeClaudeWorker>, writes: boolean) => {
      worker.worker.registerTool({ name: 'read_notes', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => '' });
      if (writes) worker.worker.registerTool({ name: 'filesystem__write_file', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => '' });
      return worker;
    };
    await withTools(makeClaudeWorker({ sessionId: 'plan' }), true).run('look around');
    const id = record('plan')!.id;
    (fixture.sessions.get('plan')!.context as SessionContext & { planMode?: boolean }).planMode = true;
    const planning = withTools(makeClaudeWorker({ sessionId: 'plan' }), false);
    expect(await planning.run('plan it')).toContain(id);
    let args = lastClaudeArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe(id);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');

    (fixture.sessions.get('plan')!.context as SessionContext & { planMode?: boolean }).planMode = false;
    expect(await withTools(makeClaudeWorker({ sessionId: 'plan' }), true).run('do it')).toContain(id);
    args = lastClaudeArgs();
    expect(args[args.indexOf('--permission-mode') + 1]).not.toBe('plan');
  });

  it('keeps the vendor conversation when the row\'s permission mode changes', async () => {
    await makeClaudeWorker({ sessionId: 'perm', permissionMode: 'acceptEdits' }).run('first');
    const id = record('perm')!.id;
    expect(await makeClaudeWorker({ sessionId: 'perm', permissionMode: 'bypassPermissions' }).run('second')).toContain(id);
    const args = lastClaudeArgs();
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  it('records a first Claude turn stopped after the vendor answered, and does not re-send it', async () => {
    writeFileSync(join(fixture.dir, 'hang-marker'), 'reply');
    const first = makeClaudeWorker({ sessionId: 'stopped' });
    const running = first.run('stopped question').catch(() => 'stopped');
    await vi.waitFor(() => expect(record('stopped')?.acknowledged).toBeDefined(), { timeout: 5000 });
    first.worker.stop();
    await running;
    const kept = record('stopped')!;
    expect(kept.acknowledged!.id).toBe('message-0');
    unlinkSync(join(fixture.dir, 'hang-marker'));

    const next = makeClaudeWorker({ sessionId: 'stopped', history: ['stopped question'] });
    expect(await next.run('carry on')).toContain(kept.id);
    expect(next.lastPrompt).toContain('carry on');
    expect(next.lastPrompt).not.toContain('stopped question');
  });

  it('re-sends a resumed turn that was stopped before the vendor answered', async () => {
    await makeClaudeWorker({ sessionId: 'unanswered' }).run('first');
    const before = record('unanswered')!;
    writeFileSync(join(fixture.dir, 'hang-marker'), 'init');
    const stopped = makeClaudeWorker({ sessionId: 'unanswered', history: ['first', 'answer'] });
    const running = stopped.run('lost question').catch(() => 'stopped');
    await vi.waitFor(() => expect(fixture.spawnCount).toBe(2), { timeout: 5000 });
    await new Promise(r => setTimeout(r, 300));
    stopped.worker.stop();
    await running;
    expect(record('unanswered')!.acknowledged).toEqual(before.acknowledged);
    unlinkSync(join(fixture.dir, 'hang-marker'));

    const next = makeClaudeWorker({ sessionId: 'unanswered', history: ['first', 'answer', 'lost question'] });
    expect(await next.run('third')).toContain(before.id);
    expect(next.lastPrompt).toContain('lost question');
  });

  it('keeps the previous cursor when a resumed Codex run names its thread and dies before answering', async () => {
    await makeCodexWorker({ sessionId: 'codex-cursor' }).run('first');
    const before = record('codex-cursor', 'Codex CLI')!;
    expect(before.acknowledged).toBeDefined();
    writeFileSync(join(fixture.dir, 'hang-marker'), '');
    const stopped = makeCodexWorker({ sessionId: 'codex-cursor' });
    const running = stopped.run('lost question').catch(() => 'stopped');
    await vi.waitFor(() => expect(fixture.spawnCount).toBe(2), { timeout: 5000 });
    await new Promise(r => setTimeout(r, 300));
    stopped.worker.stop();
    await running;
    expect(record('codex-cursor', 'Codex CLI')).toMatchObject({ id: before.id, acknowledged: before.acknowledged });
  });

  it('records the cursor once a Codex run answers, and starts cold off a first thread that never did', async () => {
    writeFileSync(join(fixture.dir, 'hang-marker'), 'reply');
    const answered = makeCodexWorker({ sessionId: 'codex-reply' });
    const running = answered.run('question').catch(() => 'stopped');
    await vi.waitFor(() => expect(record('codex-reply', 'Codex CLI')?.acknowledged?.id).toBe('message-0'), { timeout: 5000 });
    answered.worker.stop();
    await running;

    writeFileSync(join(fixture.dir, 'hang-marker'), '');
    const silent = makeCodexWorker({ sessionId: 'codex-silent' });
    const dying = silent.run('question').catch(() => 'stopped');
    await vi.waitFor(() => expect(record('codex-silent', 'Codex CLI')?.id).toEqual(expect.any(String)), { timeout: 5000 });
    silent.worker.stop();
    await dying;
    expect(record('codex-silent', 'Codex CLI')!.acknowledged).toBeUndefined();
    unlinkSync(join(fixture.dir, 'hang-marker'));
    await makeCodexWorker({ sessionId: 'codex-silent' }).run('again');
    expect(lastCodexArgs()[1]).not.toBe('resume');
  });

  it('names a keyed Codex child\'s bridge after its resume key, so a resumed thread keeps its tool names', async () => {
    const namespace = () => lastCodexArgs().join(' ').match(/octipus_run_[0-9a-f]{16}/)?.[0];
    const child = (resumeKey?: string) => {
      const worker = makeCodexWorker({ sessionId: 'codex-kid' });
      Object.assign(worker.worker.getContext(), { root: false, role: 'coding', parentAgentId: 'parent', metadata: resumeKey ? { resumeKey } : {} });
      return worker;
    };
    await child('coding:parser-fix').run('fix the parser');
    const first = namespace();
    expect(first).toBeDefined();
    await child('coding:parser-fix').run('add the test');
    expect(lastCodexArgs().slice(0, 2)).toEqual(['exec', 'resume']);
    expect(namespace()).toBe(first);
    await child('coding:other-task').run('something else');
    expect(namespace()).not.toBe(first);
    await child().run('unkeyed');
    const unkeyed = namespace();
    await child().run('unkeyed again');
    expect(namespace()).not.toBe(unkeyed);
  });
});

describe('long conversations on a cold launch', () => {
  it('keeps the checkpoint summary ahead of the newest parts, and everything under budget', () => {
    const parts = ['[Conversation checkpoint]\nsummary', 'x'.repeat(100), 'y'.repeat(100), 'newest'];
    expect(boundColdHistory(parts, 120)).toEqual([
      '[Conversation checkpoint]\nsummary',
      "[Octipus] 2 earlier messages of this conversation are left out here to fit the model's context.",
      'newest',
    ]);
    expect(boundColdHistory(parts, 10_000)).toEqual(parts);
    expect(boundColdHistory(['a'.repeat(50), 'b'], 10)).toEqual(["[Octipus] 1 earlier message of this conversation is left out here to fit the model's context.", 'b']);
  });

  it('replays only the newest transcript that fits, saying what was left out', async () => {
    const history = ['OLDEST-' + 'a'.repeat(150_000), 'old answer', 'NEWER-' + 'b'.repeat(100_000), 'newer answer'];
    const worker = makeClaudeWorker({ sessionId: 'long', history });
    await worker.run('current question');
    expect(worker.lastPrompt).not.toContain('OLDEST-');
    expect(worker.lastPrompt).toContain('NEWER-');
    expect(worker.lastPrompt).toContain('old answer');
    expect(worker.lastPrompt).toContain('newer answer');
    expect(worker.lastPrompt).toContain('1 earlier message of this conversation is left out');
    expect(worker.lastPrompt).toContain('current question');
  });

  it('retries cold on a shorter transcript when the vendor says the prompt is too long', async () => {
    await makeClaudeWorker({ sessionId: 'overflow' }).run('first');
    const before = fixture.sessions.get('overflow')!.context.cliSessions!['Claude Code']!;
    writeFileSync(failMarker(), 'Prompt is too long', 'utf-8');
    const worker = makeClaudeWorker({ sessionId: 'overflow', history: ['first', 'answer', 'NEWER-' + 'b'.repeat(60_000), 'newer answer'] });
    const spawned = fixture.spawnCount;
    const answer = await worker.run('next');
    expect(fixture.spawnCount - spawned).toBe(2);
    const after = fixture.sessions.get('overflow')!.context.cliSessions!['Claude Code']!;
    expect(after.id).not.toBe(before.id);
    expect(answer).toContain(after.id);
    // A quarter of the 192k-character budget leaves the 60k message out.
    expect(worker.lastPrompt).not.toContain('NEWER-');
    expect(worker.lastPrompt).toContain('next');
  });

  it('fails a run whose shorter retry is still too long instead of retrying again', async () => {
    writeFileSync(fixture.script, `
      console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Prompt is too long' }));
      process.exit(1);
    `);
    await expect(makeClaudeWorker({ sessionId: 'overflow-twice' }).run('question')).rejects.toThrow(/Prompt is too long/);
    expect(fixture.spawnCount).toBe(2);
  });
});


describe('Codex steering receipts', () => {
  it('migrates the old context-tool fingerprint without replacing the vendor thread', async () => {
    const store = await import('./cli-session-store');
    const fingerprintSpy = vi.spyOn(store, 'fingerprintRun');
    const first = makeCodexWorker({ sessionId: 'codex-schema-migration' });
    await first.run('First turn');
    const currentRun = fingerprintSpy.mock.calls[0][0];
    fingerprintSpy.mockRestore();
    const identity = JSON.parse(currentRun.providerIdentity!);
    identity[4] = identity[4].map((tool: unknown[]) => tool[0] === 'get_cli_run_context'
      ? [tool[0], tool[1], { type: 'object', properties: {} }] : tool);
    const legacyFingerprint = fingerprintRun({ ...currentRun, providerIdentity: JSON.stringify(identity) });
    const record = fixture.sessions.get('codex-schema-migration')!.context.cliSessions!['Codex CLI'];
    const oldId = record.id;
    const currentFingerprint = record.fingerprint;
    record.fingerprint = legacyFingerprint;
    const second = makeCodexWorker({ sessionId: 'codex-schema-migration' });
    await second.run('Second turn');
    expect(fixture.sessions.get('codex-schema-migration')!.context.cliSessions!['Codex CLI'].id).toBe(oldId);
    expect(second.fingerprint).toBe(currentFingerprint);
    const third = makeCodexWorker({ sessionId: 'codex-schema-migration' });
    third.worker.addSystemMessage('Different stable instruction');
    await third.run('Third turn');
    expect(fixture.sessions.get('codex-schema-migration')!.context.cliSessions!['Codex CLI'].id).not.toBe(oldId);
  });

  it('runs an actual Codex subprocess follow-up after guidance was only presented by a tool', async () => {
    writeFileSync(fixture.codexScript, `
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
      const marker = join(process.cwd(), 'steering-attempt');
      const second = existsSync(marker); writeFileSync(marker, prompt);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'steering-thread' }));
      console.log(JSON.stringify({ type: 'turn.started' }));
      await new Promise(r => setTimeout(r, 100));
      const answer = second && prompt.includes('Remove tower Ollama') ? 'Correction received in direct follow-up' : 'Original answer';
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
    `);
    const { worker, run } = makeCodexWorker({ sessionId: 'codex-process-steering' });
    let presented: Promise<string> | undefined;
    worker.onEvent(event => {
      if (!presented && (event.data as { type?: string }).type === 'iteration_update') {
        worker.steer({ role: 'user', content: 'Remove tower Ollama', timestamp: new Date() });
        presented = (worker as unknown as { controlContext(): Promise<string> }).controlContext();
      }
    });
    expect(await run('Deploy')).toBe('Correction received in direct follow-up');
    expect(JSON.parse(await presented!).guidanceItems).toHaveLength(1);
    expect(fixture.spawnCount).toBe(2);
  });

  it('keeps tool-presented guidance pending and starts an explicit follow-up', async () => {
    const { worker, run } = makeCodexWorker({ sessionId: 'codex-steering' });
    const internal = worker as unknown as {
      controlContext(): Promise<string>; executeCLI(): Promise<string>;
      buildPrompt(): string;
    };
    const events: unknown[] = [];
    worker.onEvent(event => events.push(event.data));
    const execute = vi.spyOn(internal, 'executeCLI').mockImplementation(async () => {
      if (execute.mock.calls.length === 1) {
        worker.steer({ role: 'user', content: 'Use the workstation Ollama; remove tower Ollama', timestamp: new Date() });
        const first = JSON.parse(await internal.controlContext());
        const second = JSON.parse(await internal.controlContext());
        expect(second.guidanceItems).toEqual(first.guidanceItems);
        return 'Original work finished';
      }
      expect(internal.buildPrompt()).toContain('Use the workstation Ollama; remove tower Ollama');
      return 'Correction handled';
    });
    expect(await run('Deploy')).toBe('Correction handled');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'steering_presented' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'steering_followup_completed' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'steering_delivered' }));
    expect(worker.steer({ role: 'user', content: 'Too late', timestamp: new Date() })).toBe(false);
  });

  it('retains guidance arriving during a follow-up for the next turn', async () => {
    const { worker, run } = makeCodexWorker({ sessionId: 'codex-overlapping-steering' });
    const internal = worker as unknown as { controlContext(): Promise<string>; executeCLI(): Promise<string>; buildPrompt(): string };
    const execute = vi.spyOn(internal, 'executeCLI').mockImplementation(async () => {
      const count = execute.mock.calls.length;
      if (count === 1) worker.steer({ role: 'user', content: 'First correction', timestamp: new Date() });
      if (count === 2) {
        worker.steer({ role: 'user', content: 'Second correction', timestamp: new Date() });
        await internal.controlContext();
      }
      if (count === 3) expect(internal.buildPrompt()).toContain('Second correction');
      return 'Done';
    });
    await run('Deploy');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('only acknowledges known guidance IDs and avoids a redundant follow-up', async () => {
    const { worker, run } = makeCodexWorker({ sessionId: 'codex-acknowledged-steering' });
    const internal = worker as unknown as { controlContext(): Promise<string>; executeCLI(): Promise<string>;
      toolExecutor: { getTools(): Map<string, { execute(args: Record<string, unknown>): Promise<string> }> } };
    const execute = vi.spyOn(internal, 'executeCLI').mockImplementation(async () => {
      worker.steer({ role: 'user', content: 'Use the existing external database', timestamp: new Date() });
      const context = JSON.parse(await internal.controlContext());
      const read = internal.toolExecutor.getTools().get('get_cli_run_context')!;
      await expect(read.execute({ acknowledgeGuidanceIds: ['missing'] })).rejects.toThrow('Unknown guidance');
      expect(JSON.parse(await internal.controlContext()).guidanceItems).toHaveLength(1);
      const acknowledged = JSON.parse(await read.execute({ acknowledgeGuidanceIds: [context.guidanceItems[0].id] }));
      expect(acknowledged.guidanceItems).toEqual([]);
      return 'Handled owner correction';
    });
    await run('Deploy');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
