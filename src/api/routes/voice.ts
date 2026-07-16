import { Elysia, t } from 'elysia';
import { fetchWithTimeout } from '@/utils/http';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';

/** Hosted TTS is metered per 1k characters — bound the request body. */
const MAX_TTS_CHARS = 5000;

const TTS_FORMATS = ['mp3', 'wav', 'pcm', 'flac', 'opus'] as const;
type TtsFormat = (typeof TTS_FORMATS)[number];

const TTS_CONTENT_TYPES: Record<TtsFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'application/octet-stream',
  flac: 'audio/flac',
  opus: 'audio/opus',
};

/**
 * What each engine actually emits, regardless of the requested format. Only
 * Mistral & OpenAI forward `response_format` upstream; piper hardcodes its
 * output, so honouring the client's `format` there would mislabel the body.
 */
const TTS_ENGINE_FORMAT: Record<string, TtsFormat | null> = {
  piper: 'wav',
  mistral: null, // honours the requested format
  openai: null, // honours the requested format
};

/** Resolve real voice availability: does whisper actually run, or is a cloud key set. */
async function resolveVoiceAvailability(config: ReturnType<typeof getConfig>) {
  const { getVoiceAvailability } = await import('@/voice/whisper');
  const { getMistralApiKey } = await import('@/models/providers/mistral-provider');
  const { getOpenAIApiKey } = await import('@/models/providers/openai-provider');
  return getVoiceAvailability({
    sttProvider: config.voice.sttProvider,
    ttsProvider: config.voice.ttsProvider,
    hasMistralKey: !!(await getMistralApiKey()),
    hasOpenAIKey: !!(await getOpenAIApiKey()),
    piperModelPath: config.voice.piperModelPath,
  });
}

// Lazy-initialized local whisper engine
let localWhisper: import('@/voice/stt').WhisperEngine | null = null;

async function getLocalWhisper() {
  if (localWhisper) return localWhisper;

  const config = getConfig();
  // Use the configured model path, else the installed default — and only if the
  // file actually exists, so this agrees with what /status's probe reports
  // (avoids "status says ready but transcribe 400s").
  const { whisperModelPath } = await import('@/voice/whisper');
  const modelPath = config.voice.whisperModelPath || whisperModelPath();
  if (!(await Bun.file(modelPath).exists())) return null;

  const { WhisperEngine } = await import('@/voice/stt');
  localWhisper = new WhisperEngine(modelPath, {
    language: config.voice.language || 'en',
  });
  return localWhisper;
}

/**
 * Handle telephony provider webhook events (call answered, speech gathered, hangup).
 */
