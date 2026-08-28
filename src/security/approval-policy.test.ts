/**
 * The approval policy. It used to be two copies of an inline condition, one in
 * the agent loop and one in the tool middleware, each asking the other to be
 * kept in sync — so what matters here is that ONE table of cases pins both.
 */
import { describe, expect, test } from 'vitest';
import { canPromptHuman, channelCanPrompt, routeApproval } from './approval-policy';

describe('canPromptHuman', () => {
  test('the root agent and the direct paths can', () => {
    // Keyed on `root`, not on the role name: since Phase 9 the root runs as an
    // ordinary role, so a role string no longer identifies it.
    expect(canPromptHuman({ role: 'general', root: true })).toBe(true);
    expect(canPromptHuman({})).toBe(true);
  });

  test('an unattended root cannot either — a hook run has nobody to ask', () => {
    // The root holds real tools since Phase 9, so it can now raise an ASK on a
    // hook/heartbeat turn. Prompting there burns the request's TTL and then
    // fails; the unattended path (auto-approve, or refuse via
    // `unattendedDenyActions`) is the answer.
    expect(canPromptHuman({ role: 'general', root: true, attended: false })).toBe(false);
    // Unset means the interactive default, which is what every other caller is.
    expect(canPromptHuman({ role: 'general', root: true })).toBe(true);
  });

  test('a spawned worker cannot — nobody relays its request', () => {
    expect(canPromptHuman({ role: 'coding' })).toBe(false);
    // The root's own role, spawned as a child: still nobody to ask.
    expect(canPromptHuman({ role: 'general' })).toBe(false);
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
    expect(routeApproval({ level: 'ASK', role: 'general', root: true, toolId: 'shell', action: 'run' }).route)
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
        level: 'ASK', role: 'general', root: true, toolId: 'shell', action: 'run',
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

describe('which channels can carry an approval', () => {
  test('the surfaces with a person on them can', () => {
    // `tui` is load-bearing: the gateway passes `clientType` straight through as
    // the channel, so leaving it out makes every terminal turn unattended and
    // its approval overlay dead.
    for (const c of ['webchat', 'tui', 'mobile', 'acp', 'channel', 'telegram', 'slack', 'teams', 'whatsapp', 'discord']) {
      expect(channelCanPrompt(c), c).toBe(true);
    }
  });

  test('the API cannot — there is no relay, so an ASK there reaches nobody', () => {
    expect(channelCanPrompt('api')).toBe(false);
  });

  test('unattended triggers cannot', () => {
    for (const c of ['hook', 'heartbeat', 'cron', 'agent', 'qa-demo', undefined]) {
      expect(channelCanPrompt(c), String(c)).toBe(false);
    }
  });

  test('an unknown channel keeps prompting — the safe direction', () => {
    // Wrong here = a stall. Wrong the other way = a silent auto-approve.
    expect(channelCanPrompt('some-future-client')).toBe(true);
  });
});
