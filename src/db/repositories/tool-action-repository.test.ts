import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration } from '@/test-helpers/integration';
import { ToolActionRepository } from './tool-action-repository';

describe.skipIf(!isIntegration)('external PostgreSQL tool action journal', () => {
  beforeAll(async () => { await setupIntegrationDb(); });
  afterAll(async () => { await teardownIntegration(); });
  test('persists unresolved actions and scopes review acknowledgements', async () => {
    const repo = new ToolActionRepository();
    const userId = randomUUID(); const sessionId = randomUUID(); const id = randomUUID();
    await repo.start({ id, userId, sessionId, agentId: 'interrupted', pipelineId: 'pipeline', nodeKey: 'send',
      toolId: 'mail', toolName: 'send', argumentHash: 'hash', status: 'started' });
    expect((await new ToolActionRepository().pending(userId, sessionId))[0].id).toBe(id);
    await repo.acknowledge(randomUUID(), sessionId, [id], 'wrong-owner');
    expect(await repo.pending(userId, sessionId)).toHaveLength(1);
    await repo.finish({ id, userId, sessionId }, 'completed');
    expect(await repo.pending(userId, sessionId)).toEqual([]);
    expect(await repo.pipeline(userId, sessionId, 'pipeline')).toHaveLength(1);
    await repo.acknowledge(userId, sessionId, [id], 'explicit-review');
    expect(await repo.pipeline(userId, sessionId, 'pipeline')).toEqual([]);
  });
});
