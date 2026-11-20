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

/** A speech row's own settings (`metadata.speech`), as the Voice page edits them. `null` clears one. */
const SPEECH_SETTINGS = t.Partial(t.Object({
  streamingModel: t.Union([t.Null(), t.String({ maxLength: 200 })]),
  voices: t.Union([t.Null(), t.Array(t.String({ maxLength: 200 }), { maxItems: 500 })]),
  formats: t.Union([t.Null(), t.Array(t.Union(['mp3', 'wav', 'opus', 'ogg', 'pcm', 'flac'].map((f) => t.Literal(f))), { maxItems: 6 })]),
  sampleRate: t.Union([t.Null(), t.Number({ minimum: 8000, maximum: 96000 })]),
  voice: t.Union([t.Null(), t.String({ maxLength: 200 })]),
  instructions: t.Union([t.Null(), t.Literal('field'), t.Literal('prefix'), t.Literal('none')]),
  cloning: t.Union([t.Null(), t.Boolean()]),
  streams: t.Union([t.Null(), t.Boolean()]),
  speed: t.Union([t.Null(), t.Boolean()]),
  extraBody: t.Union([t.Null(), t.Record(t.String(), t.Unknown())]),
  upload: t.Union([t.Null(), t.Literal('any'), t.Literal('wav')]),
  // `off`: no live socket, also for a model known to have one (each turn is transcribed whole).
  realtime: t.Union([t.Null(), t.Object({
    protocol: t.Union([t.Literal('openai'), t.Literal('nemo'), t.Literal('off')]),
    url: t.Optional(t.String({ maxLength: 2048 })),
    sampleRate: t.Optional(t.Number({ minimum: 8000, maximum: 48000 })),
  })]),
  device: t.Union([t.Null(), t.Literal('auto'), t.Literal('cpu'), t.Literal('cuda')]),
  computeType: t.Union([t.Null(), t.String({ maxLength: 40 })]),
}));


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

/** The webhook's fields: form-encoded (Twilio, Plivo) or JSON (Telnyx). A body that is neither has none. */
function webhookFields(raw: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw).entries());
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (err) {
    apiLogger.warn({ err, contentType }, 'Voice webhook body is neither a form nor JSON');
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
): Promise<{ status: 403 } | { status: 200; reply: import('@/voice/telephony').WebhookReply }> {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const { getSettingsService } = await import('@/config/settings-service');
  const settingsSvc = getSettingsService();
  const publicBase = (await settingsSvc.get('voice.publicUrl') as string) || '';
  const url = signedWebhookUrl(publicBase, request.url);
  const { getTelephonyProvider, getCallManager } = await import('@/voice/telephony');
  const telephonyProvider = await getTelephonyProvider(provider);

  if (!telephonyProvider) {
    return { status: 200, reply: { contentType: 'application/xml', body: '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>' } };
  }

  if (!telephonyProvider.verifyWebhook(headers, raw, url)) {
    apiLogger.warn({ provider }, 'Voice webhook refused: signature verification failed');
    return { status: 403 };
  }
  const body = webhookFields(raw, headers['content-type'] ?? '');
  return { status: 200, reply: await answerVoiceWebhook(body, url, telephonyProvider, getCallManager(), publicBase) };
}

/**
 * Act on a verified webhook: the provider reads it, the call flow
 * (src/voice/telephony/call-flow.ts) decides, the provider answers.
 */
