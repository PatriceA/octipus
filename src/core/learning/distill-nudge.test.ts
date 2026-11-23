import { describe, expect, test } from 'vitest';
import {
  boundRunMaterial, decideDistillNudge, isComplexRun, type NudgeRunFacts, type NudgeTurnFacts, nudgeTurnGate,
  RUN_MATERIAL_LIMITS, type RunEventRow, summarizeRunEvents, verificationPassed,
} from './distill-nudge';

const limits = { enabled: true, minToolCalls: 8, minDistinctTools: 3 };
const turn = (over: Partial<NudgeTurnFacts> = {}): NudgeTurnFacts => ({
  trigger: 'user', channel: 'webchat', clientRendersNudge: true, spoken: false, oneShot: false, synthetic: false,
  shared: false, contentStorageOff: false, outcome: 'success', limited: false, replaced: false, ...over,
});
const run = (over: Partial<NudgeRunFacts> = {}): NudgeRunFacts => ({
  signals: { toolCalls: 10, distinctTools: 4, delegated: false, skillLoaded: false, distilled: false },
  skillInjected: false, verification: null, sessionProposal: false, optedOut: false, ...over,
});
const signals = (over: Partial<NudgeRunFacts['signals']>) => ({ ...run().signals, ...over });

describe('decideDistillNudge', () => {
  test('a complex, successful, attended run with nothing in the way is offered', () => {
    expect(decideDistillNudge(turn(), run(), limits)).toBeNull();
  });

  test('the operator switch turns every offer off', () => {
    expect(decideDistillNudge(turn(), run(), { ...limits, enabled: false })).toBe('disabled');
  });

  test.each([
    ['schedule', 'hook'], ['schedule', 'heartbeat'], ['schedule', 'cron'], ['monitor', 'monitor'],
    ['room', 'slack'], ['listen', 'room'], ['remote', 'room'],
  ] as const)('a %s run (channel %s) is unattended and never offered', (trigger, channel) => {
    expect(decideDistillNudge(turn({ trigger, channel }), run(), limits)).toBe('unattended');
  });

  test('an unattended entry channel is refused even when the trigger reads as user', () => {
    for (const channel of ['hook', 'heartbeat', 'cron', 'monitor', 'webhook']) {
      expect(decideDistillNudge(turn({ channel }), run(), limits)).toBe('unattended');
    }
  });

  test('voice is never offered', () => {
    expect(decideDistillNudge(turn({ spoken: true }), run(), limits)).toBe('voice');
    expect(decideDistillNudge(turn({ channel: 'mobile-voice' }), run(), limits)).toBe('voice');
  });

  test('a client that cannot show the offer is not offered (and spends no cool-down)', () => {
    expect(decideDistillNudge(turn({ clientRendersNudge: false, channel: 'telegram' }), run(), limits)).toBe('client');
  });

  test.each([
    [{ oneShot: true }, 'one_shot'],
    [{ synthetic: true }, 'synthetic'],
    [{ shared: true }, 'shared'],
    [{ contentStorageOff: true }, 'no_content'],
    [{ outcome: 'failed' }, 'not_successful'],
    [{ outcome: 'cancelled' }, 'not_successful'],
    [{ outcome: undefined }, 'not_successful'],
    [{ limited: true }, 'refused'],
    [{ replaced: true }, 'refused'],
  ] as const)('turn %o → %s', (over, reason) => {
    expect(decideDistillNudge(turn(over), run(), limits)).toBe(reason);
  });

  test.each([
    [{ optedOut: true }, 'opted_out'],
    [{ verification: false }, 'verification_failed'],
    [{ skillInjected: true }, 'skill_used'],
    [{ signals: signals({ skillLoaded: true }) }, 'skill_used'],
    [{ signals: signals({ distilled: true }) }, 'already_distilled'],
    [{ sessionProposal: true }, 'proposal_exists'],
  ] as const)('run %o → %s', (over, reason) => {
    expect(decideDistillNudge(turn(), run(over), limits)).toBe(reason);
  });

  test('passed verification evidence does not stand in the way', () => {
    expect(decideDistillNudge(turn(), run({ verification: true }), limits)).toBeNull();
  });
});

describe('isComplexRun', () => {
  test('breadth is required: many calls of two tools are not complex', () => {
    expect(isComplexRun(signals({ toolCalls: 40, distinctTools: 2 }), limits)).toBe(false);
  });
  test('enough calls across enough tools are complex', () => {
    expect(isComplexRun(signals({ toolCalls: 8, distinctTools: 3 }), limits)).toBe(true);
    expect(isComplexRun(signals({ toolCalls: 7, distinctTools: 3 }), limits)).toBe(false);
  });
  test('a delegation stands in for the call count, not for breadth', () => {
    expect(isComplexRun(signals({ toolCalls: 3, distinctTools: 3, delegated: true }), limits)).toBe(true);
    expect(isComplexRun(signals({ toolCalls: 3, distinctTools: 2, delegated: true }), limits)).toBe(false);
  });
  test('the thresholds are the configured ones', () => {
    expect(isComplexRun(signals({ toolCalls: 2, distinctTools: 1 }), { minToolCalls: 2, minDistinctTools: 1 })).toBe(true);
  });
  test('a simple run is not offered', () => {
    expect(decideDistillNudge(turn(), run({ signals: signals({ toolCalls: 2, distinctTools: 2 }) }), limits)).toBe('simple');
  });
});

