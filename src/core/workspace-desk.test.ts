import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '@/db/schema/agents';
import type { Session } from '@/db/schema/sessions';
import type { WorkPlan } from '@/shared/work-plan';
import type { Principal } from '@/security/principal';
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), own: vi.fn(), findSession: vi.fn(), count: vi.fn(), history: vi.fn(), pipeline: vi.fn(), pending: vi.fn(), tools: vi.fn(), content: vi.fn() }));
vi.mock('@/db/repositories/content', () => ({ contentRepos: mocks.content }));
vi.mock('./agent-manager', () => ({ getAgentManager: () => ({ list: mocks.list, get: mocks.get }) }));
vi.mock('./agent/service', () => ({ getAgentService: () => ({ getPendingApprovals: mocks.pending }) }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ getPendingRequests: mocks.tools }) }));
import { projectDeskSession, readWorkspaceDesk } from './workspace-desk';
const now = new Date('2026-11-09T12:00:00Z');
const session = { id: 's1', userId: 'owner', workspaceId: 'workspace', title: 'Life2', status: 'active', updatedAt: now } as Session;
const principal = { kind: 'user', userId: 'owner', workspaceId: 'workspace' } as Principal;
const run = (status: AgentRecord['status']) => ({ id: 'a1', sessionId: 's1', userId: 'owner', workspaceId: 'workspace', role: 'general', status, createdAt: now, completedAt: status === 'running' ? null : now } as AgentRecord);
const plan: WorkPlan = { id: 'plan', revision: 3, kind: 'execution', title: 'Release', goal: 'Ship', updatedAt: now.toISOString(), feedback: [], history: [{ revision: 3, at: now.toISOString(), summary: 'Phone acceptance added after review' }], steps: [
  { id: 'test', title: 'Run tests', status: 'done', evidence: 'Tests passed' }, { id: 'phone', title: 'Check phone', status: 'pending', evidence: '' },
] };
describe('project desk evidence', () => {
  it('does not treat an orphan running row or a working plan as confirmed live work', () => {
    expect(projectDeskSession(session, plan, [run('running')], false, false, null, true).state).toBe('unknown');
    expect(projectDeskSession(session, plan, [run('running')], true, false, null, true).state).toBe('working');
  });
  it('keeps completed run, owner decision, failure and deliberate pause distinct', () => {
    expect(projectDeskSession(session, plan, [run('completed')], false, false, null, true).state).toBe('updated');
    expect(projectDeskSession(session, plan, [], true, true, null, true).state).toBe('needs_you');
    expect(projectDeskSession(session, plan, [run('failed')], false, false, null, true).state).toBe('blocked');
    expect(projectDeskSession({ ...session, status: 'paused' }, plan, [], false, true, null, true).state).toBe('paused');
  });
  it('surfaces changes and recorded outcomes without deriving a project percentage', () => {
    const result = projectDeskSession(session, plan, [run('completed')], false, false, null, true);
    expect(result.plan?.changes[0].summary).toContain('Phone acceptance added');
    expect(result.outcome).toContain('Run tests');
    expect(result.next).toBe('Check phone');
    expect(result).not.toHaveProperty('progress');
    expect(result).not.toHaveProperty('percent');
  });
  it('missing observation is unknown, never all clear', () => {
    expect(projectDeskSession(session, null, [], false, false, null, false).state).toBe('unknown');
  });
});
describe('desk scope and partial failures', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.list.mockReturnValue([]); mocks.get.mockReturnValue({ getContext: () => ({ metadata: {} }) }); mocks.own.mockResolvedValue([session]); mocks.count.mockResolvedValue(1);
    mocks.history.mockResolvedValue([]); mocks.pending.mockReturnValue([]); mocks.tools.mockResolvedValue([]); mocks.pipeline.mockResolvedValue(null);
    mocks.content.mockReturnValue({ kind: 'personal', sessions: { listOwn: mocks.own, countOwn: mocks.count, findById: mocks.findSession }, agents: { findBySession: mocks.history }, pipelines: { findById: mocks.pipeline } });
  });
  it('uses the principal’s own bounded repositories, without returning raw context', async () => {
    const result = await readWorkspaceDesk(principal);
    expect(mocks.content).toHaveBeenCalledWith(principal); expect(mocks.own).toHaveBeenCalledWith(30);
    expect(result.sessions[0]).not.toHaveProperty('context'); expect(result.total).toBe(1);
  });
  it('never loads personal work through a shared-space door', async () => {
    mocks.content.mockReturnValue({ kind: 'space' });
    expect((await readWorkspaceDesk(principal)).sessions).toEqual([]); expect(mocks.own).not.toHaveBeenCalled();
  });
  it('does not import another user/workspace via live agent references', async () => {
    mocks.list.mockReturnValue([{ userId: 'owner', sessionId: 'foreign', status: 'running' }, { userId: 'other', sessionId: 'other', status: 'running' }]);
    mocks.findSession.mockResolvedValue({ ...session, id: 'foreign', userId: 'other' });
    const result = await readWorkspaceDesk(principal);
    expect(result.sessions.map(item => item.id)).toEqual(['s1']); expect(mocks.findSession).not.toHaveBeenCalledWith('other');
  });
  it('reports failed history queries and preserves uncertainty', async () => {
    mocks.history.mockRejectedValue(new Error('database unavailable'));
    const result = await readWorkspaceDesk(principal);
    expect(result.warnings).toContain('Run history is unavailable.'); expect(result.sessions[0].state).toBe('unknown');
  });
});

