/**
 * make_call: places the call, waits on the call's status (no polling) and
 * reports what happened from the call's record; a call's own instructions
 * become its prompt.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { CallManager, type CallSession, type InitiateCallOptions, type TelephonyProvider } from '@/voice/telephony';

const state = vi.hoisted(() => ({
  calls: null as unknown as CallManager,
  placed: [] as InitiateCallOptions[],
}));

const provider = {
  name: 'twilio',
  initiateCall: async (options: InitiateCallOptions): Promise<CallSession> => {
    state.placed.push(options);
    return {
      id: `call-${state.placed.length}`, provider: 'twilio', providerCallId: `CA${state.placed.length}`, direction: 'outbound',
      from: '+15550000000', to: options.to, status: 'initiated', startedAt: new Date(), metadata: { mode: options.mode ?? 'notify' },
    };
  },
} as unknown as TelephonyProvider;

vi.mock('@/voice/telephony', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/voice/telephony')>()),
  getTelephonyProvider: async () => provider,
  getCallManager: () => state.calls,
}));
vi.mock('@/config/settings-service', () => ({
  getSettingsService: () => ({ get: async (key: string) => (key === 'voice.publicUrl' ? 'https://voice.example.org' : null) }),
}));

const { VoiceCallTool } = await import('./index');

type Execute = (args: Record<string, unknown>, ctx: AgentContext) => Promise<Record<string, unknown>>;
class Probe extends VoiceCallTool {
  readonly handlers: Record<string, Execute> = {};
  protected override registerTool(name: string, _description: string, _parameters: Record<string, unknown>, execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>): void {
    this.handlers[name] = execute as Execute;
  }
  register(): Promise<void> {
    return this.registerTools();
  }
}

const ctx = { id: 'a1', sessionId: 's1', userId: 'u1', role: 'general' } as unknown as AgentContext;
let makeCall: Execute;

beforeEach(async () => {
  state.calls = new CallManager();
  state.placed.length = 0;
  const probe = new Probe();
  await probe.register();
  makeCall = probe.handlers.make_call;
});

describe('make_call', () => {
  test('returns as soon as the call ends, with what the recipient said and the instructions as its prompt', async () => {
    const started = Date.now();
    const result = makeCall({ to: '+15551112222', message: 'Hello from the clinic.', mode: 'conversation', instructions: 'You are the clinic, confirming an appointment.', timeout: 120 }, ctx);
    await vi.waitFor(() => expect(state.calls.get('call-1')).toBeDefined());
    const call = state.calls.get('call-1') as CallSession;
    expect(state.placed[0].webhookUrl).toBe('https://voice.example.org/api/voice/webhook/twilio');
    expect(call.metadata).toMatchObject({ pendingMessage: 'Hello from the clinic.', expertPrompt: 'You are the clinic, confirming an appointment.', conversationHistory: [] });

    state.calls.updateStatus('call-1', 'active');
    (call.metadata.conversationHistory as unknown[]).push({ role: 'assistant', content: 'Hello from the clinic.' }, { role: 'user', content: 'Yes, I will be there.' });
    state.calls.updateStatus('call-1', 'ended');

    expect(await result).toMatchObject({ success: true, answered: true, status: 'ended', recipientResponse: 'Yes, I will be there.' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a call that rang out is not answered; without instructions the call has no prompt of its own', async () => {
    const result = makeCall({ to: '+15551112222', message: 'Hi' }, ctx);
    await vi.waitFor(() => expect(state.calls.get('call-1')).toBeDefined());
    expect(state.calls.get('call-1')?.metadata.expertPrompt).toBeUndefined();
    state.calls.updateStatus('call-1', 'ringing');
    state.calls.updateStatus('call-1', 'no-answer');
    expect(await result).toMatchObject({ success: false, answered: false, status: 'no-answer' });
  });
});
