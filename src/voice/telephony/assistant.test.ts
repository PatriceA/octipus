/**
 * The full assistant on a call: who gets it (a listed number AND a caller ID
 * the carrier verified), and how a call talks to the root agent — the turn's
 * spoken text as it streams, and the agent's questions asked and answered by
 * voice.
 */
import { describe, expect, test, vi } from 'vitest';
import type { VoiceTurnEvent } from '../session';
import {
  callAssistantEntries, callAssistantUser, normalizeNumber, PhoneAssistant, type PhoneAssistantDeps, spokenAnswer,
} from './assistant';
import type { TelephonyWebhookEvent } from './interface';

const incoming = (extra: Partial<TelephonyWebhookEvent> = {}): TelephonyWebhookEvent =>
  ({ type: 'incoming', callId: 'P-1', aliases: [], direction: 'inbound', from: '+14155551234', to: '+15550000000', ...extra });

function lookup(setting: unknown, users: Record<string, string> = { alice: 'user-alice' }) {
  const findUserId = vi.fn(async (name: string) => users[name] ?? null);
  return { settings: { get: async (key: string) => (key === 'voice.callAssistant' ? setting : null) }, findUserId };
}

describe('who reaches the full assistant', () => {
  const listed = [{ number: '+1 (415) 555-1234', user: 'alice' }];

  test('numbers compare by their digits; malformed entries are left out', () => {
    expect(normalizeNumber('+1 (415) 555-1234')).toBe('+14155551234');
    expect(callAssistantEntries([...listed, { number: 5 }, null, { number: '+1', user: ' ' }])).toEqual([{ number: '+14155551234', user: 'alice' }]);
    expect(callAssistantEntries(JSON.stringify(listed))).toHaveLength(1);
    expect(callAssistantEntries(null)).toEqual([]);
  });

  test('a listed number with a verified caller ID reaches its user', async () => {
    expect(await callAssistantUser(incoming({ callerVerified: true }), lookup(listed))).toBe('user-alice');
  });

  test('a listed number the carrier did not verify gets the restricted reply: caller ID alone can be spoofed', async () => {
    const l = lookup(listed);
    expect(await callAssistantUser(incoming({ callerVerified: false }), l)).toBeNull();
    expect(await callAssistantUser(incoming(), l)).toBeNull();
    expect(l.findUserId).not.toHaveBeenCalled();
  });

  test('an unlisted number, an outbound call, an unknown user or the setting off: restricted', async () => {
    expect(await callAssistantUser(incoming({ from: '+15559999999', callerVerified: true }), lookup(listed))).toBeNull();
    expect(await callAssistantUser(incoming({ direction: 'outbound', callerVerified: true }), lookup(listed))).toBeNull();
    expect(await callAssistantUser(incoming({ callerVerified: true }), lookup(listed, {}))).toBeNull();
    expect(await callAssistantUser(incoming({ callerVerified: true }), lookup(null))).toBeNull();
  });

  test('a spoken yes or no is the whole utterance', () => {
    expect(spokenAnswer('Yes.')).toBe('yes');
    expect(spokenAnswer('Okay')).toBe('yes');
    expect(spokenAnswer('Ja, bitte!')).toBe('yes');
    expect(spokenAnswer('No thanks.')).toBe('no');
    expect(spokenAnswer('Nein')).toBe('no');
    expect(spokenAnswer('yes but first check the calendar')).toBeNull();
  });
});

/** A root agent and gateway bus the test drives. */
function harness() {
  const handlers = new Set<(event: VoiceTurnEvent) => void>();
  const sent: string[] = [];
  const turns: Array<{ resolve(value: { response: string }): void; reject(err: Error): void }> = [];
  const answered: Array<[string, string, boolean]> = [];
  const deps: PhoneAssistantDeps = {
    send: (text) => {
      sent.push(text);
      return new Promise((resolve, reject) => { turns.push({ resolve, reject }); });
    },
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
    answerPermission: async (id, allow) => { answered.push(['permission', id, allow]); },
    answerApproval: async (id, approve) => { answered.push(['approval', id, approve]); },
  };
  const emit = (type: string, payload: Record<string, unknown>, over: Partial<VoiceTurnEvent> = {}) => {
    for (const handler of handlers) handler({ type, userId: 'u1', sessionId: 's1', payload, ...over });
  };
  const delta = (text: string, agentId = 'root-1', extra: Record<string, unknown> = {}) =>
    emit('chat.delta', { agentId, delta: text, iteration: 0, spoken: true, ...extra });
  const assistant = new PhoneAssistant({ callId: 'c1', userId: 'u1', sessionId: 's1', language: 'en' }, deps);
  return { assistant, sent, turns, answered, emit, delta, handlers };
}

