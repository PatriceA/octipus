import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { MonitorRepository } from '@/db/repositories/monitor-repository';
import { MonitorService } from './service';
import { withSessionTurn } from '@/core/session-turn-lock';
import { createMonitorSchema, matches } from './types';
import type { getDb } from '@/db/postgres';
import type { AgentContext } from '@/core/types';

const mocks = vi.hoisted(() => ({ session: vi.fn(), probe: vi.fn(), resumed: vi.fn(), published: vi.fn(), outcome: 'success' as 'success' | 'failed' | 'cancelled' }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: mocks.session } }));
vi.mock('./probes', () => ({ probe: mocks.probe, readProbe: () => ({ toolId: 'filesystem' }) }));
vi.mock('@/core/agent/service', () => ({ getAgentService: () => ({ publishResponse: mocks.published, handleMessage: async (sessionId: string, _user: string, message: string, _channel: string, _files: unknown, _mode: unknown, before: () => Promise<void>) => withSessionTurn(sessionId, async () => {
  await before(); mocks.resumed(message); return { agentId: 'agent', response: mocks.outcome === 'success' ? 'Done' : 'Continuation failed or was stopped', outcome: mocks.outcome };
}) }) }));

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const context: AgentContext = { id: '33333333-3333-4333-8333-333333333333', userId, sessionId, role: 'general', topic: 'general', model: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} };
let pg: PGlite;
let repo: MonitorRepository;
let service: MonitorService;
const browser = { kind: 'browser' as const, tabId: 42, url: 'https://ci.example/runs/123', selector: '#run-status', condition: { path: 'text', operator: 'in' as const, value: ['Succeeded', 'Failed', 'Cancelled'] } };
const config = { name: 'Pipeline 123', continuation: 'Inspect the result of run 123 and report.', source: browser };
const observed = { reason: 'matched' as const, observedAt: new Date().toISOString(), value: 'Succeeded' };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE sessions(id uuid PRIMARY KEY);');
  await pg.exec(readFileSync('src/db/migrations/0110_session_monitors.sql', 'utf8'));
  await pg.query('INSERT INTO users VALUES ($1)', [userId]);
  await pg.query('INSERT INTO sessions VALUES ($1)', [sessionId]);
  const db = drizzle(pg);
  repo = new MonitorRepository(() => db as unknown as ReturnType<typeof getDb>);
  service = new MonitorService(repo);
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('TRUNCATE monitors');
  mocks.session.mockReset().mockResolvedValue({ id: sessionId, userId, status: 'active', context: {}, workspaceId: null });
  mocks.probe.mockReset().mockResolvedValue({ text: 'Running' });
  mocks.resumed.mockReset(); mocks.published.mockReset(); mocks.outcome = 'success';
});

