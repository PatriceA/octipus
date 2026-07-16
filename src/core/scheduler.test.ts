import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  isIntegration,
  setupIntegrationStorage,
  teardownIntegration,
} from '@/test-helpers/integration';
import {
  classifyDueness,
  decideWakeGate,
  DEFAULT_MAX_DRIFT_SKIPS,
  evaluateWakeGate,
  registerWakeGateToolEvaluator,
  type Scheduler,
} from './scheduler';

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

  test('missed-grace: an overdue task is dropped, not run', async () => {
    // grace 0 ⇒ any past-due task is "missed". scheduledAt defaults to now,
    // so by the time getNextTask runs it is a few ms overdue.
    await scheduler.schedule('agent-1', 'stale-report', {}, { missedGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 10));

    const task = await scheduler.getNextTask();
    expect(task).toBeNull(); // skipped

    const stats = await scheduler.getStats();
    expect(stats.queueLength).toBe(0); // dropped, NOT re-queued
  });

  test('missed-grace within window still runs', async () => {
    await scheduler.schedule('agent-1', 'fresh', {}, { missedGraceMs: 60_000 });
    const task = await scheduler.getNextTask();
    expect(task).not.toBeNull();
    expect(task!.type).toBe('fresh');
  });

  test('heartbeat: writing a tick yields a fresh, non-stale heartbeat', async () => {
    // Exercise the same write the worker loop performs, without spinning up the
    // infinite loop (which would outlive the test and hit Redis post-teardown).
    await (scheduler as unknown as { maybeWriteHeartbeat(): Promise<void> }).maybeWriteHeartbeat();

    const hb = await scheduler.getHeartbeat();
    expect(hb).not.toBeNull();
    expect(hb!.stale).toBe(false);
    expect(hb!.ageMs).toBeLessThan(30_000);
  });

  test('start()/stop(): the worker loop drains a scheduled task via its handler', async () => {
    let ran = false;
    scheduler.registerHandler('lifecycle-test', async () => {
      ran = true;
      return 'ok';
    });
    await scheduler.schedule('agent-1', 'lifecycle-test', {});

    scheduler.start(1);
    // Poll until the handler runs (loop drains ~every 100ms) or time out.
    const deadline = Date.now() + 3000;
    while (!ran && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await scheduler.stop();

    expect(ran).toBe(true);
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

  describe('classifyDueness (missed-grace)', () => {
    const base = new Date('2026-07-16T12:00:00Z');

    test('future scheduledAt is not_yet', () => {
      const future = new Date(base.getTime() + 60_000);
      expect(classifyDueness(future, base)).toBe('not_yet');
      expect(classifyDueness(future, base, 1000)).toBe('not_yet');
    });

    test('past scheduledAt with no grace window is due, however late', () => {
      const past = new Date(base.getTime() - 10 * 3600_000); // 10h late
      expect(classifyDueness(past, base)).toBe('due');
    });

    test('past scheduledAt within grace is due', () => {
      const past = new Date(base.getTime() - 5_000);
      expect(classifyDueness(past, base, 30_000)).toBe('due');
    });

    test('past scheduledAt beyond grace is missed', () => {
      const past = new Date(base.getTime() - 60_000);
      expect(classifyDueness(past, base, 30_000)).toBe('missed');
    });

    test('grace of 0 makes any past-due task missed', () => {
      const past = new Date(base.getTime() - 1);
      expect(classifyDueness(past, base, 0)).toBe('missed');
    });
  });

  describe('decideWakeGate (drift fail-closed)', () => {
    test('a passing gate runs and clears drift', () => {
      expect(decideWakeGate({ run: true, reason: 'ok' }, 5, 10)).toEqual({
        decision: 'run',
        nextDriftSkips: 0,
      });
    });

    test('a legitimate skip defers and resets the drift counter', () => {
      // e.g. off-hours window — error is falsy; must never accrue toward the cap.
      expect(decideWakeGate({ run: false, reason: 'off-hours' }, 7, 10)).toEqual({
        decision: 'defer',
        nextDriftSkips: 0,
      });
    });

    test('a drift skip below the cap defers and increments', () => {
      expect(decideWakeGate({ run: false, reason: 'no evaluator', error: true }, 3, 10)).toEqual({
        decision: 'defer',
        nextDriftSkips: 4,
      });
    });

    test('a drift skip at the cap fails closed', () => {
      expect(decideWakeGate({ run: false, reason: 'no evaluator', error: true }, 9, 10)).toEqual({
        decision: 'fail_closed',
        nextDriftSkips: 10,
      });
    });
  });

  describe('evaluateWakeGate drift flag', () => {
    test('a tool gate with no registered evaluator is drift (error:true)', async () => {
      const res = await evaluateWakeGate({ kind: 'tool', toolName: 'nope', params: {} });
      expect(res.run).toBe(false);
      expect(res.error).toBe(true);
    });

    test('a tool gate that evaluates to falsy is a legit skip, not drift', async () => {
      registerWakeGateToolEvaluator(async () => false);
      const res = await evaluateWakeGate({ kind: 'tool', toolName: 'x', params: {} });
      expect(res.run).toBe(false);
      expect(res.error).toBeFalsy();
      registerWakeGateToolEvaluator(async () => true);
      const ok = await evaluateWakeGate({ kind: 'tool', toolName: 'x', params: {} });
      expect(ok.run).toBe(true);
    });

    test('DEFAULT_MAX_DRIFT_SKIPS is a sane positive cap', () => {
      expect(DEFAULT_MAX_DRIFT_SKIPS).toBeGreaterThan(0);
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
