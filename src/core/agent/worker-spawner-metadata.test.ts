/**
 * Every stage worker a pipeline spawns must carry the pipeline's own metadata
 * (`pipelineId`, `nodeKey`). Measured 2026-08-21: neither `agentManager.spawn`
 * call in `worker-spawner.ts` forwarded it, so `plan__add_items` answered
 * "Not running inside a pipeline" and every `producesPlan` / `loopOverPlan`
 * (foreach) stage was unreachable — the declaration existed, the capability
 * did not.
 *
 * Source-shape rather than behavioural: the defect was a missing field at the
 * call site, and spawning a real worker here would need the whole model/tool
 * stack to say the same thing.
 */
import { describe, expect, it } from 'vitest';
import { pipelineMetadata } from './worker-spawner';
import { fileAt } from '@/utils/fs-file';

describe('pipeline stage spawns', () => {
  it('forward contextMetadata on every agentManager.spawn call', async () => {
    const src = await fileAt(`${import.meta.dirname}/worker-spawner.ts`).text();
    const calls: string[] = [];
    // Brace-count to the matching close: a spawn literal carrying an inline
    // callback would otherwise be truncated at the callback's own `}` and the
    // assertion below would pass on a call that never forwards anything.
    for (let i = src.indexOf('agentManager.spawn('); i >= 0; i = src.indexOf('agentManager.spawn(', i + 1)) {
      let depth = 0;
      let j = src.indexOf('(', i);
      // Bounded explicitly: an unbalanced literal would otherwise walk off the
      // end and index `undefined`, turning a real failure into a TypeError.
      for (; j < src.length; j++) {
        if ('([{'.includes(src[j])) depth++;
        else if (')]}'.includes(src[j]) && --depth === 0) break;
      }
      expect(depth).toBe(0);
      calls.push(src.slice(i, j));
    }
    expect(calls.length).toBeGreaterThan(0);
    // Narrowed, never the caller's whole metadata object — see `pipelineMetadata`.
    for (const call of calls) expect(call).toContain('contextMetadata: pipelineMetadata(');
  });
});

describe('pipelineMetadata', () => {
  it('passes the two pipeline keys through', () => {
    expect(pipelineMetadata({ pipelineId: 'p1', nodeKey: 'n1' })).toEqual({ pipelineId: 'p1', nodeKey: 'n1' });
  });

  it('drops everything else, including the flags that grant authority', () => {
    const out = pipelineMetadata({
      pipelineId: 'p1',
      nodeKey: 'n1',
      isSystemUser: true,
      isAdmin: true,
      originalRequest: 'the rootAgent task',
      activeExpertId: 'e1',
    });
    expect(out).toEqual({ pipelineId: 'p1', nodeKey: 'n1' });
  });

  it('is undefined outside a pipeline, so a worker inherits no metadata at all', () => {
    expect(pipelineMetadata(undefined)).toBeUndefined();
    expect(pipelineMetadata({ isSystemUser: true })).toBeUndefined();
  });
});

describe('a delegating stage keeps the pipeline reachable', () => {
  it('forwards the pipeline keys to swarm children too', async () => {
    // A stage worker carries pipelineId/nodeKey, but when it delegates via
    // spawn_child the child got `{ originalRequest }` only — so
    // `plan__add_items` from inside the child answered "Not running inside a
    // pipeline", and a producesPlan stage that spawned a planner left no items
    // for the loop to read. Source-shape, like the assertion above: the defect
    // is a missing field at a spawn literal.
    const src = await fileAt(`${import.meta.dirname}/../swarm/spawner.ts`).text();
    const at = src.indexOf('contextMetadata: {');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('}', src.indexOf('originalRequest', at)));
    expect(block).toContain('pipelineMetadata(');
  });
});
