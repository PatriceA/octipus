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
import { describe, expect, it } from 'bun:test';

describe('pipeline stage spawns', () => {
  it('forward contextMetadata on every agentManager.spawn call', async () => {
    const src = await Bun.file(`${import.meta.dir}/worker-spawner.ts`).text();
    const calls: string[] = [];
    // Brace-count to the matching close: a spawn literal carrying an inline
    // callback would otherwise be truncated at the callback's own `}` and the
    // assertion below would pass on a call that never forwards anything.
    for (let i = src.indexOf('agentManager.spawn('); i >= 0; i = src.indexOf('agentManager.spawn(', i + 1)) {
      let depth = 0;
      let j = src.indexOf('(', i);
      for (; j < src.length; j++) {
        if ('([{'.includes(src[j])) depth++;
        else if (')]}'.includes(src[j]) && --depth === 0) break;
      }
      calls.push(src.slice(i, j));
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('contextMetadata:');
  });
});
