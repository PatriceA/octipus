/**
 * A message's media (images, audio) in each provider's wire format
 * (docs/MEDIA.md). Only a request's copy of a message carries bytes
 * (`MediaRef.data`, set by src/core/media/hydrate.ts); a message whose media
 * has no bytes is sent as its text alone.
 */
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentMessage, MediaRef } from '@/core/types';

function loaded(msg: AgentMessage): MediaRef[] {
  return (msg.media ?? []).filter((m) => typeof m.data === 'string' && m.data.length > 0);
}

/** `audio/wav` → `wav`, as OpenAI's `input_audio.format` wants it. */
function audioFormat(mimeType: string): 'wav' | 'mp3' {
  return /mpeg|mp3/.test(mimeType) ? 'mp3' : 'wav';
}

/** OpenAI-compatible chat content: text, then `image_url` / `input_audio` parts. */
export function openAiContentParts(msg: AgentMessage): string | ChatCompletionContentPart[] {
  const media = loaded(msg);
  if (media.length === 0) return msg.content;
  return [
    ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
    ...media.map((m): ChatCompletionContentPart => m.kind === 'image'
      ? { type: 'image_url', image_url: { url: `data:${m.mimeType};base64,${m.data}` } }
      : { type: 'input_audio', input_audio: { data: m.data as string, format: audioFormat(m.mimeType) } }),
  ];
}

/**
 * The `{ role, content }` of a system/user/assistant message for an
 * OpenAI-compatible endpoint; only user messages carry media parts.
 */
export function openAiRoleContent(msg: AgentMessage): ChatCompletionMessageParam {
  if (msg.role === 'user') return { role: 'user', content: openAiContentParts(msg) };
  return { role: msg.role as 'system' | 'assistant', content: msg.content };
}

/** Anthropic content blocks for a user turn's media. */
export function anthropicMediaBlocks(msg: AgentMessage): Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> {
  return loaded(msg)
    .filter((m) => m.kind === 'image')
    .map((m) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: m.mimeType, data: m.data as string } }));
}

/** Gemini `inline_data` parts (images and audio alike). */
export function geminiMediaParts(msg: AgentMessage): Array<{ inline_data: { mime_type: string; data: string } }> {
  return loaded(msg).map((m) => ({ inline_data: { mime_type: m.mimeType, data: m.data as string } }));
}

/** Ollama native `/api/chat`: the message's `images` (base64, images only). */
export function ollamaImages(msg: AgentMessage): string[] | undefined {
  const images = loaded(msg).filter((m) => m.kind === 'image').map((m) => m.data as string);
  return images.length ? images : undefined;
}

/**
 * Whether a provider takes a user message right after tool results, which is
 * how a tool's image (view_image, a screenshot) is shown to the model. Mistral
 * rejects a user turn directly after tool turns: there an image from a tool is
 * described by the Vision lane instead (the text route). The image-after-tool-
 * result conformance probe (models/testing) can confirm or overrule this.
 */
export function acceptsImagesAfterToolResults(provider: string): boolean {
  return provider !== 'mistral' && provider !== 'cli';
}

/**
 * Is this model shown the image itself when a tool (view_image, a
 * screenshot) returns one? It reads images, its provider takes them after a
 * tool result, and the install does not ask for descriptions instead.
 */
export function seesToolImages(row: { supportsVision?: boolean | null; provider: string } | null | undefined, imageInput: string | undefined): boolean {
  return !!row?.supportsVision && acceptsImagesAfterToolResults(row.provider) && imageInput !== 'describe';
}
