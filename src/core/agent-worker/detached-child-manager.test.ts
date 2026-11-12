import { describe, expect, it, vi } from 'vitest';
import { DetachedChildManager, type ChildRequestSource } from './detached-child-manager';
import type { ChildResult, PendingChild } from '../swarm/types';

const result = (nodeId: string): ChildResult => ({
  nodeId, kind: 'subagent', status: 'ok', output: `done ${nodeId}`, usedTokens: 1, durationMs: 1, spawnedChildren: [],
});

describe('DetachedChildManager', () => {
  it('keeps a result whose collect response never reached the caller', async () => {
    const m = new DetachedChildManager('agent', () => 0, () => {});
    m.registerPendingChild({ childId: 'c1', startedAt: Date.now(), taskBrief: '', topic: 't', promise: Promise.resolve(result('c1')) });
    expect((await m.collectAll(1_000)).map(r => r.output)).toEqual(['done c1']);
    expect(m.count()).toBe(0);
    // The transport dropped that answer: the next collect must still return it.
    expect(m.redeliverLast()).toBe(1);
    expect(m.count()).toBe(1);
    expect((await m.collectAll(1_000)).map(r => r.output)).toEqual(['done c1']);
    expect(m.redeliverLast()).toBe(1);
    // Delivered is delivered: once a later collect settled nothing, there is nothing to restore.
    await m.collectAll(1_000);
    await m.collectAll(1_000);
    expect(m.redeliverLast()).toBe(0);
  });

  it('does not restore a child the collect left pending (still running)', async () => {
    const m = new DetachedChildManager('agent', () => 0, () => {});
    m.registerPendingChild({ childId: 'slow', startedAt: Date.now(), taskBrief: '', topic: 't', promise: new Promise(() => {}) });
    const [r] = await m.collectAll(10);
    expect(r.status).toBe('timeout');
    expect(m.redeliverLast()).toBe(0);
    expect(m.count()).toBe(1);
  });
});

 it('wakes collection for steering without cancelling children or losing later results', async () => {
   let finish!: (value: ChildResult) => void;
   const m = new DetachedChildManager('parent', () => 0, () => {});
   m.registerPendingChild({ childId: 'slow', startedAt: Date.now(), taskBrief: '', topic: 't', promise: new Promise(resolve => { finish = resolve; }) });
   const waiting = m.collectAll(60_000);
   m.interruptWaits();
   expect((await waiting)[0].notes).toContain('interrupted by new guidance');
   expect(m.count()).toBe(1);
   finish(result('slow'));
   expect(await m.collectAll(60_000)).toEqual([result('slow')]);
   expect(m.count()).toBe(0);
 });

 it('does not begin another wait while guidance is queued', async () => {
   const m = new DetachedChildManager('parent', () => 0, () => {}, () => true);
   m.registerPendingChild({ childId: 'slow', startedAt: Date.now(), taskBrief: '', topic: 't', promise: new Promise(() => {}) });
   expect((await m.collectAll(60_000))[0].notes).toContain('interrupted');
   expect(m.count()).toBe(1);
 });

it('a child registered again under the same id waits for its new run (#19)', async () => {
  const m = new DetachedChildManager('parent', () => 0, () => {});
  m.registerPendingChild({ childId: 'pipeline', startedAt: Date.now(), taskBrief: '', topic: 'pipeline', promise: Promise.resolve(result('first run')) });
  expect((await m.collectAll(1_000)).map(r => r.output)).toEqual(['done first run']);
  m.registerPendingChild({ childId: 'pipeline', startedAt: Date.now(), taskBrief: '', topic: 'pipeline', promise: new Promise(() => {}) });
  const [stillRunning] = await m.collectAll(10);
  expect(stillRunning.status).toBe('timeout');
});


it('an in-flight collector follows the resumed promise and never returns the previous failure (#19/#53)', async () => {
  let oldFinish!: (value: ChildResult) => void, newFinish!: (value: ChildResult) => void;
  const m = new DetachedChildManager('parent', () => 0, () => {});
  m.registerPendingChild({ childId: 'pipeline', startedAt: Date.now(), taskBrief: '', topic: 'pipeline',
    promise: new Promise(resolve => { oldFinish = resolve; }) });
  const waiting = m.collectAll(1_000);
  m.registerPendingChild({ childId: 'pipeline', startedAt: Date.now(), taskBrief: '', topic: 'pipeline',
    promise: new Promise(resolve => { newFinish = resolve; }) });
  oldFinish({ ...result('pipeline'), status: 'tool_error', output: 'previous failure', durationMs: 5_011_283 });
  newFinish({ ...result('pipeline'), output: 'resumed result' });
  expect((await waiting).map(r => r.output)).toEqual(['resumed result']);
  expect(m.redeliverLast()).toBe(1);
  expect((await m.collectAll(1_000)).map(r => r.output)).toEqual(['resumed result']);
});

it('a resumed run wakes the old collector even if the old promise never settles', async () => {
  const m = new DetachedChildManager('parent', () => 0, () => {});
  m.registerPendingChild({ childId: 'pipeline', startedAt: Date.now(), taskBrief: '', topic: 'pipeline', promise: new Promise(() => {}) });
  const waiting = m.collectAll(1_000);
  m.registerPendingChild({ childId: 'pipeline', startedAt: Date.now(), taskBrief: '', topic: 'pipeline', promise: Promise.resolve(result('new run')) });
  expect((await waiting).map(r => r.output)).toEqual(['done new run']);
});

