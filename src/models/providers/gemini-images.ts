/**
 * Image generation on Google's native Generative Language API: Imagen
 * (`models/{id}:predict`) and Gemini image models (`:generateContent` with
 * IMAGE output, which also take reference images).
 */
import type { ImageGenerationRequest, ImageGenerationResult } from './interface';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function post(url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(180_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = (json.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new Error(`Gemini image generation failed: ${message}`);
  }
  return json;
}

export async function geminiImages(apiKey: string, req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const aspectRatio = req.aspect === 'landscape' ? '16:9' : req.aspect === 'portrait' ? '9:16' : '1:1';
  const model = encodeURIComponent(req.model.replace(/^models\//, ''));
  if (/^imagen/i.test(req.model)) {
    if (req.references?.length) throw new Error(`${req.model} does not take reference images.`);
    const json = await post(`${BASE}/${model}:predict`, apiKey, {
      instances: [{ prompt: req.prompt }],
      parameters: { sampleCount: req.n, aspectRatio },
    }, req.signal);
    const predictions = (json.predictions as Array<{ bytesBase64Encoded?: string; mimeType?: string }> | undefined) ?? [];
    const images = predictions.filter((p) => p.bytesBase64Encoded).map((p) => ({ data: Buffer.from(p.bytesBase64Encoded as string, 'base64'), mimeType: p.mimeType || 'image/png' }));
    if (images.length === 0) throw new Error(`${req.model} returned no image (the prompt may have been filtered).`);
    return { images };
  }
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
  for (const r of req.references ?? []) parts.push({ inline_data: { mime_type: r.mimeType, data: r.data.toString('base64') } });
  const images: ImageGenerationResult['images'] = [];
  let revisedPrompt: string | undefined;
  let shaped = req.aspect !== 'square';
  for (let i = 0; i < req.n; i++) {
    const body = (withShape: boolean) => ({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(withShape ? { imageConfig: { aspectRatio } } : {}) },
    });
    let json: Record<string, unknown>;
    try {
      json = await post(`${BASE}/${model}:generateContent`, apiKey, body(shaped), req.signal);
    } catch (err) {
      // Older image models refuse imageConfig: draw square rather than fail.
      if (!shaped || !/image_?config|imageConfig|aspect/i.test((err as Error).message)) throw err;
      shaped = false;
      json = await post(`${BASE}/${model}:generateContent`, apiKey, body(false), req.signal);
    }
    const out = ((json.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined)?.[0]?.content?.parts) ?? [];
    for (const part of out) {
      const inline = (part.inlineData ?? part.inline_data) as { data?: string; mimeType?: string; mime_type?: string } | undefined;
      if (inline?.data) images.push({ data: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType || inline.mime_type || 'image/png' });
      else if (!revisedPrompt && typeof part.text === 'string' && part.text.trim()) revisedPrompt = part.text.trim();
    }
  }
  if (images.length === 0) throw new Error(`${req.model} returned no image (the prompt may have been filtered).`);
  return { images, revisedPrompt };
}
