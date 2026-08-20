/**
 * The approval policy. It used to be two copies of an inline condition, one in
 * the agent loop and one in the tool middleware, each asking the other to be
 * kept in sync — so what matters here is that ONE table of cases pins both.
 */
import { describe, expect, test } from 'bun:test';
import { canPromptHuman, routeApproval } from './approval-policy';

describe('canPromptHuman', () => {
  test('the orchestrator and the direct paths can', () => {
    expect(canPromptHuman('orchestrator')).toBe(true);
    expect(canPromptHuman(undefined)).toBe(true);
  });

  test('a spawned worker cannot — nobody relays its request', () => {
    expect(canPromptHuman('coding')).toBe(false);
  });
});

describe('routeApproval', () => {
  test('ALLOW just runs', () => {
    expect(routeApproval({ level: 'ALLOW', toolId: 'shell', action: 'run' }).route).toBe('execute');
  });

  test('DENY refuses whoever is calling', () => {
    expect(routeApproval({ level: 'DENY', role: 'coding', toolId: 'shell', action: 'run' }).route)
      .toBe('deny');
  });

  test('ASK asks, when someone can answer', () => {
    expect(routeApproval({ level: 'ASK', role: 'orchestrator', toolId: 'shell', action: 'run' }).route)
      .toBe('ask_human');
  });

  test('ASK auto-approves for a worker — blocking would hang it forever', () => {
    const d = routeApproval({ level: 'ASK', role: 'coding', toolId: 'shell', action: 'run' });
    expect(d.route).toBe('execute');
    expect(d.autoApproved).toBe(true);
  });

  test('a named action is refused instead of auto-approved', () => {
    const d = routeApproval({
      level: 'ASK',
      role: 'coding',
      toolId: 'shell',
      action: 'run',
      unattendedDenyActions: ['shell__run'],
    });
    expect(d.route).toBe('deny');
    expect(d.reason).toContain('shell__run');
  });

  test('naming the container covers its actions', () => {
    expect(
      routeApproval({
        level: 'ASK', role: 'coding', toolId: 'shell', action: 'run_background',
        unattendedDenyActions: ['shell'],
      }).route,
    ).toBe('deny');
  });

  test('the deny list never overrides a human who can be asked', () => {
    expect(
      routeApproval({
        level: 'ASK', role: 'orchestrator', toolId: 'shell', action: 'run',
        unattendedDenyActions: ['shell'],
      }).route,
    ).toBe('ask_human');
  });

  test('an unrelated entry does not match', () => {
    expect(
      routeApproval({
        level: 'ASK', role: 'coding', toolId: 'shell', action: 'run',
        unattendedDenyActions: ['filesystem__delete_file', ''],
      }).route,
    ).toBe('execute');
  });
});
