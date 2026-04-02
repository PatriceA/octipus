import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';

// Lazy-initialized local whisper engine
let localWhisper: import('@/voice/stt').WhisperEngine | null = null;

async function getLocalWhisper() {
  if (localWhisper) return localWhisper;

  const config = getConfig();
  if (!config.voice.whisperModelPath) return null;

  const { WhisperEngine } = await import('@/voice/stt');
  localWhisper = new WhisperEngine(config.voice.whisperModelPath, {
    language: config.voice.language || 'en',
  });
  return localWhisper;
}

/**
 * Handle telephony provider webhook events (call answered, speech gathered, hangup).
 */
async function handleVoiceWebhook(provider: string, body: Record<string, unknown>, headers: Record<string, string>, url: string): Promise<string> {
  const { getTelephonyProvider, getCallManager } = await import('@/voice/telephony');
  const telephonyProvider = await getTelephonyProvider(provider);

  if (!telephonyProvider) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  }

  // Verify webhook signature
  if (!telephonyProvider.verifyWebhook(headers, JSON.stringify(body), url)) {
    apiLogger.warn({ provider }, 'Voice webhook signature verification failed');
    // Continue anyway for now — some dev setups don't have signing configured
  }

  const callManager = getCallManager();
  const providerCallId = (body.CallSid || body.call_control_id || body.RequestUUID || '') as string;
  const session = callManager.getByProviderCallId(providerCallId);

  // Call answered — speak the initial message or start conversation
  const callStatus = (body.CallStatus || body.event_type || body.Event || '') as string;

  if (callStatus === 'ringing' || callStatus === 'initiated') {
    if (session) callManager.updateStatus(session.id, 'ringing');
    return telephonyProvider.generateHangupResponse(); // Wait for answer
  }

  if (callStatus === 'in-progress' || callStatus === 'answered' || callStatus === 'call.answered') {
    if (session) {
      callManager.updateStatus(session.id, 'active');
      const mode = session.metadata.mode as string;
      const pending = session.metadata.pendingMessage as string | undefined;

      if (pending) {
        delete session.metadata.pendingMessage;
        const webhookUrl = `${url}`;
        return telephonyProvider.generateAnswerResponse({
          message: pending,
          gatherSpeech: mode === 'conversation',
          callbackUrl: mode === 'conversation' ? webhookUrl : undefined,
        });
      }
    }
  }

  // Speech gathered (conversation mode) — transcribed speech from caller.
  // FAST PATH: direct LLM call with expert system prompt, no orchestrator.
  const speechResult = (body.SpeechResult || body.speech || body.Speech || '') as string;
  if (speechResult && session) {
    apiLogger.info({ callId: session.id, speech: speechResult.slice(0, 200) }, 'Voice speech received');

    try {
      const { getLiteLLMClient } = await import('@/models/litellm-client');
      const { getModelRegistry } = await import('@/models/model-registry');
      const client = getLiteLLMClient();
      const registry = getModelRegistry();

      // Model: per-call override → topic "voice" routing → system default
      let voiceModelId = session.metadata.voiceModel as string | undefined;
      if (!voiceModelId) {
        try {
          // Use the model assigned to the "voice" topic in the model registry
          const { ModelSelector } = await import('@/core/orchestrator/model-selector');
          const selector = new ModelSelector();
          const routing = await selector.selectForWorker('voice', false);
          voiceModelId = routing.model;
        } catch { /* fallback below */ }
      }
      if (!voiceModelId) {
        voiceModelId = (await registry.getDefaultModel())?.modelId || 'qwen3:14b';
      }

      // Build conversation history (kept in session metadata for speed — no DB round-trip)
      const history = (session.metadata.conversationHistory || []) as Array<{ role: string; content: string }>;
      history.push({ role: 'user', content: speechResult });

      // Expert prompt: per-call override → expert assigned to "voice" topic → default
      let expertPrompt = session.metadata.expertPrompt as string | undefined;
      if (!expertPrompt) {
        try {
          const { getDb } = await import('@/db/postgres');
          const { experts } = await import('@/db/schema/experts');
          const { eq } = await import('drizzle-orm');
          const db = getDb();
          // Find expert with role matching communication (which has the voice tool)
          const [voiceExpert] = await db.select().from(experts)
            .where(eq(experts.role, 'communication'))
            .limit(1);
          if (voiceExpert?.systemPrompt) {
            expertPrompt = voiceExpert.systemPrompt + '\n\nIMPORTANT: You are on a live phone call. Keep responses short (1-3 sentences), natural, conversational. No markdown, no lists, no code.';
          }
        } catch { /* use default */ }
      }
      if (!expertPrompt) {
        expertPrompt = 'You are a helpful voice assistant on a phone call. Keep responses short (1-3 sentences), natural, and conversational. No markdown, no lists, no code blocks.';
      }

      const startTime = Date.now();
      const result = await client.complete({
        model: voiceModelId,
        messages: [
          { role: 'system', content: expertPrompt, timestamp: new Date() },
          ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, timestamp: new Date() })),
        ],
        temperature: 0.7,
        maxTokens: 256, // Short responses for voice
      });

      const spoken = result.content || 'I didn\'t catch that.';
      history.push({ role: 'assistant', content: spoken });

      // Keep last 20 turns to limit context size
      if (history.length > 40) history.splice(0, history.length - 40);
      session.metadata.conversationHistory = history;

      apiLogger.info(
        { callId: session.id, latencyMs: Date.now() - startTime, model: voiceModelId, tokens: result.usage.totalTokens },
        'Voice LLM response (direct)',
      );

      return telephonyProvider.generateAnswerResponse({
        message: spoken,
        gatherSpeech: true,
        callbackUrl: url,
      });
    } catch (error) {
      apiLogger.error({ error, callId: session.id }, 'Voice LLM call failed');
      return telephonyProvider.generateAnswerResponse({
        message: 'I had trouble processing that. Could you repeat?',
        gatherSpeech: true,
        callbackUrl: url,
      });
    }
  }

  // Call ended
  if (callStatus === 'completed' || callStatus === 'call.hangup' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
    if (session) {
      const status = callStatus === 'completed' || callStatus === 'call.hangup' ? 'ended' : callStatus as any;
      callManager.updateStatus(session.id, status);
      apiLogger.info({ callId: session.id, status: callStatus }, 'Voice call ended');
    }
    return telephonyProvider.generateHangupResponse();
  }

  return telephonyProvider.generateHangupResponse();
}

