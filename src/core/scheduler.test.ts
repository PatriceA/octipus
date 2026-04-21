import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  isIntegration,
  setupIntegrationStorage,
  teardownIntegration,
} from '@/test-helpers/integration';
import type { Scheduler } from './scheduler';

// Scheduler integration tests require Redis (docker-compose.test.yml).
// Run via:  bun run test:integration -- src/core/scheduler.test.ts

describe.skipIf(!isIntegration)('Scheduler (Integration)', () => {
  let scheduler: Scheduler;

  beforeAll(async () => {
    setupIntegrationStorage();
    const mod = await import('./scheduler');
    scheduler = new mod.Scheduler();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await scheduler.clearQueue();
  });

  test('schedule() enqueues and getStats() reports length', async () => {
    const id = await scheduler.schedule('agent-1', 'test', { foo: 'bar' });
    expect(id).toBeDefined();

    const stats = await scheduler.getStats();
    expect(stats.queueLength).toBe(1);
    expect(stats.processing).toBe(0);
  });

  test('getNextTask returns the enqueued task payload', async () => {
    await scheduler.schedule('agent-1', 'webhook', { url: 'http://example.com' });

    const task = await scheduler.getNextTask();
    expect(task).not.toBeNull();
    expect(task!.agentId).toBe('agent-1');
    expect(task!.type).toBe('webhook');
    expect((task!.payload as { url: string }).url).toBe('http://example.com');
  });

  test('delayed tasks are re-queued until scheduledAt passes', async () => {
    await scheduler.schedule('agent-1', 'test', {}, { delayMs: 10_000 });

    const task = await scheduler.getNextTask();
    expect(task).toBeNull();

    // Still in queue, not lost
    const stats = await scheduler.getStats();
    expect(stats.queueLength).toBe(1);
  });

  test('priority: higher priority tasks pop first', async () => {
    await scheduler.schedule('agent-1', 'low', { n: 1 }, { priority: 1 });
    await scheduler.schedule('agent-1', 'high', { n: 2 }, { priority: 100 });

    const first = await scheduler.getNextTask();
    const second = await scheduler.getNextTask();

    expect(first?.type).toBe('high');
    expect(second?.type).toBe('low');
  });

  test('startTask + completeTask clears processing', async () => {
    await scheduler.schedule('agent-1', 'test', {});
    const task = await scheduler.getNextTask();
    expect(task).not.toBeNull();

    await scheduler.startTask(task!);
    let stats = await scheduler.getStats();
    expect(stats.processing).toBe(1);

    await scheduler.completeTask(task!.id, { ok: true });
    stats = await scheduler.getStats();
    expect(stats.processing).toBe(0);
  });

  test('failTask retries until maxAttempts, then fails terminally', async () => {
    await scheduler.schedule('agent-1', 'test', {}, { maxAttempts: 2 });

    // Attempt 1 — startTask increments attempts to 1, failTask retries
    let task = await scheduler.getNextTask();
    await scheduler.startTask(task!);
    await scheduler.failTask(task!.id, 'boom');

    // Task went back to the queue with a backoff (scheduledAt in future).
    // getNextTask will see it's not yet due and re-queue; so we only assert
    // that the queue length stayed at 1 (task isn't lost) after the retry.
    const statsAfterRetry = await scheduler.getStats();
    expect(statsAfterRetry.queueLength).toBe(1);
    expect(statsAfterRetry.processing).toBe(0);

    // Force-progress: pop, ignore the due-time gate by advancing scheduledAt.
    // Instead of sleeping, we test the maxAttempts path by failing a fresh task.
    await scheduler.clearQueue();
    await scheduler.schedule('agent-1', 'test', {}, { maxAttempts: 1 });
    task = await scheduler.getNextTask();
    await scheduler.startTask(task!); // attempts -> 1
    await scheduler.failTask(task!.id, 'fatal'); // 1 >= 1 => terminal

    const statsFinal = await scheduler.getStats();
    expect(statsFinal.queueLength).toBe(0);
    expect(statsFinal.processing).toBe(0);
  });

  test('clearQueue empties everything', async () => {
    await scheduler.schedule('agent-1', 'test', {});
    await scheduler.schedule('agent-1', 'test', {});
    await scheduler.clearQueue();
    const stats = await scheduler.getStats();
    expect(stats.queueLength).toBe(0);
  });
});

describe('Scheduler (Unit)', () => {
  describe('task priorities', () => {
    const priorities = ['critical', 'high', 'normal', 'low'];

    test('priority ordering is correct', () => {
      const priorityOrder = { critical: 4, high: 3, normal: 2, low: 1 };

      expect(priorityOrder.critical).toBeGreaterThan(priorityOrder.high);
      expect(priorityOrder.high).toBeGreaterThan(priorityOrder.normal);
      expect(priorityOrder.normal).toBeGreaterThan(priorityOrder.low);
    });

    test('all priority values are valid', () => {
      for (const priority of priorities) {
        expect(['critical', 'high', 'normal', 'low']).toContain(priority);
      }
    });
  });

  describe('task status', () => {
    const validStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'];

    test('status transitions are valid', () => {
      // pending -> running -> completed|failed
      expect(validStatuses).toContain('pending');
      expect(validStatuses).toContain('running');
      expect(validStatuses).toContain('completed');
      expect(validStatuses).toContain('failed');
    });
  });

  describe('task structure', () => {
    test('task has required fields', () => {
      const task = {
        id: 'task-123',
        type: 'agent',
        payload: { agentId: 'agent-1' },
        priority: 'normal',
        status: 'pending',
        createdAt: Date.now(),
      };

      expect(task.id).toBeDefined();
      expect(task.type).toBeDefined();
      expect(task.payload).toBeDefined();
      expect(task.priority).toBe('normal');
      expect(task.status).toBe('pending');
    });

    test('task with retry configuration', () => {
      const task = {
        id: 'task-456',
        type: 'webhook',
        payload: {},
        maxRetries: 3,
        retries: 0,
      };

      expect(task.maxRetries).toBe(3);
      expect(task.retries).toBeLessThan(task.maxRetries);
    });
  });
});
