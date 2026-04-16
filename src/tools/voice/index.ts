/**
 * Voice Call Tool — enables agents to make and manage phone calls.
 *
 * Leverages the existing VoiceService for STT/TTS and adds telephony
 * provider integration for actual phone calls via Twilio, Telnyx, or Plivo.
 */

import { BaseTool } from '@/tools/base-tool';
import type { ToolManifest, } from '@/core/types';
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
        { action: 'initiate_call', description: 'Make a phone call', defaultLevel: 'ASK' },
        { action: 'end_call', description: 'End an active call', defaultLevel: 'ALLOW' },
      ],
      tools: [],
    };
  }

  override async checkAvailability() {
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
      'make_call',
      'Make a phone call, deliver a message, and wait for the call to complete. Returns the full outcome including whether the recipient answered and any conversation that occurred. In "notify" mode, speaks a message and hangs up. In "conversation" mode, enables interactive voice exchange where the recipient can respond.',
      {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Phone number in E.164 format (e.g., +1234567890)' },
          message: { type: 'string', description: 'Message to speak when the call is answered' },
          mode: { type: 'string', enum: ['notify', 'conversation'], description: 'notify = one-way message then hangup, conversation = interactive back-and-forth' },
          timeout: { type: 'number', description: 'Max seconds to wait for the call to complete (default: 120)' },
        },
        required: ['to', 'message'],
      },
      async (args: Record<string, unknown>) => {
        const { getTelephonyProvider, getCallManager } = await import('@/voice/telephony');
        const provider = await getTelephonyProvider();
        if (!provider) return { success: false, error: 'No telephony provider configured.' };

        const to = args.to as string;
        const message = args.message as string;
        const mode = (args.mode as string) || 'notify';
        const timeout = Math.min((args.timeout as number) || 120, 300) * 1000;

        const { getSettingsService } = await import('@/config/settings-service');
        const settings = getSettingsService();
        const publicUrl = (await settings.get('voice.publicUrl') as string) || `http://localhost:${process.env.API_PORT || 3005}`;
        const webhookUrl = `${publicUrl}/api/voice/webhook/${provider.name}`;

        let expertPrompt = 'You are a helpful voice assistant on a phone call. Keep responses short (1-3 sentences), natural, and conversational. No markdown, no lists, no code blocks.';
        try {
          const voiceExpertPrompt = await settings.get('voice.expertPrompt') as string | null;
          if (voiceExpertPrompt) expertPrompt = voiceExpertPrompt;
        } catch { /* use default */ }

        try {
          const session = await provider.initiateCall({
            to, message,
            mode: mode as 'notify' | 'conversation',
            webhookUrl,
          });

          session.metadata.pendingMessage = message;
          session.metadata.expertPrompt = expertPrompt;
          session.metadata.conversationHistory = [];

          const callManager = getCallManager();
          callManager.create(session);
          log.info({ callId: session.id, to, mode }, 'Call initiated, waiting for completion');

          // Wait for the call to complete instead of returning immediately.
          // The webhook handler updates the session status as events arrive.
          const startTime = Date.now();
          const pollInterval = 2000;
          let finalStatus = session.status;

          while (Date.now() - startTime < timeout) {
            await new Promise(r => setTimeout(r, pollInterval));
            const current = callManager.get(session.id);
            if (!current) break;
            finalStatus = current.status;
            if (finalStatus === 'ended' || finalStatus === 'failed' || finalStatus === 'busy' || finalStatus === 'no-answer') {
              break;
            }
          }

          // Gather results
          const current = callManager.get(session.id);
          const history = (current?.metadata?.conversationHistory || []) as Array<{ role: string; content: string }>;
          const recipientResponses = history.filter(m => m.role === 'user').map(m => m.content);
          const durationMs = current?.endedAt ? current.endedAt.getTime() - current.startedAt.getTime() : Date.now() - startTime;

          const answered = finalStatus === 'ended' || finalStatus === 'active';
          const hasResponse = recipientResponses.length > 0;

          log.info({ callId: session.id, finalStatus, answered, hasResponse, responses: recipientResponses.length, durationMs }, 'Call completed');

          return {
            success: answered,
            callId: session.id,
            to,
            status: finalStatus,
            answered,
            recipientResponded: hasResponse,
            recipientResponse: hasResponse ? recipientResponses.join(' ') : null,
            conversationHistory: history.length > 0 ? history : null,
            durationSeconds: Math.round(durationMs / 1000),
            summary: !answered
              ? `Call to ${to} was not answered (${finalStatus}).`
              : hasResponse
                ? `Call answered. Recipient said: "${recipientResponses.join(' ')}"`
                : `Call answered but recipient hung up without responding. Message was delivered.`,
          };
        } catch (error) {
          return { success: false, error: `Call failed: ${(error as Error).message}`, to };
        }
      },
      { requiresPermission: true, permissionAction: 'initiate_call' },
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
  }
}