export const voiceRoutes = new Elysia({ prefix: '/voice' })
  .use(apiContext)

  .post(
    '/transcribe',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      try {
        const { audio, format, model } = body;
        const transcriptionModel = model || 'local';

        // Try local whisper engine first (if configured)
        if (transcriptionModel === 'local' || transcriptionModel === 'whisper-cpp') {
          const engine = await getLocalWhisper();
          if (engine) {
            const audioBuffer = Buffer.from(audio, 'base64');
            const result = await engine.transcribe(audioBuffer);
            return { text: result.text, model: 'whisper-cpp', language: result.language, duration: result.duration };
          }
          // Fall through to OpenAI if local not configured and model was 'local'
          if (transcriptionModel === 'whisper-cpp') {
            return { error: 'Local whisper not configured (set voice.whisperModelPath)' };
          }
        }

        // OpenAI Whisper API fallback
        if (transcriptionModel.startsWith('whisper') || transcriptionModel.includes('openai') || transcriptionModel === 'local') {
          const formData = new FormData();
          const audioBuffer = Buffer.from(audio, 'base64');
          const blob = new Blob([audioBuffer], { type: `audio/${format || 'webm'}` });
          formData.append('file', blob, `audio.${format || 'webm'}`);
          formData.append('model', transcriptionModel === 'local' ? 'whisper-1' : transcriptionModel);

          const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`,
            },
            body: formData,
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return { error: err?.error?.message || `Transcription failed (${response.status})` };
          }

          const result = await response.json();
          return { text: result.text, model: transcriptionModel };
        }

        return { error: `Unsupported transcription model: ${transcriptionModel}` };
      } catch (error) {
        apiLogger.error({ error }, 'Voice transcription failed');
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        audio: t.String({ description: 'Base64-encoded audio data' }),
        format: t.Optional(t.String({ description: 'Audio format (webm, ogg, mp3, wav)' })),
        model: t.Optional(t.String({ description: 'Transcription model: "local", "whisper-cpp", or "whisper-1" (OpenAI)' })),
      }),
      detail: { tags: ['voice'] },
    }
  )

  .get(
    '/status',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };

      const config = getConfig();
      const engine = await getLocalWhisper();

      return {
        sttEnabled: config.voice.sttEnabled,
        ttsEnabled: config.voice.ttsEnabled,
        localWhisper: !!engine,
        whisperModelPath: config.voice.whisperModelPath || null,
        language: config.voice.language || 'en',
      };
    },
    { detail: { tags: ['voice'] } }
  )

  // Telephony webhook — receives call events from Twilio/Telnyx/Plivo
  .post(
    '/webhook/:provider',
    async ({ params, body, request }) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => { headers[k] = v; });
      const url = request.url;

      const xml = await handleVoiceWebhook(
        params.provider,
        body as Record<string, unknown>,
        headers,
        url,
      );

      return new Response(xml, {
        headers: { 'Content-Type': 'application/xml' },
      });
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['voice'] },
    }
  )

  // Telephony webhook status callback
  .post(
    '/webhook/:provider/status',
    async ({ params, body, request }) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => { headers[k] = v; });

      await handleVoiceWebhook(params.provider, body as Record<string, unknown>, headers, request.url);
      return { ok: true };
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['voice'] },
    }
  )

  // Active calls list
  .get(
    '/calls',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      const { getCallManager } = await import('@/voice/telephony');
      const calls = getCallManager().getActive();
      return { calls: calls.map(c => ({ id: c.id, status: c.status, direction: c.direction, from: c.from, to: c.to, provider: c.provider, startedAt: c.startedAt.toISOString() })) };
    },
    { detail: { tags: ['voice'] } }
  )

  // Telephony health
  .get(
    '/telephony/health',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      const { getTelephonyProvider } = await import('@/voice/telephony');
      const provider = await getTelephonyProvider();
      if (!provider) return { configured: false, provider: null };
      const health = await provider.checkHealth();
      return { configured: true, provider: provider.name, ...health };
    },
    { detail: { tags: ['voice'] } }
  );