describe('a child waiting on the user', () => {
  type Opened = Parameters<Parameters<ChildRequestSource['onRequest']>[0]>[0];
  const fakeSource = () => {
    const opened = new Set<(r: Opened) => void>();
    const resolved = new Set<(e: { requestId: string; agentId: string }) => void>();
    const source: ChildRequestSource = {
      onRequest: (h) => { opened.add(h); return () => { opened.delete(h); }; },
      onResolved: (h) => { resolved.add(h); return () => { resolved.delete(h); }; },
    };
    return {
      source,
      listeners: () => opened.size + resolved.size,
      open: (r: Partial<Opened> & { requestId: string; agentId: string }) =>
        opened.forEach(h => h({ toolId: 'shell', toolName: 'shell', args: { command: 'rm -rf build' }, ...r })),
      resolve: (requestId: string, agentId: string) => resolved.forEach(h => h({ requestId, agentId })),
    };
  };
  const child = (childId: string, agentId: string) => {
    let finish!: (value: ChildResult) => void;
    const pc: PendingChild = { childId, agentId, startedAt: Date.now(), taskBrief: '', topic: 't', promise: new Promise<ChildResult>(r => { finish = r; }) };
    return { pc, finish: () => finish(result(childId)) };
  };

  it('ends a collect_children wait with the native child marked as waiting on an approval', async () => {
    const src = fakeSource();
    const notify = vi.fn();
    const m = new DetachedChildManager('parent', () => 0, () => {}, () => false, { requests: () => src.source, notify });
    const asking = child('asking', 'agent-a');
    const sibling = child('sibling', 'agent-b');
    m.registerPendingChild(asking.pc);
    m.registerPendingChild(sibling.pc);
    const waiting = m.collectAll(60_000, { wakeOnUserRequest: true });
    src.open({ requestId: 'req-1', agentId: 'agent-a' });
    const [a, b] = await waiting;
    expect(a.userRequests).toEqual([{ id: 'req-1', kind: 'approval', summary: 'shell: rm -rf build' }]);
    expect(a.notes).toContain('collect_children paused');
    expect(b.userRequests).toBeUndefined();
    expect(b.notes).toContain('collect_children paused');
    // Neither child was cancelled, and a parent that was collecting gets no extra notice.
    expect(m.count()).toBe(2);
    expect(notify).not.toHaveBeenCalled();
    // Answered: the request clears, and the next collect returns the real result.
    src.resolve('req-1', 'agent-a');
    expect(asking.pc.userRequests).toBeUndefined();
    asking.finish(); sibling.finish();
    expect((await m.collectAll(60_000, { wakeOnUserRequest: true })).map(r => r.status)).toEqual(['ok', 'ok']);
    // Nothing pending: the process-wide listeners are released.
    expect(src.listeners()).toBe(0);
  });

  it('reports a CLI question as a question, and leaves the finalize auto-collect waiting', async () => {
    const src = fakeSource();
    const notify = vi.fn();
    const m = new DetachedChildManager('parent', () => 0, () => {}, () => false, { requests: () => src.source, notify });
    const cli = child('cli', 'agent-cli');
    m.registerPendingChild(cli.pc);
    const auto = m.collectAll(60_000);
    src.open({ requestId: 'q-1', agentId: 'agent-cli', toolId: 'cli-native:AskUserQuestion', toolName: 'CLI: AskUserQuestion',
      args: { questions: [{ question: 'Which   database?', options: [] }] } });
    expect(cli.pc.userRequests).toEqual([{ id: 'q-1', kind: 'question', summary: 'Which database?' }]);
    expect(notify).not.toHaveBeenCalled();
    cli.finish();
    expect((await auto)[0].status).toBe('ok');
  });

  it('a parent doing other work gets one notice per request, withdrawn if answered before delivery', async () => {
    const src = fakeSource();
    const withdraw = vi.fn();
    const notify = vi.fn((_content: string) => withdraw);
    const m = new DetachedChildManager('parent', () => 0, () => {}, () => false, { requests: () => src.source, notify });
    const c = child('c', 'agent-c');
    m.registerPendingChild(c.pc);
    src.open({ requestId: 'req-1', agentId: 'agent-c' });
    src.open({ requestId: 'req-other', agentId: 'someone-else' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('Subagent c is waiting on the user (approval req-1: shell: rm -rf build)');
    expect(notify.mock.calls[0][0]).toContain('cannot answer it for them');
    src.resolve('req-1', 'agent-c');
    expect(withdraw).toHaveBeenCalledTimes(1);
    src.resolve('req-1', 'agent-c');
    expect(withdraw).toHaveBeenCalledTimes(1);
    // Still open when a collect times out: the child comes back waiting, not merely running.
    src.open({ requestId: 'req-2', agentId: 'agent-c' });
    const [r] = await m.collectAll(10);
    expect(r.notes).toContain('collect_children timeout');
    expect(r.userRequests?.map(u => u.id)).toEqual(['req-2']);
  });

  it('hooks the permission manager: both request paths open and resolve through it', async () => {
    const { PermissionManager } = await import('@/security/permissions');
    const pm = new PermissionManager();
    const m = new DetachedChildManager('parent', () => 0, () => {}, () => false, { requests: () => pm });
    const c = child('c', 'agent-c');
    m.registerPendingChild(c.pc);
    const emit = pm as unknown as { emitRequest(r: unknown): void; emitResolved(r: unknown, s: string): void };
    emit.emitRequest({ requestId: 'r1', userId: 'u', agentId: 'agent-c', toolId: 'cli-native:Bash', action: 'Bash', toolName: 'CLI: Bash', args: { command: 'make' } });
    expect(c.pc.userRequests).toEqual([{ id: 'r1', kind: 'approval', summary: 'CLI: Bash: make' }]);
    emit.emitResolved({ id: 'r1', userId: 'u', agentId: 'agent-c', sessionId: null }, 'approved');
    expect(c.pc.userRequests).toBeUndefined();
    m.cancelAll('done');
  });
});
