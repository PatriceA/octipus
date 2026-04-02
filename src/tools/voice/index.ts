/**
 * Voice Call Tool — enables agents to make and manage phone calls.
 *
 * Leverages the existing VoiceService for STT/TTS and adds telephony
 * provider integration for actual phone calls via Twilio, Telnyx, or Plivo.
 */

import { BaseTool } from '@/tools/base-tool';
import type { ToolManifest, AgentContext } from '@/core/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'voice-tool' });

export class VoiceCallTool extends BaseTool {
  readonly id = 'voice';
  readonly name = 'Voice Call';
  readonly version = '1.0.0';
  readonly description = 'Make and manage phone calls with voice interaction';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'initiate_call', description: 'Start a phone call', defaultLevel: 'ASK' },
        { action: 'end_call', description: 'End an active call', defaultLevel: 'ALLOW' },
        { action: 'get_status', description: 'Check call status', defaultLevel: 'ALLOW' },
      ],
      tools: [],
    };
  }

  async checkAvailability() {
    try {
      const { getTelephonyProvider } = await import('@/voice/telephony');
      const provider = await getTelephonyProvider();
      if (!provider) return { available: false, reason: 'No telephony provider configured (voice.telephonyProvider)' };
      const health = await provider.checkHealth();
      return health.healthy ? { available: true } : { available: false, degraded: true, reason: health.error };
    } catch {
      return { available: false, reason: 'Telephony module not available' };
    }
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'initiate_call',
      'Start a phone call. In "notify" mode, speaks a message and hangs up. In "conversation" mode, enables interactive voice exchange.',
      {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Phone number (E.164, e.g., +1234567890)' },
          message: { type: 'string', description: 'Message to speak when answered' },
          mode: { type: 'string', enum: ['notify', 'conversation'], description: 'notify=one-way, conversation=interactive' },
        },
        required: ['to', 'message'],
      },
      async (args: Record<string, unknown>) => {
        const { getTelephonyProvider, getCallManager } = await import('@/voice/telephony');
        const provider = await getTelephonyProvider();
        if (!provider) return { error: 'No telephony provider configured.' };

        const to = args.to as string;
        const message = args.message as string;
        const mode = (args.mode as string) || 'notify';

        const { getSettingsService } = await import('@/config/settings-service');
        const settings = getSettingsService();
        const publicUrl = (await settings.get('voice.publicUrl') as string) || `http://localhost:${process.env.API_PORT || 3005}`;
        const webhookUrl = `${publicUrl}/api/voice/webhook/${provider.name}`;

        try {
          const session = await provider.initiateCall({
            to, message,
            mode: mode as 'notify' | 'conversation',
            webhookUrl,
            streamUrl: mode === 'conversation' ? `${publicUrl.replace('http', 'ws')}/api/voice/stream` : undefined,
          });
          getCallManager().create(session);
          log.info({ callId: session.id, to, mode }, 'Call initiated');
          return { callId: session.id, status: session.status, to, mode };
        } catch (error) {
          return { error: `Call failed: ${(error as Error).message}` };
        }
      },
      { requiresPermission: true, permissionAction: 'initiate_call' },
    );

    this.registerTool(
      'continue_call',
      'Send the next message in an active conversation call.',
      {
        type: 'object',
        properties: {
          call_id: { type: 'string', description: 'Call ID' },
          message: { type: 'string', description: 'Message to speak' },
        },
        required: ['call_id', 'message'],
      },
      async (args: Record<string, unknown>) => {
        const { getCallManager } = await import('@/voice/telephony');
        const session = getCallManager().get(args.call_id as string);
        if (!session) return { error: `Call ${args.call_id} not found` };
        if (session.status === 'ended') return { error: 'Call has ended' };
        session.metadata.pendingMessage = args.message as string;
        return { callId: session.id, status: session.status, message: 'Queued for delivery' };
      },
    );

    this.registerTool(
      'end_call',
      'End an active phone call.',
      {
        type: 'object',
        properties: { call_id: { type: 'string', description: 'Call ID' } },
        required: ['call_id'],
      },
      async (args: Record<string, unknown>) => {
        const { getTelephonyProvider, getCallManager } = await import('@/voice/telephony');
        const callManager = getCallManager();
        const session = callManager.get(args.call_id as string);
        if (!session) return { error: `Call ${args.call_id} not found` };

        const provider = await getTelephonyProvider();
        if (provider) {
          try { await provider.endCall(session.providerCallId); } catch { /* ignore */ }
        }
        callManager.updateStatus(session.id, 'ended');
        return { callId: session.id, status: 'ended' };
      },
    );

    this.registerTool(
      'get_status',
      'Get the status of a phone call.',
      {
        type: 'object',
        properties: { call_id: { type: 'string', description: 'Call ID' } },
        required: ['call_id'],
      },
      async (args: Record<string, unknown>) => {
        const { getCallManager } = await import('@/voice/telephony');
        const session = getCallManager().get(args.call_id as string);
        if (!session) return { error: `Call ${args.call_id} not found` };
        return { callId: session.id, status: session.status, direction: session.direction, from: session.from, to: session.to, provider: session.provider };
      },
    );

    this.registerTool(
      'list_calls',
      'List all active phone calls.',
      { type: 'object', properties: {} },
      async () => {
        const { getCallManager } = await import('@/voice/telephony');
        const active = getCallManager().getActive();
        if (active.length === 0) return { calls: [], message: 'No active calls' };
        return { calls: active.map(c => ({ callId: c.id, status: c.status, to: c.to, from: c.from })) };
      },
    );
  }
}
