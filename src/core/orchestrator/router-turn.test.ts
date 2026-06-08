/**
 * Router-mode turn — runRouterTurn. spyOn the repos + spawnWorker (no
 * mock.module, which leaks process-wide). getRoleConfig / resolveRoleFromTopic /
 * buildOutputDirective run for real.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { MessageClassification } from './types';
import { ModelSelector } from './model-selector';
import { buildOutputDirective } from './output-directive';
import { runRouterTurn } from './router-turn';
import * as workerSpawner from './worker-spawner';

const sid = '00000000-0000-0000-0000-000000000000';
const deps = {
  modelSelector: new ModelSelector(),
  emit: () => {},
  setLastWorkerResult: () => {},
};
const baseOpts = {
  workspaceId: null,
  extraSystemContext: '',
  guardFlags: [] as string[],
  outputDirective: { mode: 'inline' as const, forced: false },
};

describe('runRouterTurn', () => {
  const createSpy = spyOn(messageRepository, 'create');
  const incSpy = spyOn(sessionRepository, 'incrementMessageCount');
  const spawnSpy = spyOn(workerSpawner, 'spawnWorker');

  beforeEach(() => {
    createSpy.mockReset().mockResolvedValue(undefined as never);
    incSpy.mockReset().mockResolvedValue(undefined as never);
    spawnSpy.mockReset().mockResolvedValue('SPECIALIST RESULT');
  });
  afterEach(() => {
    createSpy.mockReset();
    incSpy.mockReset();
    spawnSpy.mockReset();
  });

  test('persists the user message exactly once (before branching)', async () => {
    await runRouterTurn(sid, 'u', 'Implement a REST endpoint', { type: 'task', confidence: 0.9, topic: 'coding' }, deps, baseOpts);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledTimes(1);
  });

  test('ambiguous classification → clarify, no spawn', async () => {
    const cls: MessageClassification = { type: 'ambiguous', confidence: 0.2 };
    const r = await runRouterTurn(sid, 'u', 'help me somehow', cls, deps, baseOpts);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(r.response.toLowerCase()).toContain('need a bit more');
    expect(r.sources).toContain('router(clarify)');
    // user message still recorded for the clarified turn
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test('unresolvable topic → clarify, no spawn', async () => {
    const cls: MessageClassification = { type: 'task', confidence: 0.8, topic: 'totally-unknown' };
    const r = await runRouterTurn(sid, 'u', 'do the thing', cls, deps, baseOpts);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(r.sources).toContain('router(clarify)');
  });

  test('clear topic → spawns ONE specialist and relays its output', async () => {
    const cls: MessageClassification = { type: 'task', confidence: 0.9, topic: 'coding' };
    const r = await runRouterTurn(sid, 'u', 'Implement a REST endpoint', cls, deps, baseOpts);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [role, msg] = spawnSpy.mock.calls[0] as unknown as [string, string];
    expect(role).toBe('coding');
    expect(msg).toBe('Implement a REST endpoint');
    expect(r.response).toBe('SPECIALIST RESULT');
    expect(r.sources).toContain('role(coding)');
  });

  test('forwards the file outputDirective into the worker input', async () => {
    const cls: MessageClassification = { type: 'task', confidence: 0.9, topic: 'coding' };
    await runRouterTurn(sid, 'u', 'write a report', cls, deps, { ...baseOpts, outputDirective: { mode: 'file', forced: true } });
    const input = (spawnSpy.mock.calls[0] as unknown as [string, string, string])[2];
    expect(input).toContain(buildOutputDirective('file', true).trim().slice(0, 20));
  });

  test('coerces an error-object spawn result to a string', async () => {
    spawnSpy.mockResolvedValue({ error: 'No model configured' } as never);
    const cls: MessageClassification = { type: 'task', confidence: 0.9, topic: 'research' };
    const r = await runRouterTurn(sid, 'u', 'research X', cls, deps, baseOpts);
    expect(r.response).toBe('No model configured');
  });

  test('includes guard flags in sources', async () => {
    const cls: MessageClassification = { type: 'task', confidence: 0.9, topic: 'coding' };
    const r = await runRouterTurn(sid, 'u', 'impl', cls, deps, { ...baseOpts, guardFlags: ['prompt_extraction'] });
    expect(r.sources.some((s) => s.startsWith('guard('))).toBe(true);
  });
});
