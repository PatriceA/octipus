import { mayUseInstallModels } from '@/models/install-access';
import { Elysia, t } from '@/api/http';
import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { isAdmin } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

/**
 * The conversation speech is for, when the caller names one it may use:
 * its protection level decides whether a cloud engine may hear or speak it
 * (a spoken reply carries what the agent read). Unknown or not theirs → 404.
 */
async function speechSession(userId: string, sessionId: string | undefined): Promise<string | undefined | null> {
  if (!sessionId) return undefined;
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const { canActInSession } = await import('@/core/rooms/access');
  // i2: by id, and only used when canActInSession says the caller may speak in it.
  const session = await sessionRepository.findById(sessionId);
  return (await canActInSession(session, userId, 'voice')) ? sessionId : null;
}

/** Hosted TTS is metered per 1k characters — bound the request body. */
const MAX_TTS_CHARS = 5000;

const TTS_FORMATS = ['mp3', 'wav', 'pcm', 'flac', 'opus'] as const;


/**
 * The URL a telephony provider signed: the public base (`voice.publicUrl`)
 * with the path and query this request arrived on — `request.url` is the
 * internal one (localhost) behind a proxy.
 */
function signedWebhookUrl(publicBase: string, rawUrl: string): string {
  if (!publicBase) return rawUrl;
  const u = new URL(rawUrl);
  return `${publicBase.replace(/\/+$/, '')}${u.pathname}${u.search}`;
}

/** The webhook's fields: form-encoded (Twilio, Plivo) or JSON (Telnyx). */
function webhookFields(raw: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw).entries());
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Handle telephony provider webhook events (call answered, speech gathered, hangup).
 *
 * The signature is checked over the exact bytes the provider sent (`raw`)
 * before anything is parsed; a webhook that does not verify is refused with
 * 403 and does nothing.
 */
async function handleVoiceWebhook(
  provider: string,
  raw: string,
  request: Request,
): Promise<{ status: 403 } | { status: 200; xml: string }> {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const { getSettingsService } = await import('@/config/settings-service');
  const settingsSvc = getSettingsService();
  const publicBase = (await settingsSvc.get('voice.publicUrl') as string) || '';
  const url = signedWebhookUrl(publicBase, request.url);
  const { getTelephonyProvider, getCallManager } = await import('@/voice/telephony');
  const telephonyProvider = await getTelephonyProvider(provider);

  if (!telephonyProvider) {
    return { status: 200, xml: '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>' };
  }

  if (!telephonyProvider.verifyWebhook(headers, raw, url)) {
    apiLogger.warn({ provider }, 'Voice webhook refused: signature verification failed');
    return { status: 403 };
  }
  const body = webhookFields(raw, headers['content-type'] ?? '');
  return { status: 200, xml: await answerVoiceWebhook(provider, body, url, telephonyProvider, getCallManager(), publicBase) };
}

