/**
 * Media tools — Octipus's media lanes (docs/MEDIA.md → Over MCP and HTTP):
 * draw with the Image generation lane, have the Vision lane describe an
 * image, transcribe with the Transcription lane and speak with the Speech
 * lane. Each is hidden while its capability is not configured.
 *
 * Images and audio travel as base64: this server reads no local files (it
 * has no allowed roots to read them from).
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

function asError(error: unknown) {
  return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
}

/** Base64 from a bare string or a `data:` URL. */
function base64Of(value: string): string {
  const match = /^data:[^;,]*;base64,(.*)$/s.exec(value.trim());
  return (match ? match[1] : value).replace(/\s+/g, '');
}

/** The tools of each capability: hidden while it is not configured. */
export interface MediaTools {
  draw: RegisteredTool[];
  see: RegisteredTool[];
  hear: RegisteredTool[];
  speak: RegisteredTool[];
}

export function registerMediaTools(server: McpServer, client: OctiClient): MediaTools {
  const generateImage = server.tool(
    'octipus_generate_image',
    'Draw images with Octipus\'s Image generation model. Returns the images (PNG or JPEG) and which model drew them. Spend budgets apply.',
    {
      prompt: z.string().min(1).max(4000).describe('What to draw (at most 4000 characters)'),
      aspect_ratio: z.enum(['square', 'landscape', 'portrait']).optional().describe('Shape of the image (default square)'),
      n: z.number().int().min(1).max(4).optional().describe('How many images, 1–4 (default 1)'),
    },
    async ({ prompt, aspect_ratio, n }) => {
      try {
        const result = await client.generateImage({ prompt, aspect_ratio, n });
        const text = [
          `${result.images.length} image${result.images.length === 1 ? '' : 's'} drawn by ${result.model}.`,
          result.revisedPrompt ? `Prompt as the model used it: ${result.revisedPrompt}` : null,
        ].filter(Boolean).join('\n');
        return {
          content: [
            ...result.images.map((image) => ({ type: 'image' as const, data: image.base64, mimeType: image.mimeType })),
            { type: 'text' as const, text },
          ],
        };
      } catch (error) {
        return asError(error);
      }
    },
  );

  const describeImage = server.tool(
    'octipus_describe_image',
    'Have Octipus\'s Vision model describe an image or answer a question about it. For when Octipus\'s vision model should look rather than your own; text in the image is treated as content, not instructions.',
    {
      image: z.string().min(1).describe('The image as base64 (or a data: URL): PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF, at most 10 MB'),
      mime_type: z.string().optional().describe('Its type, if known (the server reads the type from the bytes)'),
      question: z.string().max(2000).optional().describe('What to look for (default: a full description with all visible text)'),
    },
    async ({ image, mime_type, question }) => {
      try {
        const result = await client.describeImage({ image: base64Of(image), mimeType: mime_type, question });
        return { content: [{ type: 'text' as const, text: `${result.description}\n\n---\nDescribed by ${result.model}; another model's reading may be wrong.` }] };
      } catch (error) {
        return asError(error);
      }
    },
  );

  const transcribeAudio = server.tool(
    'octipus_transcribe_audio',
    'Transcribe a recording to text with Octipus\'s Transcription model.',
    {
      audio: z.string().min(1).describe('The recording as base64 (or a data: URL)'),
      format: z.string().optional().describe('Its format: webm (default), ogg, mp3, wav, m4a, flac …'),
    },
    async ({ audio, format }) => {
      try {
        const result = await client.transcribeAudio({ audio: base64Of(audio), format });
        if (result.error) return { content: [{ type: 'text' as const, text: `Failed: ${result.error}` }], isError: true };
        const meta = [
          result.model ? `Model: ${result.model}` : null,
          result.language ? `Language: ${result.language}` : null,
          typeof result.duration === 'number' ? `Duration: ${Math.round(result.duration)}s` : null,
        ].filter(Boolean).join(' | ');
        return { content: [{ type: 'text' as const, text: meta ? `${result.text}\n\n---\n${meta}` : result.text }] };
      } catch (error) {
        return asError(error);
      }
    },
  );

  const speak = server.tool(
    'octipus_speak',
    'Read text aloud with Octipus\'s Speech model. Returns the audio.',
    {
      text: z.string().min(1).max(5000).describe('What to say (at most 5000 characters)'),
      voice: z.string().optional().describe('Voice id (provider-specific; default: the engine\'s voice)'),
      format: z.enum(['mp3', 'wav', 'pcm', 'flac', 'opus']).optional().describe('Audio format (default: the engine\'s own)'),
    },
    async ({ text, voice, format }) => {
      try {
        const audio = await client.speak({ text, voice_id: voice, format });
        return {
          content: [
            { type: 'audio' as const, data: audio.base64, mimeType: audio.mimeType },
            { type: 'text' as const, text: `Spoken (${audio.mimeType}).` },
          ],
        };
      } catch (error) {
        return asError(error);
      }
    },
  );

  return { draw: [generateImage], see: [describeImage], hear: [transcribeAudio], speak: [speak] };
}
