/**
 * Escalation is a change of MODEL, not of persona.
 *
 * It used to pick a different expert row for the same role, which ran the retry
 * on the same model with different prose — the one thing that cannot fix work
 * that failed because the model was not up to it.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetCallGraphsForTests, getCallGraph } from './call-graph';
import { createEscalateTool } from './escalate-tool';
import type { SwarmSpawner } from './spawner';
import type { AgentNode } from './types';
import * as modelRegistry from '@/models/model-registry';

const parent = {
  id: 'agent-1', rootSessionId: 'session-1', parentNodeId: null, kind: 'agent', depth: 1,
  role: 'coding', topicPath: 'build', subtopic: 's', model: 'the-model-im-on',
  budget: { tokens: { cap: 1000, used: 0 }, wallClockMs: { cap: 1000, startedAt: Date.now() }, fanOut: { cap: 2, used: 0 }, depth: 1 },
  allowedToolIds: new Set<string>(), signal: new AbortController().signal,
} as unknown as AgentNode;

const args = { topic: 'build', subtopic: 'retry', taskBrief: 'again', expectedOutput: { shape: 'summary' } };
const ctx = { userId: 'u', sessionId: 'session-1' } as never;

function spawnerCounting(counter: { n: number }): SwarmSpawner {
  return {
    spawnChild: async () => {
      counter.n++;
      return { nodeId: 'n', kind: 'agent' as const, status: 'ok' as const, output: 'ok', usedTokens: 1, durationMs: 1, spawnedChildren: [] };
    },
  } as unknown as SwarmSpawner;
}

describe('escalate_to_other_lane', () => {
  beforeEach(() => {
    __resetCallGraphsForTests();
    getCallGraph('session-1').register({
      id: parent.id, parentNodeId: null, topicPath: parent.topicPath, role: parent.role,
      briefHash: 'x', escalationUsed: false,
    });
  });

  test('refuses a lane that runs the model already running', async () => {
    const spy = vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue({
      getModelForTopic: async () => ({ modelId: 'the-model-im-on' }),
    } as never);
    const counter = { n: 0 };
    try {
      const out = await createEscalateTool(parent, spawnerCounting(counter)).execute(args, ctx);
      expect(String(out)).toMatch(/what you are running/i);
      expect(counter.n, 'a refused escalation must not spawn').toBe(0);
      // And it must not burn the one-per-lifetime slot either.
      expect(getCallGraph('session-1').hasEscalated(parent.id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('allows a lane that runs a different model', async () => {
    const spy = vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue({
      getModelForTopic: async () => ({ modelId: 'something-else' }),
    } as never);
    const counter = { n: 0 };
    try {
      const out = await createEscalateTool(parent, spawnerCounting(counter)).execute(args, ctx);
      expect(String(out)).toContain('<ChildResult');
      expect(counter.n).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('rejects a topic that is not a lane', async () => {
    const counter = { n: 0 };
    const out = await createEscalateTool(parent, spawnerCounting(counter))
      .execute({ ...args, topic: 'oauth/pkce' }, ctx);
    expect(String(out)).toMatch(/must name a lane/i);
    expect(counter.n).toBe(0);
  });
});
