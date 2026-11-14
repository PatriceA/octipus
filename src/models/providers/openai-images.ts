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

/**
 * Ask for base64 from every model except gpt-image (which always returns it
 * and rejects the field): DALL·E, a LiteLLM alias and compatible servers
 * default to URLs.
 */
function asksForBase64(model: string): boolean {
  // DALL·E only: gpt-image (also behind an alias) rejects the field; any
  // other server's URL answer is fetched instead.
  return /dall-e/i.test(model);
}

const MAX_FETCHED_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * An image a server returned by URL: from the server we already call (a local
 * one too), or through the SSRF guard from anywhere else; capped while
 * streaming, and stopped after a minute.
 */
async function fetchImageUrl(url: string, serverBase: string | undefined): Promise<{ data: Buffer; mimeType: string } | null> {
  let sameServer = false;
  try { sameServer = !!serverBase && new URL(url).origin === new URL(serverBase).origin; } catch { return null; }
  const signal = AbortSignal.timeout(60_000);
  const res = sameServer ? await fetch(url, { signal }) : await (await import('@/utils/sanitize')).fetchGuarded(url, { signal });
  if (!res.ok || !res.body) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_FETCHED_IMAGE_BYTES) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FETCHED_IMAGE_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const data = Buffer.concat(chunks);
  const { sniffImageType } = await import('@/core/media/normalize');
  const mimeType = sniffImageType(data);
  return mimeType ? { data, mimeType } : null;
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
  const data = (response as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }).data ?? [];
  const { sniffImageType } = await import('@/core/media/normalize');
  const images: ImageGenerationResult['images'] = [];
  for (const d of data) {
    if (d.b64_json) {
      const bytes = Buffer.from(d.b64_json, 'base64');
      images.push({ data: bytes, mimeType: sniffImageType(bytes) ?? 'image/png' });
    } else if (d.url) {
      const fetched = await fetchImageUrl(d.url, (client as unknown as { baseURL?: string }).baseURL).catch(() => null);
      if (fetched) images.push(fetched);
    }
  }
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
  let cost: number | undefined;
  for (let i = 0; i < req.n; i++) {
    const response = await client.chat.completions.create({
      model: req.model,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: aspectRatio },
      usage: { include: true },
    } as never, req.signal ? { signal: req.signal } : undefined) as unknown as { usage?: { cost?: number }; choices?: Array<{ message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> } }> };
    if (typeof response.usage?.cost === 'number') cost = (cost ?? 0) + response.usage.cost;
    const message = response.choices?.[0]?.message;
    for (const img of message?.images ?? []) {
      const url = img.image_url?.url ?? '';
      const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(url);
      if (match) images.push({ mimeType: match[1], data: Buffer.from(match[2], 'base64') });
    }
    if (!revisedPrompt && message?.content?.trim()) revisedPrompt = message.content.trim();
  }
  if (images.length === 0) throw new Error(`${req.model} returned no image`);
  return { images, revisedPrompt, ...(cost !== undefined ? { cost } : {}) };
}
