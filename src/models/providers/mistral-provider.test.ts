import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MistralProvider } from './mistral-provider';

describe('MistralProvider.supportsModel', () => {
  const p = new MistralProvider();

  it('matches the Mistral model families', () => {
    for (const m of [
      'mistral-large-latest',
      'mistral-small-latest',
      'mistral-embed',
      'magistral-medium-latest',
      'codestral-latest',
      'ministral-8b-latest',
      'devstral-small-latest',
      'pixtral-large-latest',
      'open-mistral-nemo',
    ]) {
      expect(p.supportsModel(m)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(p.supportsModel('Mistral-Large-Latest')).toBe(true);
  });

  it('does not match other providers', () => {
    for (const m of ['gpt-4o', 'claude-sonnet-4-6', 'deepseek-chat', 'llama3.2:3b', 'gemini-2.0-flash']) {
      expect(p.supportsModel(m)).toBe(false);
    }
  });

  it('identifies as a direct provider named "mistral"', () => {
    expect(p.name).toBe('mistral');
    expect(p.type).toBe('direct');
  });

  it('matches the OCR and Voxtral model ids', () => {
    expect(p.supportsModel('mistral-ocr-latest')).toBe(true);
    expect(p.supportsModel('voxtral-mini-latest')).toBe(true);
  });
});

describe('MistralProvider.ocr', () => {
  const p = new MistralProvider();
  // Stub global fetch rather than mock.module — the latter leaks process-wide.
  const realFetch = globalThis.fetch;
  const realKey = process.env.MISTRAL_API_KEY;

  beforeEach(() => { process.env.MISTRAL_API_KEY = 'test-key'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = realKey;
  });

  it('posts a document_url chunk for PDFs and joins page markdown', async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({ model: 'mistral-ocr-latest', pages: [
          { index: 0, markdown: '# Page one' },
          { index: 1, markdown: '| a | b |' },
        ] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await p.ocr({ kind: 'base64', data: 'QUJD', mimeType: 'application/pdf' }, 'mistral-ocr-latest');

    expect(captured!.url).toBe('https://api.mistral.ai/v1/ocr');
    expect(captured!.body.document.type).toBe('document_url');
    expect(captured!.body.document.document_url).toBe('data:application/pdf;base64,QUJD');
    expect(captured!.body.table_format).toBe('markdown');
    expect(result.pages.map((pg) => pg.markdown)).toEqual(['# Page one', '| a | b |']);
  });

  it('posts an image_url chunk for images', async () => {
    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ pages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await p.ocr({ kind: 'base64', data: 'QUJD', mimeType: 'image/png' }, 'mistral-ocr-latest');
    expect(body.document.type).toBe('image_url');
  });

  it('throws a classified error on a non-2xx response', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(p.ocr({ kind: 'url', url: 'https://x/y.pdf' }, 'mistral-ocr-latest')).rejects.toThrow(/429/);
  });
});