async function answerVoiceWebhook(
  body: Record<string, unknown>,
  url: string,
  telephonyProvider: import('@/voice/telephony').TelephonyProvider,
  callManager: import('@/voice/telephony').CallManager,
  publicBase: string,
): Promise<import('@/voice/telephony').WebhookReply> {
  const [{ handleCallEvent }, { generatePhoneReply }, { prepareSpokenLine }, { getSettingsService }, { mintMediaStreamToken }, { callAssistantUser }] = await Promise.all([
    import('@/voice/telephony/call-flow'), import('@/voice/telephony/reply'), import('@/voice/telephony/audio-store'),
    import('@/config/settings-service'), import('../voice-media-ws'), import('@/voice/telephony/assistant'),
  ]);
  const settings = getSettingsService();
  // Lines spoken by the install's engine are fetched by the carrier from the
  // audio route next to this webhook — reachable only through a public URL.
  const audioBase = publicBase ? url.replace(/\/webhook\/[^/?#]+(?:\/status)?(?:[?#].*)?$/, '/webhook/audio') : null;
  return handleCallEvent(telephonyProvider.parseWebhook(body), {
    provider: telephonyProvider,
    callManager,
    callbackUrl: url,
    publicBase,
    settings,
    reply: (call, speech) => generatePhoneReply(call, speech),
    line: (text, fixed) => prepareSpokenLine(text, audioBase, fixed),
    mintStreamToken: mintMediaStreamToken,
    // A listed number with a carrier-verified caller ID reaches its owner's full assistant.
    assistantUser: (event) => callAssistantUser(event, {
      settings,
      findUserId: async (username) => {
        const { userRepository } = await import('@/db/repositories/user-repository');
        const owner = await userRepository.findByUsername(username);
        // A deactivated account has no assistant to reach.
        return owner?.isActive ? owner.id : null;
      },
    }),
  });
}

export const voiceRoutes = new Elysia({ prefix: '/voice' })
  .use(apiContext)

  .post(
    '/transcribe',
    async ({ user, principal, body, set }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      try {
        const { audio, format, model } = body;
        // Naming an engine is install configuration: an admin trying one out.
        // `auto` and `local` pick no row (older mobile builds send them).
        if (model && model !== 'auto' && model !== 'local' && !isAdmin(principal)) {
          set.status = 403;
          return { error: 'Only an admin may choose the transcription engine.' };
        }
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
        model: t.Optional(t.String({ description: 'A Transcription-lane model row name, or an engine name ("whisper", "fasterwhisper", "mistral"/"voxtral-*", "openai"/"whisper-1") (admin); "local" or "auto" for anyone; unset = the lane binding' })),
        sessionId: t.Optional(t.String({ maxLength: 100, description: 'The conversation the audio belongs to (its protection level applies)' })),
      }),
      detail: { tags: ['voice'] },
    }
  )

  .post(
    '/speak',
    async ({ user, principal, body, set }) => {
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
        const { forSpeech } = await import('@/shared/speech-text');
        // Spoken as it would be said: markup, code and sources are not read out (`raw` keeps the text as it is).
        const text = body.raw ? body.text : forSpeech(body.text);
        if (!text) { set.status = 400; return { error: 'Nothing to say: the text is only markup, code or sources.' }; }
        // Naming an engine is install configuration: an admin trying one out.
        if (body.model && !isAdmin(principal)) { set.status = 403; return { error: 'Only an admin may choose the speech engine.' }; }
        const spoken = await synthesizeWithLane(text, {
          userId: user.id,
          sessionId,
          override: body.model || null,
          voice: body.voice ?? body.voice_id,
          profile: body.profile,
          instructions: body.instructions,
          speed: body.speed,
          format: body.format,
          strictFormat: !!body.format,
          allowHosted: await mayUseInstallModels(user.id),
        });
        return new Response(new Uint8Array(spoken.audio), { headers: { 'Content-Type': spoken.contentType, 'X-Speech-Model': encodeURIComponent(spoken.model) } });
      } catch (error) {
        if ((error as { code?: string }).code === 'capability_not_configured') {
          set.status = 409;
          return { error: (error as Error).message, code: 'capability_not_configured', capability: 'speak' };
        }
        const message = (error as Error).message;
        set.status = /writes .* only|may not use|No voice profile|not a text-to-speech engine/.test(message) ? 400 : 500;
        apiLogger.error({ error }, 'Voice synthesis failed');
        return { error: message };
      }
    },
    {
      body: t.Object({
        // Hosted TTS is billed per 1k characters — an unbounded body is a
        // billing hole, so cap it at the trust boundary.
        text: t.String({ minLength: 1, maxLength: MAX_TTS_CHARS }),
        voice: t.Optional(t.String({ maxLength: 200, description: 'A voice profile by name, or a voice the engine offers' })),
        voice_id: t.Optional(t.String({ maxLength: 200, description: 'Older name of `voice`' })),
        profile: t.Optional(t.String({ maxLength: 60, description: 'A voice profile by name' })),
        instructions: t.Optional(t.String({ maxLength: 1000, description: 'How the voice should sound or the line be delivered (engines that take a description)' })),
        speed: t.Optional(t.Number({ minimum: 0.5, maximum: 2 })),
        model: t.Optional(t.String({ maxLength: 200, description: 'A Speech-lane model row to speak with instead of the lane binding (admin)' })),
        raw: t.Optional(t.Boolean({ description: 'Speak the text exactly as given, without removing markup, code and sources' })),
        format: t.Optional(t.Union(TTS_FORMATS.map((f) => t.Literal(f)))),
        sessionId: t.Optional(t.String({ maxLength: 100, description: 'The conversation the speech belongs to (its protection level applies)' })),
      }),
      detail: { tags: ['voice'] },
    }
  )

  // The voices to choose from: what the bound speech engine offers, and the
  // install's voice profiles. How a profile is made (its description, the
  // words of its clip, the engine it is for) is install configuration: a
  // member sees its name, note, preset voice and whether it has a clip.
  .get(
    '/voices',
    async ({ user, principal, query, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const { speechVoices } = await import('@/voice/resolve');
      const { activeVoiceProfileName, listVoiceProfiles } = await import('@/voice/profiles');
      const allowHosted = await mayUseInstallModels(user.id);
      const engine = await speechVoices({ userId: user.id, allowHosted, override: isAdmin(principal) ? query.model || null : null })
        .catch((error: Error) => ({ model: null, voices: [] as string[], reason: error.message }));
      const profiles = await listVoiceProfiles();
      const admin = isAdmin(principal);
      return {
        ...engine,
        active: await activeVoiceProfileName(),
        profiles: profiles.map(({ refAudio, refAudioType: _type, ...p }) => (admin
          ? { ...p, hasClip: !!refAudio }
          : { name: p.name, description: p.description, voice: p.voice, hasClip: !!refAudio })),
      };
    },
    { query: t.Object({ model: t.Optional(t.String({ maxLength: 200 })) }), detail: { tags: ['voice'] } }
  )

  // Create a voice profile, or replace the one of that name: a voice the
  // engine offers, a description of a voice, and/or a reference clip.
  .put(
    '/profiles/:name',
    async ({ user, principal, params, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { saveVoiceProfile, setActiveVoiceProfile } = await import('@/voice/profiles');
        const profile = await saveVoiceProfile({
          name: params.name,
          description: body.description,
          voice: body.voice,
          instructions: body.instructions,
          refText: body.refText,
          speed: body.speed,
          model: body.model,
          clip: body.clip === null ? null : body.clip ? { data: Buffer.from(body.clip.data, 'base64'), mimeType: body.clip.mimeType } : undefined,
        }, user!.id);
        if (body.active) await setActiveVoiceProfile(profile.name, user!.id);
        const { refAudio, refAudioType: _type, ...rest } = profile;
        return { profile: { ...rest, hasClip: !!refAudio } };
      } catch (error) {
        set.status = 400;
        return { error: (error as Error).message };
      }
    },
    {
      params: t.Object({ name: t.String({ maxLength: 60 }) }),
      body: t.Object({
        description: t.Optional(t.String({ maxLength: 300 })),
        voice: t.Optional(t.String({ maxLength: 200 })),
        instructions: t.Optional(t.String({ maxLength: 1000 })),
        refText: t.Optional(t.String({ maxLength: 2000 })),
        speed: t.Optional(t.Number({ minimum: 0.5, maximum: 2 })),
        model: t.Optional(t.String({ maxLength: 200 })),
        // A reference clip (base64, at most 10 MB decoded); null removes the stored one.
        clip: t.Optional(t.Union([t.Null(), t.Object({ data: t.String({ maxLength: 14_000_000 }), mimeType: t.String({ maxLength: 100 }) })])),
        active: t.Optional(t.Boolean({ description: 'Also make it the voice replies are spoken in' })),
      }),
      detail: { tags: ['voice'] },
    }
  )

  .delete(
    '/profiles/:name',
    async ({ user, principal, params, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { deleteVoiceProfile } = await import('@/voice/profiles');
      if (!(await deleteVoiceProfile(params.name, user!.id))) { set.status = 404; return { error: 'No such voice profile' }; }
      return { ok: true };
    },
    { params: t.Object({ name: t.String({ maxLength: 60 }) }), detail: { tags: ['voice'] } }
  )

  // Which profile replies, voice notes and phone calls are spoken in ('' = the engine's default voice).
  .post(
    '/profiles/active',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { setActiveVoiceProfile } = await import('@/voice/profiles');
        await setActiveVoiceProfile(body.name, user!.id);
        return { active: body.name };
      } catch (error) {
        set.status = 404;
        return { error: (error as Error).message };
      }
    },
    { body: t.Object({ name: t.String({ maxLength: 60 }) }), detail: { tags: ['voice'] } }
  )

  // A profile's reference clip, to listen to what a voice was cloned from.
  .get(
    '/profiles/:name/clip',
    async ({ user, principal, params, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { getVoiceProfile, voiceProfileClip } = await import('@/voice/profiles');
      const profile = await getVoiceProfile(params.name);
      const clip = profile ? await voiceProfileClip(profile) : undefined;
      if (!clip) { set.status = 404; return { error: 'No reference clip' }; }
      return new Response(new Uint8Array(clip.data), { headers: { 'Content-Type': clip.mimeType } });
    },
    { params: t.Object({ name: t.String({ maxLength: 60 }) }), detail: { tags: ['voice'] } }
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

  // Everything the Voice page shows: what serves each lane, every speech
  // engine registered and whether it can run, what can be installed here,
  // and installs in progress.
  .get(
    '/engines',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { speechOverview } = await import('@/voice/overview');
      return speechOverview({ userId: user!.id, allowHosted: await mayUseInstallModels(user!.id) });
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
        // faster-whisper: a size, a release name (large-v3-turbo) or owner/name on Hugging Face.
        size: t.Optional(t.String({ maxLength: 120 })),
        modelPath: t.Optional(t.String({ maxLength: 4096 })),
        makePrimary: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['voice'] },
    }
  )

  // Your own speech server: any model on an OpenAI-compatible endpoint
  // (Speaches, vLLM-Omni, LocalAI, NeMo-Speech, Groq, …), registered as a
  // model row and bound to its lane. The same name updates the row.
  .post(
    '/engines/server',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      try {
        const { useSpeechServer } = await import('@/voice/speech-rows');
        const used = await useSpeechServer(body);
        return { model: used.row.name, lane: used.lane, bound: used.bound };
      } catch (error) {
        set.status = 400;
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        direction: t.Union([t.Literal('stt'), t.Literal('tts')]),
        endpoint: t.String({ maxLength: 2048 }),
        modelId: t.String({ minLength: 1, maxLength: 200 }),
        name: t.Optional(t.String({ maxLength: 120 })),
        apiKeyRef: t.Optional(t.String({ maxLength: 200 })),
        speech: t.Optional(SPEECH_SETTINGS),
        makePrimary: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['voice'] },
    }
  )

  // What an engine takes, where it differs from what its model is known for
  // (how a voice description is passed, the sample rate, extra request
  // fields, the GPU for faster-whisper, …).
  .patch(
    '/engines/:name',
    async ({ user, principal, params, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { getModelRegistry } = await import('@/models/model-registry');
      const { mergeSpeechSettings, realtimeUrlProblem, speechDirectionOf } = await import('@/voice/speech-rows');
      const { resolveDataPolicy } = await import('@/models/decision');
      const registry = getModelRegistry();
      const row = await registry.getModel(params.name);
      if (!row || row.ownerUserId || !speechDirectionOf(row)) { set.status = 404; return { error: 'No such speech engine' }; }
      const speech = mergeSpeechSettings(row.metadata?.speech ?? {}, body.speech ?? {});
      const problem = realtimeUrlProblem(speech, resolveDataPolicy(row));
      if (problem) { set.status = 400; return { error: problem }; }
      const metadata = { ...(row.metadata ?? {}), speech, ...(body.modelPath !== undefined ? { modelPath: body.modelPath || undefined } : {}) };
      await registry.updateModel(row.name, { metadata });
      return { ok: true };
    },
    {
      params: t.Object({ name: t.String({ maxLength: 200 }) }),
      body: t.Object({ speech: t.Optional(SPEECH_SETTINGS), modelPath: t.Optional(t.String({ maxLength: 4096 })) }),
      detail: { tags: ['voice'] },
    }
  )

  // Remove a speech engine's row (a local engine's files stay on disk).
  .delete(
    '/engines/:name',
    async ({ user, principal, params, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { getModelRegistry } = await import('@/models/model-registry');
      const { speechDirectionOf } = await import('@/voice/speech-rows');
      const registry = getModelRegistry();
      const row = await registry.getModel(params.name);
      if (!row || row.ownerUserId || !speechDirectionOf(row)) { set.status = 404; return { error: 'No such speech engine' }; }
      await registry.deleteModel(row.name);
      return { ok: true };
    },
    { params: t.Object({ name: t.String({ maxLength: 200 }) }), detail: { tags: ['voice'] } }
  )

  // Download and set up a local engine on the server, in the background; the
  // page follows the job through GET /voice/engines.
  .post(
    '/engines/install',
    async ({ user, principal, body, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { startSpeechInstall } = await import('@/voice/install-jobs');
      return { job: startSpeechInstall(body.engine, { size: body.size, makePrimary: body.makePrimary }) };
    },
    {
      body: t.Object({
        engine: t.Union([t.Literal('whisper'), t.Literal('fasterwhisper'), t.Literal('kokoro')]),
        size: t.Optional(t.String({ maxLength: 120 })),
        makePrimary: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['voice'] },
    }
  )

  // A line of a phone call spoken by the install's Speech engine, for the
  // carrier to play (src/voice/telephony/audio-store.ts). Unauthenticated: a
  // carrier presents no credentials, so the random id is the secret, and it
  // stops working within minutes.
  .get(
    '/webhook/audio/:id',
    async ({ params, set }) => {
      const { getCallAudioStore } = await import('@/voice/telephony/audio-store');
      const clip = /^[0-9a-f]{32}$/.test(params.id) ? getCallAudioStore().get(params.id) : null;
      if (!clip) {
        set.status = 404;
        return { error: 'Not found' };
      }
      return new Response(new Uint8Array(clip.audio), {
        headers: { 'Content-Type': clip.contentType, 'Content-Length': String(clip.audio.length), 'Cache-Control': 'no-store' },
      });
    },
    {
      params: t.Object({ id: t.String({ maxLength: 64 }) }),
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
      return new Response(out.reply.body, {
        headers: { 'Content-Type': out.reply.contentType },
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

  // Phone calls: those in progress and those that ended within the last hour
  // (`status` tells them apart). Admin-only: calls carry no owning user, so
  // the list is every caller's phone numbers on the install.
  .get(
    '/calls',
    async ({ user, principal, set }) => {
      const denied = adminDenied({ set, user, principal });
      if (denied) return denied;
      const { getCallManager } = await import('@/voice/telephony');
      const calls = getCallManager().list();
      return {
        calls: calls.map(c => ({
          id: c.id, status: c.status, direction: c.direction, from: c.from, to: c.to, provider: c.provider,
          startedAt: c.startedAt.toISOString(),
          answeredAt: c.answeredAt?.toISOString() ?? null,
          endedAt: c.endedAt?.toISOString() ?? null,
          streaming: c.metadata.streaming === true,
          turns: Array.isArray(c.metadata.conversationHistory) ? c.metadata.conversationHistory.length : 0,
        })),
      };
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
