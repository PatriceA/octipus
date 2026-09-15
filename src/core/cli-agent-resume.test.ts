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
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIAgentWorker } from './cli-agent-worker';
import { fingerprintRun, loadCliSession } from './cli-session-store';
import type { AgentContext } from './types';
import type { SessionContext } from '@/db/schema/sessions';

const fixture = vi.hoisted(() => ({
  script: '',
  dir: '',
  reuseSessions: false,
  cliAgent: {} as { model?: string; permissionMode?: string },
  spawnCount: 0,
  sessions: new Map<string, { id: string; userId: string; context: SessionContext }>(),
}));

vi.mock('@/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@/config')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), cli: { reuseSessions: fixture.reuseSessions } }) };
});
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (binary: string, args: string[], opts: object) => {
      if (binary !== 'claude') throw new Error(`Unexpected CLI invocation: ${binary}`);
      fixture.spawnCount++;
      const shell = (opts as { shell?: boolean }).shell === true;
      const quote = (p: string) => (shell && /\s/.test(p) ? `"${p}"` : p);
      return actual.spawn(quote(process.execPath), [quote(fixture.script), ...args], opts);
    },
  };
});
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
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: { create: async () => ({}), findBySession: async () => [] } }));
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

function makeClaudeWorker(opts: { sessionId: string; reuseSessions: boolean; model?: string; permissionMode?: string }) {
  fixture.reuseSessions = opts.reuseSessions;
  fixture.cliAgent = { model: opts.model, permissionMode: opts.permissionMode };
  makeSession(opts.sessionId, fixture.dir);

  const context: AgentContext = {
    id: `agent-${opts.sessionId}-${Math.random().toString(36).slice(2)}`,
    sessionId: opts.sessionId, userId: 'u', workspaceId: 'w', root: true,
    model: 'cli/claude-code', role: 'general', topic: 'general', status: 'idle',
    createdAt: new Date(), updatedAt: new Date(), metadata: {},
  };
  const worker = new CLIAgentWorker(context, { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });

  return {
    run: (message: string) => worker.run(message),
    fingerprint: fingerprintRun({ model: opts.model, permissionMode: opts.permissionMode, planMode: false, workingDirectory: fixture.dir }),
  };
}

const failMarker = () => join(fixture.dir, 'fail-marker');

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), 'octipus-cli-resume-'));
  fixture.script = join(fixture.dir, 'fake-claude.mjs');
  fixture.sessions = new Map();
  fixture.spawnCount = 0;
  writeFileSync(fixture.script, `
    import { readFileSync, existsSync, unlinkSync } from 'node:fs';
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
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'answer for ' + idArg, num_turns: 1 }));
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
});