/** Act on a verified webhook; returns the provider's XML answer. */
async function answerVoiceWebhook(
  provider: string,
  body: Record<string, unknown>,
  url: string,
  telephonyProvider: import('@/voice/telephony').TelephonyProvider,
  callManager: import('@/voice/telephony').CallManager,
  publicBase: string,
): Promise<string> {
  const { getSettingsService } = await import('@/config/settings-service');
  const settingsSvc = getSettingsService();
  // Debug: log all webhook fields to diagnose speech recognition issues
  apiLogger.info({ provider, bodyKeys: Object.keys(body), callStatus: body.CallStatus, speechResult: body.SpeechResult ? 'present' : 'absent', callSid: body.CallSid }, 'Voice webhook received');

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
  // FAST PATH: direct LLM call with expert system prompt, no root agent.
  const speechResult = (body.SpeechResult || body.speech || body.Speech || '') as string;
  if (speechResult && session) {
    apiLogger.info({ callId: session.id, speech: speechResult.slice(0, 200) }, 'Voice speech received');

    try {
      const { getLiteLLMClient } = await import('@/models/litellm-client');
      const { getModelRegistry } = await import('@/models/model-registry');
      const client = getLiteLLMClient();
      const registry = getModelRegistry();

      // Model: voice topic routing → system default (ignore per-call overrides from LLM agents)
      // A phone call has no signed-in requester: install lanes only (§8.2).
      let voiceModelId: string | undefined;
      let voiceModelName: string | undefined;
      try {
        const { ModelSelector } = await import('@/core/agent/model-selector');
        const selector = new ModelSelector();
        const routing = await selector.selectForWorker('voice', false);
        voiceModelId = routing.model;
        voiceModelName = routing.name || undefined;
      } catch { /* fallback below */ }
      if (!voiceModelId) {
        const fallback = await registry.getDefaultModel();
        voiceModelId = fallback?.modelId;
        voiceModelName = fallback?.name;
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
        modelConfigName: voiceModelName,
        messages: [
          { role: 'system', content: expertPrompt, timestamp: new Date() },
          ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, timestamp: new Date() })),
        ],
        ...voiceParams,
        // A phone call has no signed-in requester: the install's phone line pays.
        funding: 'install',
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
    async ({ user, body, set }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      try {
        const { audio, format, model } = body;
        const sessionId = await speechSession(user.id, body.sessionId);
        if (sessionId === null) { set.status = 404; return { error: 'Session not found' }; }
        // The engine bound to the Transcription lane (primary, then backup);
        // `model` may name a row or an old engine name. Hosted engines spend
        // the install's keys: only local ones for an account the install's
        // models are not for (install-access.ts).
        const { transcribeWithLane } = await import('@/voice/resolve');
        const result = await transcribeWithLane(Buffer.from(audio, 'base64'), {
          userId: user.id,
          sessionId,
          override: model || null,
          allowHosted: await mayUseInstallModels(user.id),
          format: format || 'webm',
        });
        return { text: result.text, model: result.model, language: result.language, duration: result.duration };
      } catch (error) {
        if ((error as { code?: string }).code === 'capability_not_configured') {
          set.status = 409;
          return { error: (error as Error).message, code: 'capability_not_configured', capability: 'hear' };
        }
        apiLogger.error({ error }, 'Voice transcription failed');
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        audio: t.String({ description: 'Base64-encoded audio data' }),
        format: t.Optional(t.String({ description: 'Audio format (webm, ogg, mp3, wav)' })),
        model: t.Optional(t.String({ description: 'A Transcription-lane model row name, or an engine name ("local", "whisper", "fasterwhisper", "mistral"/"voxtral-*", "openai"/"whisper-1"); unset = the lane binding' })),
        sessionId: t.Optional(t.String({ maxLength: 100, description: 'The conversation the audio belongs to (its protection level applies)' })),
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

      try {
        // The engine bound to the Speech lane (primary, then backup). The
        // requested format must be one the engine writes: the Content-Type
        // always describes the bytes returned.
        const sessionId = await speechSession(user.id, body.sessionId);
        if (sessionId === null) { set.status = 404; return { error: 'Session not found' }; }
        const { synthesizeWithLane } = await import('@/voice/resolve');
        const spoken = await synthesizeWithLane(body.text, {
          userId: user.id,
          sessionId,
          voice: body.voice_id,
          format: body.format,
          strictFormat: !!body.format,
          allowHosted: await mayUseInstallModels(user.id),
        });
        return new Response(new Uint8Array(spoken.audio), { headers: { 'Content-Type': spoken.contentType } });
      } catch (error) {
        if ((error as { code?: string }).code === 'capability_not_configured') {
          set.status = 409;
          return { error: (error as Error).message, code: 'capability_not_configured', capability: 'speak' };
        }
        const message = (error as Error).message;
        set.status = /writes .* only|may not use/.test(message) ? 400 : 500;
        apiLogger.error({ error }, 'Voice synthesis failed');
        return { error: message };
      }
    },
    {
      body: t.Object({
        // Hosted TTS is billed per 1k characters — an unbounded body is a
        // billing hole, so cap it at the trust boundary.
        text: t.String({ minLength: 1, maxLength: MAX_TTS_CHARS }),
        voice_id: t.Optional(t.String({ description: 'Preset or custom voice id (provider-specific)' })),
        format: t.Optional(t.Union(TTS_FORMATS.map((f) => t.Literal(f)))),
        sessionId: t.Optional(t.String({ maxLength: 100, description: 'The conversation the speech belongs to (its protection level applies)' })),
      }),
      detail: { tags: ['voice'] },
    }
  )

  .get(
    '/status',
    async ({ user, principal }) => {
      if (!user) return { error: 'Not authenticated' };

      const config = getConfig();
      const { speechStatus } = await import('@/voice/resolve');
      const allowHosted = await mayUseInstallModels(user.id);
      const [stt, tts] = await Promise.all([
        speechStatus('stt', { userId: user.id, allowHosted }),
        speechStatus('tts', { userId: user.id, allowHosted }),
      ]);
      return {
        // What actually serves each direction now (the lane binding, probed:
        // the binary runs / the key exists). The web voice UI gates on sttAvailable.
        // Native mobile STT/TTS can use the per-request voice gate without
        // configuring a server audio engine. Clients check this contract.
        mobileVoice: true,
        sttAvailable: stt.available,
        sttReason: stt.reason,
        sttLocal: stt.available && stt.local,
        sttExternal: stt.available && !stt.local,
        ttsAvailable: tts.available,
        ttsReason: tts.reason,
        // Retained for compatibility with existing callers.
        sttEnabled: stt.available,
        ttsEnabled: tts.available,
        localWhisper: stt.engine === 'whisper',
        // Which models serve them are install configuration.
        ...(isAdmin(principal) ? { sttModel: stt.model, sttEngine: stt.engine, ttsModel: tts.model, ttsEngine: tts.engine, ttsProvider: tts.engine } : {}),
        language: config.voice.language || 'en',
      };
    },
    { detail: { tags: ['voice'] } }
  )

  .post(
    '/install',
    async ({ user, principal, set }) => {
      // Builds and installs a host binary: an operator action.
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { installWhisper } = await import('@/voice/whisper');
        const log: string[] = [];
        await installWhisper((line) => {
          log.push(line);
          if (log.length > 200) log.shift(); // keep the tail, cap memory
        });
        // Installed is not enough: it becomes the Transcription engine when
        // nothing else is bound there (never replacing one someone chose).
        // The build worked either way: a binding that fails is a warning, not a failed install.
        try {
          const { useSpeechEngine } = await import('@/voice/speech-rows');
          const used = await useSpeechEngine('whisper', 'stt');
          return { ok: true, log, model: used.row.name, bound: used.bound };
        } catch (bindError) {
          apiLogger.warn({ err: bindError }, 'whisper.cpp installed but not bound to the Transcription lane');
          return { ok: true, log, bound: false, warning: `Installed, but not added as a Transcription engine: ${(bindError as Error).message}. Add it on the Topics page.` };
        }
      } catch (error) {
        const { ToolchainMissingError } = await import('@/voice/whisper');
        set.status = error instanceof ToolchainMissingError ? 422 : 500;
        apiLogger.error({ error }, 'Local whisper install failed');
        return { ok: false, error: (error as Error).message };
      }
    },
    { detail: { tags: ['voice'] } }
  )

  // Register a speech engine from the catalog and bind it to its lane when
  // that lane is free (or `makePrimary`: the engine it replaces stays as the
  // backup). What `octi setup` calls after installing a local engine.
  .post(
    '/engines/use',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { useSpeechEngine } = await import('@/voice/speech-rows');
        const used = await useSpeechEngine(body.engine, body.direction, {
          size: body.size, modelPath: body.modelPath, makePrimary: body.makePrimary,
        });
        return { model: used.row.name, lane: used.lane, bound: used.bound };
      } catch (error) {
        set.status = 400;
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        direction: t.Union([t.Literal('stt'), t.Literal('tts')]),
        engine: t.Union(['whisper', 'fasterwhisper', 'kokoro', 'piper', 'mistral', 'openai'].map((e) => t.Literal(e))) as never,
        size: t.Optional(t.Union(['tiny', 'base', 'small', 'medium', 'large'].map((e) => t.Literal(e)))),
        modelPath: t.Optional(t.String({ maxLength: 4096 })),
        makePrimary: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['voice'] },
    }
  )

  // Telephony webhook — receives call events from Twilio/Telnyx/Plivo.
  // The body stays raw text: the signature covers the exact bytes, and the
  // fields (form-urlencoded or JSON) are parsed only once it verifies.
  .post(
    '/webhook/:provider',
    async ({ params, body, request, set }) => {
      const out = await handleVoiceWebhook(params.provider, body as string, request);
      if (out.status === 403) {
        set.status = 403;
        return { error: 'Webhook signature verification failed' };
      }
      return new Response(out.xml, {
        headers: { 'Content-Type': 'application/xml' },
      });
    },
    {
      params: t.Object({ provider: t.String() }),
      type: 'text',
      parse: ({ request }) => request.text(),
      detail: { tags: ['voice'] },
    }
  )

  // Telephony webhook status callback
  .post(
    '/webhook/:provider/status',
    async ({ params, body, request, set }) => {
      const out = await handleVoiceWebhook(params.provider, body as string, request);
      if (out.status === 403) {
        set.status = 403;
        return { error: 'Webhook signature verification failed' };
      }
      return { ok: true };
    },
    {
      params: t.Object({ provider: t.String() }),
      type: 'text',
      parse: ({ request }) => request.text(),
      detail: { tags: ['voice'] },
    }
  )

  // Active calls list. Admin-only: calls carry no owning user, so the list is
  // every caller's phone numbers on the install.
  .get(
    '/calls',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { getCallManager } = await import('@/voice/telephony');
      const calls = getCallManager().getActive();
      return { calls: calls.map(c => ({ id: c.id, status: c.status, direction: c.direction, from: c.from, to: c.to, provider: c.provider, startedAt: c.startedAt.toISOString() })) };
    },
    { detail: { tags: ['voice'] } }
  )

  // Telephony health
  .get(
    '/telephony/health',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { getTelephonyProvider } = await import('@/voice/telephony');
      const provider = await getTelephonyProvider();
      if (!provider) return { configured: false, provider: null };
      const health = await provider.checkHealth();
      return { configured: true, provider: provider.name, ...health };
    },
    { detail: { tags: ['voice'] } }
  );