/** Read a reply to its end, driving the bus as it goes. */
async function read(reply: AsyncIterable<string>, drive: () => Promise<void> | void): Promise<string> {
  const out: string[] = [];
  const reading = (async () => { for await (const piece of reply) out.push(piece); })();
  await tick();
  await drive();
  await reading;
  return out.join('');
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('a call talking to the root agent', () => {
  test("what the caller said is sent as one turn; its root agent's spoken text is read as it streams, then what the answer adds", async () => {
    const h = harness();
    h.assistant.heard('What is on my calendar');
    h.assistant.heard('tomorrow?');
    const text = await read(h.assistant.reply(new AbortController().signal), async () => {
      h.delta('You have two meetings. ');
      h.delta('worker text', 'worker-9'); // another agent's
      h.emit('chat.delta', { agentId: 'root-1', delta: 'unmarked', iteration: 0 }); // not a spoken turn
      h.emit('chat.delta', { agentId: 'root-1', delta: 'other chat', spoken: true }, { sessionId: 's2' });
      await tick();
      h.turns[0].resolve({ response: 'You have two meetings. The first is at nine.' });
    });
    expect(h.sent).toEqual(['What is on my calendar tomorrow?']);
    expect(text).toContain('You have two meetings. ');
    expect(text).toContain('The first is at nine.');
    expect(text).not.toMatch(/worker text|unmarked|other chat/);
  });

  test('a tool that needs permission is asked aloud; a spoken yes allows it and the reply follows the same turn', async () => {
    const h = harness();
    h.assistant.heard('Delete the old backups');
    const asked = await read(h.assistant.reply(new AbortController().signal), () => {
      h.delta('Let me check. ');
      h.emit('permission.request', { requestId: 'perm-1', toolName: 'shell_exec' });
    });
    expect(asked).toContain('I need your permission to use shell exec. Say yes to allow it, or no.');

    h.assistant.heard('Yes.');
    const after = await read(h.assistant.reply(new AbortController().signal), async () => {
      h.delta('Done, three backups removed.', 'root-1', { iteration: 1 });
      await tick();
      h.turns[0].resolve({ response: 'Done, three backups removed.' });
    });
    expect(h.answered).toEqual([['permission', 'perm-1', true]]);
    expect(h.sent).toEqual(['Delete the old backups']); // the yes was an answer, not a turn
    expect(after).toContain('Done, three backups removed.');
  });

  test('anything but a plain yes refuses the question; more than a no is the next turn', async () => {
    const h = harness();
    h.assistant.heard('Send the report');
    await read(h.assistant.reply(new AbortController().signal), () => {
      h.emit('agent.approval_required', { requestId: 'ap-1', question: 'Send it to the whole team?' });
    });
    h.assistant.heard('Only to Dana please');
    const next = h.assistant.reply(new AbortController().signal);
    const reading = read(next, async () => {
      h.turns[0].resolve({ response: 'Not sent.' });
      await tick();
      h.delta('Sent to Dana.', 'root-2');
      await tick();
      h.turns[1].resolve({ response: 'Sent to Dana.' });
    });
    const text = await reading;
    expect(h.answered).toEqual([['approval', 'ap-1', false]]);
    expect(h.sent).toEqual(['Send the report', 'Only to Dana please']);
    // The new turn's reply, not what the refused one still said.
    expect(text).toBe('Sent to Dana.');
  });

  test('a question answered elsewhere is not asked again; one still open when the call ends is refused', async () => {
    const h = harness();
    h.emit('permission.request', { requestId: 'perm-2', toolName: 'email' });
    h.emit('permission.resolved', { requestId: 'perm-2', status: 'approved' });
    h.emit('permission.request', { requestId: 'perm-3', toolName: 'email' });
    await h.assistant.close();
    expect(h.answered).toEqual([['permission', 'perm-3', false]]);
    expect(h.handlers.size).toBe(0);
  });

  test('aborting a reply (barge-in) stops the reading at once; the turn is left to finish', async () => {
    const h = harness();
    h.assistant.heard('Tell me a long story');
    const abort = new AbortController();
    const text = await read(h.assistant.reply(abort.signal), async () => {
      h.delta('Once upon a time. ');
      await tick();
      abort.abort();
    });
    expect(text).toBe('Once upon a time. ');
    expect(h.turns).toHaveLength(1);
  });

  test('a turn that fails fails the reply (the call says its stock apology)', async () => {
    const h = harness();
    h.assistant.heard('Hello');
    await expect(read(h.assistant.reply(new AbortController().signal), () => { h.turns[0].reject(new Error('no model')); })).rejects.toThrow('no model');
  });
});
