/**
 * A message's media in each provider's wire format (media-content.ts), and
 * which models are shown a tool's image.
 */
import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import { acceptsImagesAfterToolResults, anthropicMediaBlocks, geminiMediaParts, ollamaImages, openAiContentParts, openAiRoleContent, seesToolImages } from './media-content';

const withImage: AgentMessage = {
  role: 'user', content: 'What is this?', timestamp: new Date(),
  media: [
    { kind: 'image', path: '/w/a.png', mimeType: 'image/png', source: 'user', data: 'iVBORw0' },
    { kind: 'audio', path: '/w/a.wav', mimeType: 'audio/wav', source: 'user', data: 'UklGR' },
  ],
};
const refsOnly: AgentMessage = { ...withImage, media: withImage.media!.map(({ data: _d, ...r }) => r) };

describe('media in provider formats', () => {
  test('OpenAI-compatible: text then image_url / input_audio parts; refs without bytes send the text alone', () => {
    expect(openAiContentParts(withImage)).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0' } },
      { type: 'input_audio', input_audio: { data: 'UklGR', format: 'wav' } },
    ]);
    expect(openAiContentParts(refsOnly)).toBe('What is this?');
    expect(openAiRoleContent({ role: 'assistant', content: 'ok', timestamp: new Date() })).toEqual({ role: 'assistant', content: 'ok' });
  });

  test('Anthropic: base64 image blocks (no audio)', () => {
    expect(anthropicMediaBlocks(withImage)).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0' } }]);
  });

  test('Gemini: inline_data for images and audio', () => {
    expect(geminiMediaParts(withImage)).toEqual([
      { inline_data: { mime_type: 'image/png', data: 'iVBORw0' } },
      { inline_data: { mime_type: 'audio/wav', data: 'UklGR' } },
    ]);
  });

  test('Ollama: the images field, images only', () => {
    expect(ollamaImages(withImage)).toEqual(['iVBORw0']);
    expect(ollamaImages(refsOnly)).toBeUndefined();
  });

  test('a tool\'s image is shown to a model that reads images on a provider that takes it, unless descriptions are asked for', () => {
    expect(acceptsImagesAfterToolResults('openai')).toBe(true);
    expect(acceptsImagesAfterToolResults('mistral')).toBe(false);
    expect(seesToolImages({ supportsVision: true, provider: 'anthropic' }, 'auto')).toBe(true);
    expect(seesToolImages({ supportsVision: true, provider: 'anthropic' }, 'describe')).toBe(false);
    expect(seesToolImages({ supportsVision: true, provider: 'mistral' }, 'auto')).toBe(false);
    expect(seesToolImages({ supportsVision: true, provider: 'cli' }, 'auto')).toBe(false);
    expect(seesToolImages({ supportsVision: false, provider: 'openai' }, 'auto')).toBe(false);
    expect(seesToolImages(null, 'auto')).toBe(false);
  });
});
