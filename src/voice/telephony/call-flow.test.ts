/**
 * The call flow, with a provider that records what it is told: one flow for
 * every provider, deciding from the shared event shape alone.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { type CallFlowContext, handleCallEvent } from './call-flow';
import { type CallInstruction, CallManager, type TelephonyProvider, type TelephonyWebhookEvent, type WebhookReply } from './interface';
import { phonePhrase } from './phrases';
import type { PhoneReply } from './reply';

const ACK: WebhookReply = { contentType: 'text/plain', body: 'ack' };

function fakeProvider(options: { answersInline?: boolean; mediaStream?: boolean } = {}) {
  const told: Array<{ callId: string; instruction: CallInstruction }> = [];
  const ended: string[] = [];
  const provider: TelephonyProvider = {
    name: 'fake',
    mediaStream: options.mediaStream ?? false,
    initiateCall: async () => { throw new Error('not used'); },
    parseWebhook: () => { throw new Error('not used'); },
    acceptIncoming: async () => options.answersInline ?? true,
    rejectIncoming: async () => ({ contentType: 'text/plain', body: 'rejected' }),
    instruct: async (callId, instruction) => { told.push({ callId, instruction }); return { contentType: 'text/plain', body: instruction.then }; },
    acknowledge: () => ACK,
    endCall: async (callId) => { ended.push(callId); },
    verifyWebhook: () => true,
    checkHealth: async () => ({ healthy: true }),
  };
  return { provider, told, ended };
}

const event = (type: TelephonyWebhookEvent['type'], extra: Partial<TelephonyWebhookEvent> = {}): TelephonyWebhookEvent =>
  ({ type, callId: 'P-1', aliases: [], direction: 'inbound', from: '+15551112222', to: '+15550000000', ...extra });

let settings: Record<string, unknown>;
let replies: Array<PhoneReply | Error>;
let fake: ReturnType<typeof fakeProvider>;
let calls: CallManager;

function context(over: Partial<CallFlowContext> = {}): CallFlowContext {
  return {
    provider: fake.provider,
    callManager: calls,
    callbackUrl: 'https://x.example/api/voice/webhook/fake',
    publicBase: 'https://x.example',
    settings: { get: async (key: string) => settings[key] ?? null },
    reply: async () => {
      const next = replies.shift();
      if (!next) throw new Error('no reply scripted');
      if (next instanceof Error) throw next;
      return next;
    },
    line: async (text) => ({ text }),
    mintStreamToken: () => 'tok',
    ...over,
  };
}

beforeEach(() => {
  settings = { 'voice.inboundPolicy': 'open', 'voice.language': 'de' };
  replies = [];
  fake = fakeProvider();
  calls = new CallManager();
});

describe('handleCallEvent', () => {
  test('an inbound call is accepted, registered and greeted in voice.language, then listened to', async () => {
    await handleCallEvent(event('incoming'), context());
    const [call] = calls.list();
    expect(call).toMatchObject({ providerCallId: 'P-1', direction: 'inbound', status: 'active', metadata: { mode: 'conversation' } });
    expect(fake.told[0].instruction).toMatchObject({
      say: { text: phonePhrase('greeting', 'de') }, then: 'listen', locale: 'de-DE', opening: true,
      reprompt: { stillThere: { text: phonePhrase('stillThere', 'de') }, listening: { text: phonePhrase('listening', 'de') } },
    });
  });

  test('a provider that answers out of band opens the call on its answered event', async () => {
    fake = fakeProvider({ answersInline: false });
    expect(await handleCallEvent(event('incoming'), context())).toBe(ACK);
    expect(fake.told).toEqual([]);
    await handleCallEvent(event('answered'), context());
    expect(fake.told[0].instruction).toMatchObject({ then: 'listen', opening: true });
  });

  test('the inbound policy turns callers away', async () => {
    settings['voice.inboundPolicy'] = 'allowlist';
    settings['voice.inboundAllowFrom'] = ['+15559999999'];
    expect((await handleCallEvent(event('incoming'), context())).body).toBe('rejected');
    settings['voice.inboundPolicy'] = 'disabled';
    expect((await handleCallEvent(event('incoming'), context())).body).toBe('rejected');
    expect(calls.list()).toEqual([]);
  });

  test('with streaming on and a provider that streams, the call goes to the media socket', async () => {
    fake = fakeProvider({ mediaStream: true });
    settings['voice.streaming'] = true;
    await handleCallEvent(event('incoming'), context());
    expect(fake.told[0].instruction).toMatchObject({ then: 'stream', streamUrl: 'wss://x.example/voice/media/fake?token=tok' });
  });

  test('what the caller says is answered and the line listens again', async () => {
    await handleCallEvent(event('incoming'), context());
    replies.push({ text: 'Es ist drei Uhr.', endCall: false });
    await handleCallEvent(event('speech', { speech: 'Wie spät ist es?' }), context());
    expect(fake.told[1].instruction).toMatchObject({ say: { text: 'Es ist drei Uhr.' }, then: 'listen', callbackUrl: 'https://x.example/api/voice/webhook/fake' });
  });

  test('a farewell is said and the call hung up; a line that asked for it ends the call when it has been spoken', async () => {
    await handleCallEvent(event('incoming'), context());
    replies.push({ text: 'Auf Wiederhören!', endCall: true });
    await handleCallEvent(event('speech', { speech: 'Tschüss' }), context());
    expect(fake.told[1].instruction).toEqual({ say: { text: 'Auf Wiederhören!' }, then: 'hangup', locale: 'de-DE' });
    // Command-driven providers report the end of the line; then the call is hung up.
    await handleCallEvent(event('spoken', { after: 'hangup' }), context());
    expect(fake.ended).toEqual(['P-1']);
    await handleCallEvent(event('spoken', { after: 'listen' }), context());
    expect(fake.ended).toEqual(['P-1']);
  });

  test('a reply that fails is apologised for in the call language, and the line listens again', async () => {
    await handleCallEvent(event('incoming'), context());
    replies.push(new Error('model down'));
    await handleCallEvent(event('speech', { speech: 'Hallo?' }), context());
    expect(fake.told[1].instruction).toMatchObject({ say: { text: phonePhrase('trouble', 'de') }, then: 'listen' });
  });

  test('the hangup event ends the call with its status; it stays listed', async () => {
    await handleCallEvent(event('incoming'), context());
    await handleCallEvent(event('hangup', { status: 'busy' }), context());
    expect(calls.list()[0]).toMatchObject({ status: 'busy' });
    expect(calls.list()[0].endedAt).toBeInstanceOf(Date);
  });

  test('an outbound call is found by an alias and then known by the id the provider addresses it with', async () => {
    calls.create({
      id: 'out-1', provider: 'fake', providerCallId: 'req-1', direction: 'outbound', from: '+1', to: '+2', status: 'initiated',
      startedAt: new Date(), metadata: { mode: 'notify', pendingMessage: 'Your table is ready.' },
    });
    await handleCallEvent(event('answered', { callId: 'call-uuid', aliases: ['req-1'], direction: 'outbound' }), context());
    expect(calls.get('out-1')).toMatchObject({ providerCallId: 'call-uuid', status: 'active' });
    // notify: the message, then hang up.
    expect(fake.told[0]).toEqual({ callId: 'call-uuid', instruction: { say: { text: 'Your table is ready.' }, then: 'hangup', locale: 'de-DE', opening: true } });
  });

  test('speech on a call this process does not know is hung up', async () => {
    const line = vi.fn();
    await handleCallEvent(event('speech', { speech: 'hello?' }), context({ line }));
    expect(fake.told).toEqual([{ callId: 'P-1', instruction: { then: 'hangup', locale: 'de-DE' } }]);
    expect(line).not.toHaveBeenCalled();
  });

  test('a greeting spoken by command (Telnyx) is followed by the stream, on a fresh token, once it has ended', async () => {
    fake = fakeProvider({ mediaStream: true, answersInline: false });
    settings['voice.streaming'] = true;
    let minted = 0;
    const ctx = context({ mintStreamToken: () => `tok${++minted}` });
    await handleCallEvent(event('incoming'), ctx);
    await handleCallEvent(event('answered'), ctx);
    expect(fake.told[0].instruction).toMatchObject({ then: 'stream', say: { text: phonePhrase('greeting', 'de') } });
    await handleCallEvent(event('spoken', { after: 'stream' }), ctx);
    expect(fake.told[1].instruction).toEqual({ then: 'stream', streamUrl: 'wss://x.example/voice/media/fake?token=tok2', locale: 'de-DE' });
    // Over before its greeting ended: nothing to connect.
    await handleCallEvent(event('hangup', { status: 'ended' }), ctx);
    await handleCallEvent(event('spoken', { after: 'stream' }), ctx);
    expect(fake.told).toHaveLength(2);
  });
});

describe('the full assistant on a call', () => {
  test("only a caller the gate names gets it; the gate sees the carrier's verification", async () => {
    const seen: TelephonyWebhookEvent[] = [];
    const assistantUser = async (e: TelephonyWebhookEvent) => { seen.push(e); return e.callerVerified ? 'user-1' : null; };
    await handleCallEvent(event('incoming', { callId: 'P-v', callerVerified: true }), context({ assistantUser }));
    await handleCallEvent(event('incoming', { callId: 'P-u', callerVerified: false }), context({ assistantUser }));
    expect(calls.getByProviderCallId('P-v')?.metadata.assistant).toMatchObject({ userId: 'user-1', sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(calls.getByProviderCallId('P-u')?.metadata.assistant).toBeUndefined();
    expect(seen.map((e) => e.callerVerified)).toEqual([true, false]);
  });

  test('a gate that fails leaves the call on the restricted reply instead of dropping it', async () => {
    await handleCallEvent(event('incoming'), context({ assistantUser: async () => { throw new Error('db down'); } }));
    const [call] = calls.list();
    expect(call.status).toBe('active');
    expect(call.metadata.assistant).toBeUndefined();
  });

  test('an outbound call never asks the gate', async () => {
    const assistantUser = vi.fn(async () => 'user-1');
    calls.create({
      id: 'out-2', provider: 'fake', providerCallId: 'P-out', direction: 'outbound', from: '+1', to: '+2', status: 'initiated',
      startedAt: new Date(), metadata: { mode: 'conversation', pendingMessage: 'Hi' },
    });
    await handleCallEvent(event('answered', { callId: 'P-out', direction: 'outbound', callerVerified: true }), context({ assistantUser }));
    expect(assistantUser).not.toHaveBeenCalled();
    expect(calls.get('out-2')?.metadata.assistant).toBeUndefined();
  });
});