describe('desk discovery regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.list.mockReturnValue([]); mocks.get.mockReturnValue({ getContext: () => ({ metadata: {} }) });
    mocks.own.mockResolvedValue([session]); mocks.count.mockResolvedValue(31); mocks.history.mockResolvedValue([]);
    mocks.pending.mockReturnValue([]); mocks.tools.mockResolvedValue([]); mocks.pipeline.mockResolvedValue(null);
    mocks.content.mockReturnValue({ kind: 'personal', sessions: { listOwn: mocks.own, countOwn: mocks.count, findById: mocks.findSession }, agents: { findBySession: mocks.history }, pipelines: { findById: mocks.pipeline } });
  });
  it('includes an old session with a pending decision outside the recent list', async () => {
    mocks.pending.mockReturnValue([{ sessionId: 'old' }]); mocks.findSession.mockResolvedValue({ ...session, id: 'old' });
    expect((await readWorkspaceDesk(principal)).sessions[0]).toMatchObject({ id: 'old', state: 'needs_you' });
  });
  it('does not mistake read-only Companion briefings for execution', async () => {
    mocks.list.mockReturnValue([{ id: 'briefing', userId: 'owner', sessionId: 's1', status: 'running' }]);
    mocks.get.mockReturnValue({ getContext: () => ({ metadata: { companionBriefing: true } }) });
    expect((await readWorkspaceDesk(principal)).sessions[0].state).toBe('idle');
  });
  it.each(['userId', 'workspaceId', 'sessionId'])('rejects a saved pipeline from a different %s, even for an admin', async field => {
    mocks.own.mockResolvedValue([{ ...session, metadata: { workPlan: { revision: 3, current: { ...plan, sourcePipelineId: 'foreign' }, previous: [] } } }]);
    mocks.pipeline.mockResolvedValue({ id: 'foreign', status: 'paused', userId: 'owner', workspaceId: 'workspace', sessionId: 's1', [field]: 'other' });
    const result = await readWorkspaceDesk(principal);
    expect(result.sessions[0].pipelineId).toBeNull(); expect(result.sessions[0].state).toBe('unknown');
  });
  it('marks a missing or inaccessible declared pipeline unconfirmed', async () => {
    mocks.own.mockResolvedValue([{ ...session, metadata: { workPlan: { revision: 3, current: { ...plan, sourcePipelineId: 'missing' }, previous: [] } } }]);
    mocks.pipeline.mockResolvedValue(null);
    const result = await readWorkspaceDesk(principal);
    expect(result.sessions[0].state).toBe('unknown'); expect(result.warnings).toContain('A saved pipeline state is unavailable.');
  });
  it('reads a separate bounded history for every session', async () => {
    mocks.own.mockResolvedValue([session, { ...session, id: 's2' }]);
    mocks.history.mockImplementation(async id => id === 's2' ? [{ ...run('failed'), sessionId: 's2' }] : [run('completed')]);
    const result = await readWorkspaceDesk(principal);
    expect(mocks.history).toHaveBeenCalledWith('s1', 4); expect(mocks.history).toHaveBeenCalledWith('s2', 4);
    expect(result.sessions.find(item => item.id === 's2')?.state).toBe('blocked');
  });
});