describe('summarizeRunEvents', () => {
  const action = (data: Record<string, unknown>, agentId = 'root'): RunEventRow => ({ agentId, type: 'action', data });
  test('counts tool calls, distinct tools, recovered calls and CLI calls', () => {
    const rows = [
      action({ type: 'tool_call', toolName: 'read_file' }),
      action({ type: 'tool_call', toolName: 'read_file' }),
      action({ type: 'cli_tool_use', toolName: 'Bash' }),
      action({ toolCalls: [{ name: 'web_search' }, { name: 'read_file' }] }),
      { agentId: 'root', type: 'observation', data: { results: [{}, {}] } },
    ];
    expect(summarizeRunEvents(rows, 'root')).toEqual({ toolCalls: 5, distinctTools: 3, delegated: false, skillLoaded: false, distilled: false });
  });
  test('a delegation tool or a child agent\'s event is a delegation', () => {
    expect(summarizeRunEvents([action({ type: 'tool_call', toolName: 'spawn_child' })], 'root').delegated).toBe(true);
    expect(summarizeRunEvents([action({ type: 'tool_call', toolName: 'create_pipeline' })], 'root').delegated).toBe(true);
    expect(summarizeRunEvents([{ agentId: 'child', type: 'thought', data: {} }], 'root').delegated).toBe(true);
  });
  test('a skill load or get_skill call, in-process or through the MCP bridge, is skill use', () => {
    expect(summarizeRunEvents([action({ type: 'skill_load', skillId: 's1' })], 'root').skillLoaded).toBe(true);
    expect(summarizeRunEvents([action({ type: 'cli_tool_use', toolName: 'mcp__octipus__octipus_get_skill' })], 'root').skillLoaded).toBe(true);
    expect(summarizeRunEvents([action({ type: 'tool_call', toolName: 'list_skills' })], 'root').skillLoaded).toBe(false);
  });
  test('a distill_skill call is noticed', () => {
    expect(summarizeRunEvents([action({ type: 'tool_call', toolName: 'distill_skill' })], 'root').distilled).toBe(true);
  });
  test('malformed rows are ignored', () => {
    expect(summarizeRunEvents([{ agentId: 'root', type: 'action', data: null }, action({ type: 'tool_call' })], 'root').toolCalls).toBe(0);
  });
});

describe('verificationPassed', () => {
  const at = (s: number) => new Date(2026, 10, 1, 0, 0, s);
  const row = (passed: boolean, s: number, stage = 'qa') => ({ kind: 'qa_verdict', stage, nodeId: null, passed, createdAt: at(s) });
  test('no evidence: null (the outcome decides)', () => {
    expect(verificationPassed([])).toBeNull();
  });
  test('the latest verdict of a check counts: failed then fixed passes', () => {
    expect(verificationPassed([row(false, 1), row(true, 2)])).toBe(true);
    expect(verificationPassed([row(true, 1), row(false, 2)])).toBe(false);
  });
  test('every check must pass', () => {
    expect(verificationPassed([row(true, 1, 'build'), row(false, 2, 'tests')])).toBe(false);
  });
});

describe('nudgeTurnGate', () => {
  test('is the turn half alone', () => {
    expect(nudgeTurnGate(turn(), limits)).toBeNull();
    expect(nudgeTurnGate(turn({ trigger: 'schedule' }), limits)).toBe('unattended');
  });
});

describe('boundRunMaterial', () => {
  const msg = (role: string, n: number, size = 100) => ({ role, content: `m${n} ${'x'.repeat(size)}` });
  test('a short run is handed over whole, with its tools', () => {
    expect(boundRunMaterial([msg('user', 0, 3), msg('assistant', 1, 3)], ['a', 'b']))
      .toBe('user: m0 xxx\n\nassistant: m1 xxx\n\nTools used, in order of first use: a, b');
  });
  test('at most the configured number of messages: the request and the most recent ones', () => {
    const rows = [msg('user', 0), ...Array.from({ length: 50 }, (_, i) => msg('assistant', i + 1))];
    const out = boundRunMaterial(rows, []).split('\n\n');
    expect(out).toHaveLength(RUN_MATERIAL_LIMITS.messages);
    expect(out[0]).toMatch(/^user: m0 /);
    expect(out[1]).toMatch(/^assistant: m22 /);
    expect(out.at(-1)).toMatch(/^assistant: m50 /);
  });
  test('the total is bounded; the request and the answer survive, each clipped', () => {
    const rows = [msg('user', 0, 20_000), ...Array.from({ length: 10 }, (_, i) => msg('assistant', i + 1, 9_000)), msg('assistant', 99, 20_000)];
    const out = boundRunMaterial(rows, Array.from({ length: 500 }, (_, i) => `tool_${i}`));
    expect(out.length).toBeLessThanOrEqual(RUN_MATERIAL_LIMITS.totalChars);
    expect(out.startsWith('user: m0 ')).toBe(true);
    expect(out).toContain('assistant: m99 ');
    expect(out).toContain('assistant: m10 ');
    expect(out).not.toContain('assistant: m1 ');
  });
});
