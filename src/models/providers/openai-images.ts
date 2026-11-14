/**
 * Image generation over the OpenAI Images API (`/images/generations`,
 * `/images/edits`) — OpenAI itself, a LiteLLM proxy and OpenAI-compatible
 * endpoints that implement it.
 */
import type OpenAI from 'openai';
import { toFile } from 'openai';
import type { ImageAspect, ImageGenerationRequest, ImageGenerationResult } from './interface';

/** The size the model takes for an aspect (gpt-image / DALL·E 3 / everything else). */
export function openAiImageSize(model: string, aspect: ImageAspect): string {
  const id = model.toLowerCase();
  if (id.includes('dall-e-3')) return aspect === 'landscape' ? '1792x1024' : aspect === 'portrait' ? '1024x1792' : '1024x1024';
  if (id.includes('dall-e-2')) return '1024x1024';
  return aspect === 'landscape' ? '1536x1024' : aspect === 'portrait' ? '1024x1536' : '1024x1024';
}

/** Whether the model returns base64 only when asked (DALL·E); gpt-image always does and rejects the field. */
function asksForBase64(model: string): boolean {
  return /dall-e/i.test(model);
}

export async function openAiImages(client: OpenAI, req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const size = openAiImageSize(req.model, req.aspect) as '1024x1024';
  const common = {
    model: req.model,
    prompt: req.prompt,
    // DALL·E 3 makes one image per call.
    n: /dall-e-3/i.test(req.model) ? 1 : req.n,
    size,
    ...(asksForBase64(req.model) ? { response_format: 'b64_json' as const } : {}),
  };
  const options = req.signal ? { signal: req.signal } : undefined;
  const response = req.references?.length
    ? await client.images.edit({
      ...common,
      image: await Promise.all(req.references.map((r, i) => toFile(r.data, `reference-${i}.${r.mimeType.split('/')[1] ?? 'png'}`, { type: r.mimeType }))),
    } as Parameters<OpenAI['images']['edit']>[0], options)
    : await client.images.generate(common as Parameters<OpenAI['images']['generate']>[0], options);
  const data = (response as { data?: Array<{ b64_json?: string; revised_prompt?: string }> }).data ?? [];
  const images = data.filter((d) => d.b64_json).map((d) => ({ data: Buffer.from(d.b64_json as string, 'base64'), mimeType: 'image/png' }));
  if (images.length === 0) throw new Error(`${req.model} returned no image`);
  return { images, revisedPrompt: data.find((d) => d.revised_prompt)?.revised_prompt };
}

/**
 * OpenRouter (and chat-completions gateways like it): image models answer a
 * chat request with `modalities: ['image', 'text']`; images come back as data
 * URLs on `message.images`.
 */
export async function chatModalityImages(client: OpenAI, req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const aspectRatio = req.aspect === 'landscape' ? '16:9' : req.aspect === 'portrait' ? '9:16' : '1:1';
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
  for (const r of req.references ?? []) content.push({ type: 'image_url', image_url: { url: `data:${r.mimeType};base64,${r.data.toString('base64')}` } });
  const images: ImageGenerationResult['images'] = [];
  let revisedPrompt: string | undefined;
  for (let i = 0; i < req.n; i++) {
    const response = await client.chat.completions.create({
      model: req.model,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: aspectRatio },
    } as never, req.signal ? { signal: req.signal } : undefined) as unknown as { choices?: Array<{ message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> } }> };
    const message = response.choices?.[0]?.message;
    for (const img of message?.images ?? []) {
      const url = img.image_url?.url ?? '';
      const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(url);
      if (match) images.push({ mimeType: match[1], data: Buffer.from(match[2], 'base64') });
    }
    if (!revisedPrompt && message?.content?.trim()) revisedPrompt = message.content.trim();
  }
  if (images.length === 0) throw new Error(`${req.model} returned no image`);
  return { images, revisedPrompt };
}
