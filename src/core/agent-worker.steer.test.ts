/**
 * AgentWorker.steer headroom — a steer must not be dropped just because the
 * loop was about to hit maxIterations. steer() grants one extra iteration so
 * the final-iteration drain (agent-worker.ts) can honor a late mid-run message.
 */
import { describe, expect, test } from 'vitest';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentContext, AgentMessage } from '@/core/types';

const mkCtx = (over: Partial<AgentContext> = {}): AgentContext => ({
  id: 'w-steer',
  sessionId: '00000000-0000-0000-0000-000000000000',
  userId: 'u-1',
  topic: 'test',
  model: 'test-model',
  role: 'general',
  status: 'idle',
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: {},
  ...over,
});

const cfg = { maxIterations: 3, contextWindowSize: 100_000, timeout: 60_000, maxTokenBudget: 100_000 };
const msg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: new Date() });

describe('AgentWorker.steer', () => {
  test('queues the message and grants one iteration of headroom per steer', () => {
    const worker = new AgentWorker(mkCtx(), { ...cfg });
    const internals = worker as unknown as {
      config: { maxIterations: number };
      steeringQueue: AgentMessage[];
    };

    expect(internals.config.maxIterations).toBe(3);
    expect(internals.steeringQueue.length).toBe(0);

    worker.steer(msg('change course'));
    expect(internals.config.maxIterations).toBe(4);
    expect(internals.steeringQueue.length).toBe(1);
    expect(internals.steeringQueue[0].content).toBe('change course');

    worker.steer(msg('and also this'));
    expect(internals.config.maxIterations).toBe(5);
    expect(internals.steeringQueue.length).toBe(2);
  });
});
