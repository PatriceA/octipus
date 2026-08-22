import { describe, expect, test } from 'bun:test';
import { hydrateWalk, serializeWalk, type WalkState } from './pipeline-manager';

/**
 * A checkpoint is the one thing standing between a paused run and a lost one,
 * and it is user-editable by design ("inspect state, edit it, resume"). These
 * tests pin the round trip and the refusal to hydrate junk — a walk resumed
 * from a malformed snapshot fails somewhere far from the cause.
 */
const state: WalkState = {
  cursor: 'n3',
  previousOutput: 'the implementer wrote a parser',
  handoffChain: [{ completedWork: 'parser', decisions: ['recursive descent'] } as never],
  pipelineSources: ['stage(1: Plan/architect)'],
  traversals: { 'n3->n1:qa_fail': 2 },
  loopMarks: { loop1: 1 },
  pendingFeedback: { n1: { passed: false, issues: ['no tests'], feedback: 'add tests' } as never },
  judgedContext: { n3: 'the work under audit' },
  pendingRejection: undefined,
  currentItemId: '11111111-2222-3333-4444-555555555555',
  steps: 7,
};

describe('walk state — checkpoint round trip', () => {
  test('everything the walker carries survives serialize → hydrate', () => {
    const back = hydrateWalk(JSON.parse(JSON.stringify(serializeWalk(state))));
    expect(back).toEqual(state);
  });

  test('a hand-edited previousOutput is what the next node will read', () => {
    const edited = { ...serializeWalk(state), previousOutput: 'corrected by hand' };
    expect(hydrateWalk(edited)?.previousOutput).toBe('corrected by hand');
  });

  test('a state with no cursor is refused — there is nowhere to resume to', () => {
    expect(hydrateWalk({ ...serializeWalk(state), cursor: '' })).toBeNull();
    expect(hydrateWalk(null)).toBeNull();
    expect(hydrateWalk('n1')).toBeNull();
  });

  test('missing collections hydrate empty rather than undefined', () => {
    const bare = hydrateWalk({ cursor: 'n0' });
    expect(bare).toEqual({
      cursor: 'n0',
      previousOutput: '',
      handoffChain: [],
      pipelineSources: [],
      traversals: {},
      loopMarks: {},
      pendingFeedback: {},
      judgedContext: {},
      pendingRejection: undefined,
      currentItemId: null,
      steps: 0,
    });
  });
});

describe('walk state — the rejected report survives a checkpoint', () => {
  test('round-trips, so a resumed correction is still a correction', () => {
    const state = hydrateWalk(
      serializeWalk({
        cursor: 'n5',
        previousOutput: '',
        handoffChain: [],
        pipelineSources: [],
        traversals: {},
        loopMarks: {},
        pendingFeedback: {},
        judgedContext: {},
        pendingRejection: 'the verdict named no stage',
        rejectedReport: 'REPORT BODY',
        currentItemId: null,
        steps: 3,
      }),
    );
    expect(state?.rejectedReport).toBe('REPORT BODY');
  });

  test('a checkpoint written before the field existed resumes without one', () => {
    const state = hydrateWalk({ cursor: 'n5', pendingRejection: 'reason' });
    expect(state?.rejectedReport).toBeUndefined();
  });
});
