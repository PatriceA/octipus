import { describe, expect, test } from 'bun:test';
import { AgentStore } from './agent-store';

describe('AgentStore', () => {
  test('pushMessage assigns id and timestamp', () => {
    const s = new AgentStore();
    const m = s.pushMessage('user', 'hi');
    expect(m.role).toBe('user');
    expect(m.content).toBe('hi');
    expect(m.id).toMatch(/^m\d+$/);
    expect(m.timestamp).toBeGreaterThan(0);
  });

  test('pushMessage caps at 500 messages', () => {
    const s = new AgentStore();
    for (let i = 0; i < 600; i++) s.pushMessage('user', String(i));
    expect(s.get().messages.length).toBe(500);
    expect(s.get().messages[0].content).toBe('100');
  });

  test('clearMessages resets cumulative + last stats', () => {
    const s = new AgentStore();
    s.pushMessage('user', 'a');
    s.addRun({ tokens: 100, cost: 0.01 });
    s.setLastStats({ model: 'gpt-4' });
    s.clearMessages();
    expect(s.get().messages.length).toBe(0);
    expect(s.get().cumulative).toEqual({ tokens: 0, cost: 0, turns: 0 });
    expect(s.get().lastStats).toEqual({});
  });

  test('addRun accumulates', () => {
    const s = new AgentStore();
    s.addRun({ tokens: 100, cost: 0.05 });
    s.addRun({ tokens: 50, cost: 0.01 });
    expect(s.get().cumulative.tokens).toBe(150);
    expect(s.get().cumulative.turns).toBe(2);
    expect(s.get().cumulative.cost).toBeCloseTo(0.06, 4);
  });

  test('patchCurrentTool merges', () => {
    const s = new AgentStore();
    s.setCurrentTool({ name: 'shell', state: 'pending', startedAt: 0 });
    s.patchCurrentTool({ state: 'completed', preview: 'ok' });
    expect(s.get().currentTool?.state).toBe('completed');
    expect(s.get().currentTool?.preview).toBe('ok');
    expect(s.get().currentTool?.name).toBe('shell');
  });

  test('patchCurrentTool no-ops when no tool', () => {
    const s = new AgentStore();
    s.patchCurrentTool({ state: 'completed' });
    expect(s.get().currentTool).toBeNull();
  });

  test('setPendingPermission', () => {
    const s = new AgentStore();
    s.setPendingPermission({ requestId: 'r1', toolName: 'shell', detail: 'shell → rm -rf' });
    expect(s.get().pendingPermission?.requestId).toBe('r1');
    s.setPendingPermission(null);
    expect(s.get().pendingPermission).toBeNull();
  });
});