async function handleVoiceWebhook(provider: string, body: Record<string, unknown>, headers: Record<string, string>, rawUrl: string): Promise<string> {
  // Resolve the public webhook URL — request.url is the internal URL (localhost),
  // but Twilio needs the public URL for callbacks.
  const { getSettingsService } = await import('@/config/settings-service');
  const settingsSvc = getSettingsService();
  const publicBase = (await settingsSvc.get('voice.publicUrl') as string) || '';
  const url = publicBase ? `${publicBase}/api/voice/webhook/${provider}` : rawUrl;
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

  // Debug: log all webhook fields to diagnose speech recognition issues
  apiLogger.info({ provider, bodyKeys: Object.keys(body), callStatus: body.CallStatus, speechResult: body.SpeechResult ? 'present' : 'absent', callSid: body.CallSid }, 'Voice webhook received');

  const callManager = getCallManager();
  const providerCallId = (body.CallSid || body.call_control_id || body.RequestUUID || '') as string;
  let session = callManager.getByProviderCallId(providerCallId);

  const callStatus = (body.CallStatus || body.event_type || body.Event || '') as string;
  const callerNumber = (body.From || body.from || '') as string;

  // ── Inbound call handling ───────────────────────────────────────
  // When Twilio answers, the first webhook has CallStatus = "ringing" or "in-progress"
  // with no existing session. Create one if the inbound policy allows it.
  if (!session && providerCallId) {
    const inboundPolicy = (await settingsSvc.get('voice.inboundPolicy') as string) || 'disabled';

    if (inboundPolicy === 'disabled') {
      apiLogger.info({ provider, caller: callerNumber }, 'Inbound call rejected (policy: disabled)');
      return telephonyProvider.generateHangupResponse();
    }

    if (inboundPolicy === 'allowlist') {
      const allowList = (await settingsSvc.get('voice.inboundAllowFrom') as string[] | null) || [];
      if (!allowList.includes(callerNumber)) {
        apiLogger.info({ provider, caller: callerNumber }, 'Inbound call rejected (not in allowlist)');
        return telephonyProvider.generateHangupResponse();
      }
    }

    // Policy is "open" or caller is in allowlist — create a session
    const toNumber = (body.To || body.to || '') as string;
    const inboundSession: import('@/voice/telephony').CallSession = {
      id: `inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider,
      providerCallId,
      direction: 'inbound',
      from: callerNumber,
      to: toNumber,
      status: 'active',
      startedAt: new Date(),
      answeredAt: new Date(),
      metadata: { mode: 'conversation', conversationHistory: [] },
    };
    callManager.create(inboundSession);
    session = inboundSession;
    apiLogger.info({ callId: session.id, provider, caller: callerNumber, policy: inboundPolicy }, 'Inbound call accepted');

    // Realtime media-stream path (Phase 4d): if a public wss base is configured
    // and streaming is enabled, hand the call to the bidirectional media socket
    // (low-latency, barge-in) instead of the turn-based <Gather> loop. Requires
    // voice.publicUrl (Twilio must reach a public wss); falls back to Gather.
    const streamingSetting = await settingsSvc.get('voice.streaming');
    const streamingEnabled = streamingSetting === true || streamingSetting === 'true';
    // Only Twilio implements <Connect><Stream>; Plivo/Telnyx would greet-then-
    // hangup, so keep them on the working <Gather> loop.
    if (streamingEnabled && publicBase && provider === 'twilio') {
      const wssBase = publicBase.replace(/^http/, 'ws');
      const { mintMediaStreamToken } = await import('../voice-media-ws');
      const token = mintMediaStreamToken(String(body.CallSid || session.id));
      const streamUrl = `${wssBase}/voice/media/${provider}?token=${token}`;
      apiLogger.info({ callId: session.id, streamUrl: streamUrl.replace(token, '***') }, 'Answering with media stream');
      return telephonyProvider.generateAnswerResponse({
        message: 'Hello, how can I help you?',
        streamUrl,
      });
    }

    // Answer with a greeting and start gathering speech
    return telephonyProvider.generateAnswerResponse({
      message: 'Hello, how can I help you?',
      gatherSpeech: true,
      callbackUrl: url,
    });
  }

  // ── Speech gathered — MUST be checked before call-status handlers ──
  // Twilio sends SpeechResult alongside CallStatus=in-progress on the Gather callback.
  // FAST PATH: direct LLM call with expert system prompt, no orchestrator.
  const speechResult = (body.SpeechResult || body.speech || body.Speech || '') as string;
  if (speechResult && session) {
    apiLogger.info({ callId: session.id, speech: speechResult.slice(0, 200) }, 'Voice speech received');

    try {
      const { getLiteLLMClient } = await import('@/models/litellm-client');
      const { getModelRegistry } = await import('@/models/model-registry');
      const client = getLiteLLMClient();
      const registry = getModelRegistry();

      // Model: voice topic routing → system default (ignore per-call overrides from LLM agents)
      let voiceModelId: string | undefined;
      try {
        const { ModelSelector } = await import('@/core/orchestrator/model-selector');
        const selector = new ModelSelector();
        const routing = await selector.selectForWorker('voice', false);
        voiceModelId = routing.model;
      } catch { /* fallback below */ }
      if (!voiceModelId) {
        voiceModelId = (await registry.getDefaultModel())?.modelId;
      }
      if (!voiceModelId) {
        throw new Error('No model configured for voice topic');
      }

      apiLogger.info({ callId: session.id, voiceModelId }, 'Voice LLM model selected');

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
      expertPrompt += '\n\nWhen the caller says goodbye, thanks you and wants to end the call, or clearly wants to hang up, respond with a brief farewell and include the exact marker [END_CALL] at the end of your response. Example: "Goodbye, have a great day! [END_CALL]"';

      const startTime = Date.now();
      // Honor the voice topic's configured temperature/maxTokens (Topics page)
      // on top of the voice-tuned defaults — same override mechanism workers
      // get via applyTopicParamOverrides in agent-worker.
      const { applyTopicParamOverrides, getTopicConfig } = await import('@/models/topic-config');
      const voiceParams = applyTopicParamOverrides(
        { temperature: 0.7, maxTokens: 256 /* short responses for voice */ },
        getTopicConfig('voice'),
      );
      const result = await client.complete({
        model: voiceModelId,
        messages: [
          { role: 'system', content: expertPrompt, timestamp: new Date() },
          ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, timestamp: new Date() })),
        ],
        ...voiceParams,
      });

      let spoken = result.content || 'I didn\'t catch that.';
      const shouldEndCall = spoken.includes('[END_CALL]');
      spoken = spoken.replace(/\[END_CALL\]/g, '').trim();

      history.push({ role: 'assistant', content: spoken });

      // Keep last 20 turns to limit context size
      if (history.length > 40) history.splice(0, history.length - 40);
      session.metadata.conversationHistory = history;

      apiLogger.info(
        { callId: session.id, latencyMs: Date.now() - startTime, model: voiceModelId, tokens: result.usage.totalTokens, endCall: shouldEndCall },
        'Voice LLM response (direct)',
      );

      if (shouldEndCall) {
        // Speak farewell then hang up
        return telephonyProvider.generateAnswerResponse({
          message: spoken,
          gatherSpeech: false,
        });
      }

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

  // ── Outbound call: ringing ──────────────────────────────────────
  if (callStatus === 'ringing' || callStatus === 'initiated') {
    if (session) callManager.updateStatus(session.id, 'ringing');
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }

  // ── Call answered (outbound with pending message) ───────────────
  if (callStatus === 'in-progress' || callStatus === 'answered' || callStatus === 'call.answered') {
    if (session) {
      callManager.updateStatus(session.id, 'active');
      const pending = session.metadata.pendingMessage as string | undefined;
      if (pending) {
        delete session.metadata.pendingMessage;
        const mode = session.metadata.mode as string;
        return telephonyProvider.generateAnswerResponse({
          message: pending,
          gatherSpeech: mode === 'conversation',
          callbackUrl: mode === 'conversation' ? url : undefined,
        });
      }
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

        // Mistral (Voxtral) hosted transcription
        if (transcriptionModel.startsWith('voxtral')) {
          const { MistralSTTEngine } = await import('@/voice/stt');
          const engine = new MistralSTTEngine(transcriptionModel, { language: getConfig().voice.language });
          const result = await engine.transcribe(Buffer.from(audio, 'base64'));
          return { text: result.text, model: transcriptionModel, language: result.language, duration: result.duration };
        }

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

          const response = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
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
        model: t.Optional(t.String({ description: 'Transcription model: "local", "whisper-cpp", "whisper-1" (OpenAI), or "voxtral-*" (Mistral)' })),
      }),
      detail: { tags: ['voice'] },
    }
  )

  .post(
    '/speak',
    async ({ user, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const config = getConfig();
      // Gate on REAL availability (same source as /status), not the config flag —
      // otherwise a mistral default with no key passes here and 500s downstream.
      const availability = await resolveVoiceAvailability(config);
      if (!availability.tts.available) {
        set.status = 503;
        return { error: availability.tts.reason || 'Text-to-speech is not enabled (configure a TTS provider/key, or voice.piperModelPath for local piper)' };
      }

      try {
        const provider = config.voice.ttsProvider;
        const requested = body.format || 'mp3';
        // Engines with a fixed output format win over the request, so the
        // Content-Type always describes the bytes we actually return.
        const fixed = TTS_ENGINE_FORMAT[provider];
        const format = fixed ?? requested;
        if (fixed && body.format && body.format !== fixed) {
          set.status = 400;
          return { error: `The "${provider}" TTS engine only produces ${fixed}; omit "format" or select a provider that supports ${body.format}` };
        }

        const { createTTSEngine } = await import('@/voice/tts');
        const engine = createTTSEngine(provider, body.voice_id, { outputFormat: format });
        const audio = await engine.synthesize(body.text);

        return new Response(new Uint8Array(audio), {
          headers: { 'Content-Type': TTS_CONTENT_TYPES[format] },
        });
      } catch (error) {
        apiLogger.error({ error }, 'Voice synthesis failed');
        set.status = 500;
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        // Hosted TTS is billed per 1k characters — an unbounded body is a
        // billing hole, so cap it at the trust boundary.
        text: t.String({ minLength: 1, maxLength: MAX_TTS_CHARS }),
        voice_id: t.Optional(t.String({ description: 'Preset or custom voice id (provider-specific)' })),
        format: t.Optional(t.Union(TTS_FORMATS.map((f) => t.Literal(f)))),
      }),
      detail: { tags: ['voice'] },
    }
  )

  .get(
    '/status',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };

      const config = getConfig();
      const availability = await resolveVoiceAvailability(config);

      return {
        // Real availability — the binary actually runs / a cloud key exists —
        // not just a config flag. The web voice UI gates on sttAvailable.
        sttAvailable: availability.stt.available,
        sttReason: availability.stt.reason,
        sttLocal: availability.stt.local,
        sttExternal: availability.stt.external,
        ttsAvailable: availability.tts.available,
        ttsReason: availability.tts.reason,
        // Retained for compatibility with existing callers.
        sttEnabled: availability.stt.available,
        ttsEnabled: availability.tts.available,
        ttsProvider: config.voice.ttsProvider,
        localWhisper: availability.stt.local,
        whisperModelPath: config.voice.whisperModelPath || null,
        language: config.voice.language || 'en',
      };
    },
    { detail: { tags: ['voice'] } }
  )

  .post(
    '/install',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const { installWhisper } = await import('@/voice/whisper');
        const log: string[] = [];
        await installWhisper((line) => {
          log.push(line);
          if (log.length > 200) log.shift(); // keep the tail, cap memory
        });
        return { ok: true, log };
      } catch (error) {
        const { ToolchainMissingError } = await import('@/voice/whisper');
        set.status = error instanceof ToolchainMissingError ? 422 : 500;
        apiLogger.error({ error }, 'Local whisper install failed');
        return { ok: false, error: (error as Error).message };
      }
    },
    { detail: { tags: ['voice'] } }
  )

  // Telephony webhook — receives call events from Twilio/Telnyx/Plivo.
  // Twilio sends application/x-www-form-urlencoded which Elysia doesn't auto-parse.
  // Use a custom `parse` hook to handle both form-urlencoded and JSON.
  .post(
    '/webhook/:provider',
    async ({ params, body, request }) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => { headers[k] = v; });

      const xml = await handleVoiceWebhook(params.provider, body as Record<string, unknown>, headers, request.url);

      return new Response(xml, {
        headers: { 'Content-Type': 'application/xml' },
      });
    },
    {
      params: t.Object({ provider: t.String() }),
      type: 'text',  // Accept raw text so we can parse it ourselves
      async parse({ request }) {
        const ct = request.headers.get('content-type') || '';
        const raw = await request.text();
        if (ct.includes('x-www-form-urlencoded')) {
          return Object.fromEntries(new URLSearchParams(raw).entries());
        }
        try { return JSON.parse(raw); } catch { return {}; }
      },
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
      type: 'text',
      async parse({ request }) {
        const ct = request.headers.get('content-type') || '';
        const raw = await request.text();
        if (ct.includes('x-www-form-urlencoded')) {
          return Object.fromEntries(new URLSearchParams(raw).entries());
        }
        try { return JSON.parse(raw); } catch { return {}; }
      },
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
