/**
 * Task 6 fix round 1 — Important 2: `runRootAgent()` had no coverage
 * anywhere in the repo, so the half of Task 6 that strips the
 * compaction-summary/recent-history volatile blocks was verified only by
 * hand-tracing. `runRootAgent()` itself needs a huge fixture (tool sets,
 * hooks, swarm nodes, spawn wiring) unrelated to Task 6, so this drives the
 * smallest real seam that still exercises the gate: `buildPreHookVolatileParts`
 * and `buildHistoryVolatileParts`, the two functions root-runner.ts split the
 * volatile-block assembly into so this could be tested without that fixture.
 * `buildHistoryVolatileParts` calls the REAL `willResumeCliSession` /
 * `resolveCliModelEntry` / `fingerprintRun` — only the DB repositories and
 * model registry underneath them are mocked — so this proves the actual gate,
 * not a hand-rolled stand-in for it.
 *
 * What remains uncovered: everything else `runRootAgent()` does (tool
 * assembly, the before-agent-start hook's side effects, expert index,
 * workspace/repo-suite injection, spawn wiring) — none of which Task 6
 * touches.
 */
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleSystemPrompt, buildHistoryVolatileParts, buildPreHookVolatileParts } from './root-runner';
import { fingerprintRun } from '@/core/cli-session-store';
import { WorkspaceFS } from '@/security/workspace-fs';
import type { SessionContext } from '@/db/schema/sessions';

const fixture = vi.hoisted(() => ({
  reuseSessions: false,
  session: undefined as { id: string; userId: string; context: SessionContext } | undefined,
  cliAgent: {} as { model?: string; permissionMode?: string },
  recentHistory: [] as { role: string; content: string }[],
  compactionSummary: undefined as string | undefined,
}));

vi.mock('@/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@/config')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), cli: { reuseSessions: fixture.reuseSessions } }) };
});
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: async (id: string) => (fixture.session?.id === id ? { ...fixture.session } : undefined) },
}));
vi.mock('@/db/repositories/message-repository', () => ({
  messageRepository: { findRecentBySession: async () => fixture.recentHistory },
}));
vi.mock('@/db/repositories/compaction-entry-repository', () => ({
  compactionEntryRepository: { findLatest: async () => (fixture.compactionSummary ? { summary: fixture.compactionSummary } : undefined) },
}));
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModel: async () => null,
    getModelByModelId: async () => ({ name: 'claude-code', metadata: { cliAgent: fixture.cliAgent } }),
  }),
}));

const SESSION_ID = 's1';
const MODEL_NAME = 'cli/claude-code';
const ADAPTER_KEY = 'Claude Code';

beforeEach(() => {
  fixture.reuseSessions = false;
  fixture.session = undefined;
  fixture.cliAgent = {};
  fixture.recentHistory = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }];
  fixture.compactionSummary = 'a prior summary';
});

afterEach(() => vi.clearAllMocks());

// Wires a session whose stored cliSessions[adapterKey] record matches the
// fingerprint buildHistoryVolatileParts will compute for MODEL_NAME/ADAPTER_KEY
// — i.e. a session that WILL resume, the same way cli-agent-worker.ts decides it.
function makeResumableSession(projectPath: string) {
  // Same resolution buildHistoryVolatileParts uses:
  // resolve(WorkspaceFS.forSession(session).root).
  const workingDirectory = resolve(WorkspaceFS.forSession({ userId: 'u', context: { devMode: true, projectPath } }).root);
  const fingerprint = fingerprintRun({
    model: fixture.cliAgent.model, permissionMode: fixture.cliAgent.permissionMode,
    planMode: false, workingDirectory,
  });
  fixture.session = {
    id: SESSION_ID, userId: 'u',
    context: { devMode: true, projectPath, cliSessions: { [ADAPTER_KEY]: { id: 'vendor-1', fingerprint, lastUsedAt: new Date().toISOString(), reportedTokens: 0 } } } as SessionContext,
  };
}

describe('runRootAgent volatile-prompt assembly — CLI resume gate', () => {
  it('drops the summary/history blocks but keeps date/memory/security when the turn will resume', async () => {
    fixture.reuseSessions = true;
    makeResumableSession('/tmp/octipus-resume-fixture');

    const pre = buildPreHookVolatileParts('MEMORY-BLOCK-MARKER', ['sql-injection-attempt']);
    const history = await buildHistoryVolatileParts({
      sessionId: SESSION_ID, modelName: MODEL_NAME, session: fixture.session, isLite: false,
    });
    const prompt = assembleSystemPrompt(['STATIC-PREFIX'], [...pre, ...history.parts]);

    expect(history.resumingCliSession).toBe(true);
    expect(prompt).toContain('CURRENT DATE & TIME');
    expect(prompt).toContain('MEMORY-BLOCK-MARKER');
    expect(prompt).toContain('sql-injection-attempt');
    expect(prompt).not.toContain('Previous conversation summary');
    expect(prompt).not.toContain('Recent conversation history');
    expect(prompt).not.toContain('old question');
  });

  it('keeps the summary/history blocks (plus date/memory/security) on a cold run', async () => {
    fixture.reuseSessions = true;
    // No stored cliSessions record for this session — loadCliSession finds
    // nothing, so willResumeCliSession is false regardless of reuseSessions.
    fixture.session = { id: SESSION_ID, userId: 'u', context: { devMode: true, projectPath: '/tmp/octipus-cold-fixture' } as SessionContext };

    const pre = buildPreHookVolatileParts('MEMORY-BLOCK-MARKER', ['sql-injection-attempt']);
    const history = await buildHistoryVolatileParts({
      sessionId: SESSION_ID, modelName: MODEL_NAME, session: fixture.session, isLite: false,
    });
    const prompt = assembleSystemPrompt(['STATIC-PREFIX'], [...pre, ...history.parts]);

    expect(history.resumingCliSession).toBe(false);
    expect(prompt).toContain('CURRENT DATE & TIME');
    expect(prompt).toContain('MEMORY-BLOCK-MARKER');
    expect(prompt).toContain('sql-injection-attempt');
    expect(prompt).toContain('Previous conversation summary');
    expect(prompt).toContain('a prior summary');
    expect(prompt).toContain('Recent conversation history');
    expect(prompt).toContain('old question');
  });

  it('also resumes when reuse is on but the setting check alone would allow it — still requires a matching stored fingerprint', async () => {
    // reuseSessions on, but no stored session at all (e.g. first-ever turn):
    // must NOT resume, so history renders.
    fixture.reuseSessions = true;
    fixture.session = { id: SESSION_ID, userId: 'u', context: {} as SessionContext };

    const history = await buildHistoryVolatileParts({
      sessionId: SESSION_ID, modelName: MODEL_NAME, session: fixture.session, isLite: false,
    });

    expect(history.resumingCliSession).toBe(false);
    expect(history.parts.join('')).toContain('Recent conversation history');
  });
});
