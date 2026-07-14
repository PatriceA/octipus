import { describe, expect, test } from 'bun:test';
import { isAffirmation, isCancellation, VoicePlanGate } from './voice-plan-gate';

const S = 'session-1';

describe('VoicePlanGate', () => {
  test('cold work turn proposes, does not execute', () => {
    const gate = new VoicePlanGate();
    expect(gate.decide(S, 'research the impact of X on Y', true)).toEqual({
      kind: 'propose',
      workMessage: 'research the impact of X on Y',
      attachedFiles: [],
    });
  });

  test('non-work turn with no pending plan is passthrough (normal conversation)', () => {
    const gate = new VoicePlanGate();
    expect(gate.decide(S, 'how would you approach this?', false)).toEqual({ kind: 'passthrough' });
  });

  test('propose → record → affirmation executes the stored work, then clears', () => {
    const gate = new VoicePlanGate();
    const first = gate.decide(S, 'build me a report on sales', true);
    expect(first.kind).toBe('propose');
    gate.recordProposal(S, (first as { workMessage: string }).workMessage, []);

    expect(gate.decide(S, 'yes go ahead', false)).toEqual({
      kind: 'execute',
      workMessage: 'build me a report on sales',
      attachedFiles: [],
    });
    // pending cleared — a second "yes" no longer executes anything
    expect(gate.decide(S, 'yes', false)).toEqual({ kind: 'passthrough' });
  });

  test('a bare affirmation confirms', () => {
    const gate = new VoicePlanGate();
    gate.recordProposal(S, 'deploy the thing', []);
    expect(gate.decide(S, 'yeah do it', false)).toEqual({
      kind: 'execute',
      workMessage: 'deploy the thing',
      attachedFiles: [],
    });
  });

  // Regression: a denial the classifier ALSO tags as 'approval' must NOT execute.
  test('denial cancels the plan instead of executing it', () => {
    const gate = new VoicePlanGate();
    gate.recordProposal(S, 'send the emails', []);
    expect(gate.decide(S, 'no', false)).toEqual({ kind: 'passthrough' });
    gate.recordProposal(S, 'send the emails', []);
    expect(gate.decide(S, 'stop, cancel that', false)).toEqual({ kind: 'passthrough' });
    gate.recordProposal(S, 'send the emails', []);
    expect(gate.decide(S, 'abort', false)).toEqual({ kind: 'passthrough' });
  });

  // Regression: a refinement that merely STARTS with an affirmation word must
  // re-propose (folding the guidance in), not execute the coarse plan.
  test('refinement starting with an affirmation word re-proposes, does not execute', () => {
    const gate = new VoicePlanGate();
    gate.recordProposal(S, 'research competitors', []);
    expect(gate.decide(S, 'go deeper on pricing', false)).toEqual({
      kind: 'propose',
      workMessage: 'research competitors\n\nAdditional guidance: go deeper on pricing',
      attachedFiles: [],
    });
  });

  test('refinement folds guidance in, carries files, and a later yes executes the accumulated work', () => {
    const gate = new VoicePlanGate();
    const files = [{ id: 'f1', name: 'notes.md' }] as never[];
    gate.recordProposal(S, 'research competitors', files);
    const action = gate.decide(S, 'but focus on pricing', false);
    if (action.kind !== 'propose') throw new Error('expected propose');
    expect(action).toEqual({
      kind: 'propose',
      workMessage: 'research competitors\n\nAdditional guidance: but focus on pricing',
      attachedFiles: files,
    });
    gate.recordProposal(S, action.workMessage, action.attachedFiles);
    expect(gate.decide(S, 'ok', false)).toEqual({
      kind: 'execute',
      workMessage: 'research competitors\n\nAdditional guidance: but focus on pricing',
      attachedFiles: files,
    });
  });

  test('sessions are isolated', () => {
    const gate = new VoicePlanGate();
    gate.recordProposal('a', 'work-A', []);
    expect(gate.decide('b', 'yes', false)).toEqual({ kind: 'passthrough' }); // b has no pending
    expect(gate.decide('a', 'yes', false)).toEqual({ kind: 'execute', workMessage: 'work-A', attachedFiles: [] });
  });

  test('clear() removes a pending plan', () => {
    const gate = new VoicePlanGate();
    gate.recordProposal(S, 'x', []);
    gate.clear(S);
    expect(gate.decide(S, 'yes', false)).toEqual({ kind: 'passthrough' });
  });

  test('affirmation matches only whole-message yeses; cancellation matches denial leads', () => {
    expect(isAffirmation('yes')).toBe(true);
    expect(isAffirmation('ok')).toBe(true);
    expect(isAffirmation('go ahead')).toBe(true);
    expect(isAffirmation('go deeper on pricing')).toBe(false); // refinement, not a yes
    expect(isAffirmation('ok but skip section 2')).toBe(false);
    expect(isCancellation('no thanks')).toBe(true);
    expect(isCancellation('abort')).toBe(true);
  });
});