describe('persistent monitor lifecycle', () => {
  test('waits without a model, then continues the same session once', async () => {
    const row = await service.create(config, context);
    await service.check(row, new Date(Date.now() + 1));
    expect((await repo.get(row.id)).status).toBe('armed');
    expect(mocks.resumed).not.toHaveBeenCalled();
    mocks.probe.mockResolvedValue({ text: 'Succeeded' });
    await service.check(row, new Date(Date.now() + 31_000));
    const ready = await repo.get(row.id);
    expect(ready.status).toBe('ready');
    await Promise.all([service.deliver(ready), service.deliver(ready)]);
    expect(mocks.resumed).toHaveBeenCalledTimes(1);
    expect(mocks.resumed.mock.calls[0][0]).toContain('Inspect the result of run 123');
    expect((await repo.get(row.id)).status).toBe('completed');
    expect(mocks.published).toHaveBeenCalledTimes(1);
  });
  test.each(['failed', 'cancelled'] as const)('a %s continuation is visible and needs review even with an agentId', async outcome => {
    mocks.outcome = outcome;
    const row = await service.create(config, context);
    await repo.ready(row.id, observed);
    await service.deliver(await repo.get(row.id));
    expect((await repo.get(row.id)).status).toBe('blocked');
    expect(mocks.published).toHaveBeenCalledWith(sessionId, userId, expect.objectContaining({ outcome, agentId: 'agent' }));
    expect((await repo.get(row.id)).lastError).toContain('failed or was stopped');
  });
  test.each(['Failed', 'Cancelled'])('wakes on terminal %s, not just success', async status => {
    mocks.probe.mockResolvedValue({ text: status });
    const row = await service.create(config, context);
    await service.check(row, new Date(Date.now() + 1));
    expect((await repo.get(row.id)).observation?.value).toBe(status);
  });
  test('missing element, changed URL and disconnect stay pending with a visible error', async () => {
    const row = await service.create(config, context);
    mocks.probe.mockResolvedValue({ error: 'Monitored tab changed URL or requires login' });
    await service.check(row, new Date(Date.now() + 1));
    expect((await repo.get(row.id)).status).toBe('armed');
    expect((await repo.get(row.id)).lastError).toContain('changed URL');
    mocks.probe.mockRejectedValue(new Error('Disconnected'));
    await service.check(row, new Date(Date.now() + 31_000));
    expect((await repo.get(row.id)).lastError).toBe('Disconnected');
    mocks.probe.mockResolvedValue({});
    await service.check(row, new Date(Date.now() + 62_000));
    expect((await repo.get(row.id)).lastError).toBe('Observed field is missing');
  });
  test('deadline produces a timeout wake with the last failure, no probe', async () => {
    const row = await service.create({ ...config, timeoutSeconds: 30 }, context);
    await service.check(row, new Date(Date.now() + 31_000));
    expect((await repo.get(row.id)).observation?.reason).toBe('timeout');
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  test('changed establishes a baseline and waits for a real change', async () => {
    const row = await service.create({ ...config, source: { ...browser, condition: { path: 'text', operator: 'changed' } } }, context);
    await service.check(row, new Date(Date.now() + 1));
    expect((await repo.get(row.id)).status).toBe('armed');
    await service.check(row, new Date(Date.now() + 31_000));
    expect((await repo.get(row.id)).status).toBe('armed');
    mocks.probe.mockResolvedValue({ text: 'Succeeded' });
    await service.check(row, new Date(Date.now() + 62_000));
    expect((await repo.get(row.id)).status).toBe('ready');
  });
  test('one check lease wins; an old check cannot overwrite a newer lease', async () => {
    const row = await service.create(config, context);
    const now = new Date(Date.now() + 1);
    const token = '44444444-4444-4444-8444-444444444444';
    expect(await repo.claimCheck(row.id, token, now)).toBeTruthy();
    expect(await repo.claimCheck(row.id, context.id, now)).toBeUndefined();
    expect(await repo.claimCheck(row.id, context.id, new Date(now.getTime() + 61_000))).toBeTruthy();
    await repo.checked(row, token, { status: 'ready', observation: observed });
    expect((await repo.get(row.id)).status).toBe('armed');
  });
  test('pause/cancel wins over an in-flight check', async () => {
    const row = await service.create(config, context);
    await repo.claimCheck(row.id, context.id, new Date(Date.now() + 1));
    await service.control(row.id, userId, sessionId, 'pause');
    await repo.checked(row, context.id, { status: 'ready', observation: observed });
    expect((await repo.get(row.id)).status).toBe('paused');
    await service.control(row.id, userId, sessionId, 'resume');
    expect((await repo.get(row.id)).status).toBe('armed');
    await service.control(row.id, userId, sessionId, 'cancel');
    await service.check(row, new Date(Date.now() + 1));
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  test('queued wake can be cancelled while a user turn holds the session', async () => {
    const row = await service.create(config, context);
    await repo.ready(row.id, observed);
    let release!: () => void;
    const userTurn = withSessionTurn(sessionId, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const wake = service.deliver(await repo.get(row.id));
    await service.control(row.id, userId, sessionId, 'cancel');
    release(); await userTurn; await wake;
    expect(mocks.resumed).not.toHaveBeenCalled();
  });
  test('pending wake survives a new service instance', async () => {
    const row = await service.create(config, context);
    await repo.ready(row.id, observed);
    const restarted = new MonitorService(new MonitorRepository(() => drizzle(pg) as unknown as ReturnType<typeof getDb>));
    await restarted.deliver((await repo.pending())[0]);
    expect(mocks.resumed).toHaveBeenCalledTimes(1);
  });
  test('interrupted delivery is blocked for review instead of replayed', async () => {
    const row = await service.create(config, context);
    await repo.ready(row.id, observed);
    await repo.transition(row.id, ['ready'], 'delivering', { leaseUntil: new Date(0) });
    await repo.recover(new Date());
    expect((await repo.get(row.id)).status).toBe('blocked');
    expect(await repo.pending()).toHaveLength(0);
  });
  test('clearing a session cancels its outstanding continuation', async () => {
    const row = await service.create(config, context);
    await repo.ready(row.id, observed);
    mocks.session.mockResolvedValue({ userId, status: 'active', context: { conversationGeneration: 'new' } });
    await service.deliver(await repo.get(row.id));
    expect((await repo.get(row.id)).status).toBe('cancelled');
    expect(mocks.resumed).not.toHaveBeenCalled();
  });
  test('another owner cannot create or control monitors in this session', async () => {
    const row = await service.create(config, context);
    await expect(service.control(row.id, '55555555-5555-4555-8555-555555555555', sessionId, 'cancel')).rejects.toThrow('not found');
    await expect(service.create(config, { ...context, userId: '55555555-5555-4555-8555-555555555555' })).rejects.toThrow('not found');
  });
  test('browser tabs stay retained while waiting or continuing', async () => {
    const row = await service.create(config, context);
    expect(await repo.retainedTab(42)).toBe(true);
    expect(await repo.retainedTab(43)).toBe(false);
    await service.control(row.id, userId, sessionId, 'cancel');
    expect(await repo.retainedTab(42)).toBe(false);
  });
  test('events match owner and identity; duplicates cannot re-arm a wake', async () => {
    const row = await service.create({ ...config, source: { kind: 'event', type: 'agent.completed', condition: { path: 'payload.agentId', operator: 'equals', value: 'worker-123' } } }, context);
    await service.event('55555555-5555-4555-8555-555555555555', 'agent.completed', { payload: { agentId: 'worker-123' } });
    await service.event(userId, 'agent.completed', { payload: { agentId: 'other-worker' } });
    expect((await repo.get(row.id)).status).toBe('armed');
    await service.event(userId, 'agent.completed', { payload: { agentId: 'worker-123' } });
    await service.deliver(await repo.get(row.id));
    await service.event(userId, 'agent.completed', { payload: { agentId: 'worker-123' } });
    expect((await repo.get(row.id)).status).toBe('completed');
    expect(mocks.resumed).toHaveBeenCalledTimes(1);
  });
  test('time monitor wakes at its configured time', async () => {
    const at = new Date(Date.now() + 60_000);
    const row = await service.create({ ...config, source: { kind: 'time', at: at.toISOString() } }, context);
    await service.check(row, new Date(Date.now() + 1));
    expect((await repo.get(row.id)).nextCheckAt).toEqual(at);
    await service.check(row, at);
    expect((await repo.get(row.id)).status).toBe('ready');
  });
});

test('invalid configuration is rejected before persistence', () => {
  expect(() => createMonitorSchema.parse({ ...config, intervalSeconds: 0 })).toThrow();
  expect(() => createMonitorSchema.parse({ ...config, source: { ...browser, condition: { operator: 'in', value: 'Succeeded' } } })).toThrow();
  expect(matches({ path: '', operator: 'equals', value: undefined }, undefined)).toBe(false);
  expect(matches({ path: '', operator: 'changed' }, { b: 2, a: 1 }, { a: 1, b: 2 })).toBe(false);
});
