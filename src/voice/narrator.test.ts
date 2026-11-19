import { describe, expect, test } from 'vitest';
import { demo, narrate } from './narrator';

describe('narrator', () => {
  test('the selection rules hold', () => {
    expect(() => demo()).not.toThrow();
  });

  test('the agent answering the turn is never announced; an agent it starts is', () => {
    // The root agent runs as `general`: without the `root` mark every spoken
    // turn began with "On it — I've started the general".
    expect(narrate({ type: 'worker_spawned', data: { agentId: 'a1', role: 'general', root: true, model: 'm' } })).toBeNull();
    expect(narrate({ type: 'worker_completed', data: { workerId: 'a1', role: 'general', root: true } })).toBeNull();
    expect(narrate({ type: 'worker_spawned', data: { workerId: 'w1', role: 'research' } })).toBe('On it — I\'ve started the research. I\'ll let you know when it\'s done.');
    expect(narrate({ type: 'worker_completed', data: { workerId: 'w1', role: 'research' } })).toBe('The research just finished.');
  });
});
