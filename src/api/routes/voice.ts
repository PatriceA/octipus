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
  );
