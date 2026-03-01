import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { apiLogger } from '@/utils/logger';

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

        // Determine transcription provider
        const transcriptionModel = model || 'whisper-1';

        // If it's an OpenAI whisper model, use OpenAI-compatible API
        // For Ollama whisper, use local endpoint
        if (transcriptionModel.startsWith('whisper') || transcriptionModel.includes('openai')) {
          // Use OpenAI Whisper API
          const formData = new FormData();
          // Convert base64 audio to blob
          const audioBuffer = Buffer.from(audio, 'base64');
          const blob = new Blob([audioBuffer], { type: `audio/${format || 'webm'}` });
          formData.append('file', blob, `audio.${format || 'webm'}`);
          formData.append('model', transcriptionModel);

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
        model: t.Optional(t.String({ description: 'Transcription model to use' })),
      }),
      detail: { tags: ['voice'] },
    }
  );
