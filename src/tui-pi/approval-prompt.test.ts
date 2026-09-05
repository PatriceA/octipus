import { describe, expect, test, vi } from 'vitest';
import { ApprovalPrompt } from './components/approval-prompt';
import { decodeGatewayEvent } from './gateway-adapter';

/**
 * The agent asks the user a question and blocks until it is answered.
 *
 * `request_user_approval` emitted `approval_required`, `event-bridge` mapped it
 * to `agent.approval_required`, the protocol declared it — and the TUI
 * had no handler, so it went on the floor. The screen showed
 * `Waiting: running request_user_approval (40.0s)` counting upward with no
 * prompt and no way to reply, until the turn timed out. Two of four measured
 * runs died exactly that way.
 *
 * Both halves are pinned: the event has to become something the app can render,
 * and every key has to produce an ANSWER — including the one that looks like a
 * dismissal, because dismissing a blocking question leaves the agent blocked.
 */

const decodeApproval = (payload: Record<string, unknown>) =>
  decodeGatewayEvent({ type: 'agent.approval_required', payload });

describe('the event reaches the app', () => {
  test('an approval request becomes an approval event', () => {
    const events = decodeApproval({
      requestId: 'req-1',
      summary: 'Migration written, 3 files changed.',
      question: 'Apply it to the production database?',
      options: ['Apply now', 'Dry run first', 'Cancel'],
    });
    expect(events).toContainEqual({
      kind: 'approval',
      requestId: 'req-1',
      summary: 'Migration written, 3 files changed.',
      question: 'Apply it to the production database?',
      options: ['Apply now', 'Dry run first', 'Cancel'],
    });
  });

  test('a request with no options still renders as a decision', () => {
    const events = decodeApproval({ requestId: 'r', question: 'Proceed?' });
    const approval = events.find((e) => e.kind === 'approval');
    expect(approval).toMatchObject({ options: [], question: 'Proceed?' });
  });

  test('a malformed request still produces something answerable', () => {
    // Better a generic question the user can answer than an agent blocked
    // forever because a field was missing.
    const approval = decodeApproval({ requestId: 'r' }).find((e) => e.kind === 'approval');
    expect(approval).toMatchObject({ summary: '', options: [] });
    expect((approval as { question: string }).question.length).toBeGreaterThan(0);
  });
});

describe('every key produces an answer', () => {
  const build = (options: string[]) => {
    const onRespond = vi.fn();
    return { prompt: new ApprovalPrompt({ summary: 's', question: 'q', options, onRespond }), onRespond };
  };

  test('a numbered choice sends that choice', () => {
    const { prompt, onRespond } = build(['Apply now', 'Dry run', 'Cancel']);
    prompt.handleInput('2');
    expect(onRespond).toHaveBeenCalledWith(true, 'Dry run');
  });

  test('Enter takes the first choice', () => {
    const { prompt, onRespond } = build(['Apply now', 'Dry run']);
    prompt.handleInput('\r');
    expect(onRespond).toHaveBeenCalledWith(true, 'Apply now');
  });

  test('a number nobody offered is ignored rather than guessed', () => {
    const { prompt, onRespond } = build(['Only one']);
    prompt.handleInput('7');
    expect(onRespond).not.toHaveBeenCalled();
  });

  test('yes and no when there are no choices', () => {
    const { prompt, onRespond } = build([]);
    prompt.handleInput('y');
    expect(onRespond).toHaveBeenCalledWith(true, 'yes');
    prompt.handleInput('n');
    expect(onRespond).toHaveBeenCalledWith(false, 'no');
  });

  test('Esc DECLINES — it does not dismiss', () => {
    // The regression this whole file exists for: an overlay that closes
    // without replying puts the agent back where it started, waiting.
    const { prompt, onRespond } = build(['Apply now']);
    prompt.handleInput('\x1b');
    expect(onRespond).toHaveBeenCalledWith(false, 'declined');
  });
});

describe('rendering', () => {
  test('the question, the choices and the keys are all on screen', () => {
    const prompt = new ApprovalPrompt({
      summary: 'Migration ready',
      question: 'Apply to production?',
      options: ['Apply now', 'Dry run first'],
      onRespond: () => {},
    });
    const text = prompt.render(80).join('\n');
    expect(text).toContain('Apply to production?');
    expect(text).toContain('1. Apply now');
    expect(text).toContain('2. Dry run first');
    expect(text).toMatch(/Esc decline/);
  });
});
