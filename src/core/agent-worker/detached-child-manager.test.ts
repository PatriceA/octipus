import { describe, expect, it } from 'vitest';
import { DetachedChildManager } from './detached-child-manager';
import type { ChildResult } from '../swarm/types';

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
