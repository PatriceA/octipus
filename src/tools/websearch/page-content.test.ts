import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { extractPageText, apiDocumentUrl, fetchApiDocument } from './page-content';
import { WebSearchTool } from './index';
import { fetchGuarded } from '@/utils/sanitize';
vi.mock('@/utils/sanitize', () => ({ fetchGuarded: vi.fn(), validateExternalUrl: async () => ({ valid: true }), assertPublicAddress: () => ({ ok: true }) }));

describe('page extraction', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  it('falls back from an empty content container without destroying the live DOM', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main></main><div>Useful API documentation</div><script type="application/json">{"keep":true}</script>');
      expect(await page.evaluate(extractPageText)).toBe('Useful API documentation');
      expect(await page.locator('script').count()).toBe(1);
    } finally { await page.close(); }
  });
  it('uses the literal Swagger schema link relative to the final page URL', () => {
    expect(apiDocumentUrl('SwaggerUIBundle({ url: "/openapi.yaml" })', 'https://example.com/docs'))
      .toBe('https://example.com/openapi.yaml');
    expect(apiDocumentUrl('<redoc spec-url="schema.json"></redoc>', 'https://example.com/api/docs'))
      .toBe('https://example.com/api/schema.json');
    expect(apiDocumentUrl('url: "/openapi.yaml"', 'https://example.com')).toBeUndefined();
    expect(apiDocumentUrl('SwaggerUIBundle({ url: "file:///secret.json" })', 'https://example.com')).toBeUndefined();
  });
  it('fetches the linked schema through the SSRF guard', async () => {
    vi.mocked(fetchGuarded).mockResolvedValue(new Response('openapi: 3.0.0\npaths: {}'));
    expect(await fetchApiDocument('https://example.com/openapi.yaml')).toContain('openapi:');
    expect(fetchGuarded).toHaveBeenCalledWith('https://example.com/openapi.yaml', { signal: expect.any(AbortSignal) });
  });
  it('rejects blocked URLs, HTTP errors, unrelated content and oversized schemas', async () => {
    vi.mocked(fetchGuarded).mockRejectedValueOnce(new Error('URL blocked (SSRF guard)'));
    await expect(fetchApiDocument('https://example.com')).rejects.toThrow('SSRF');
    vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(fetchApiDocument('https://example.com')).rejects.toThrow('403');
    vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response('<html>Sign in</html>'));
    await expect(fetchApiDocument('https://example.com')).rejects.toThrow('not an OpenAPI');
    vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(fetchApiDocument('https://example.com')).rejects.toThrow('2 MiB');
  });
});


describe('fetch_page recovery', () => {
  it('reports the linked schema source when the browser renders nothing', async () => {
    const page = {
      goto: async () => ({ serverAddr: async () => ({ ipAddress: '8.8.8.8' }) }),
      waitForLoadState: async () => {}, waitForTimeout: async () => {},
      evaluate: async () => '', content: async () => 'SwaggerUIBundle({ url: "/openapi.yaml" })',
      url: () => 'https://example.com/docs', title: async () => 'API Docs', close: vi.fn(async () => {}),
    };
    const context = { newPage: async () => page, close: vi.fn(async () => {}) };
    const tool = new WebSearchTool();
    vi.spyOn(tool as any, 'getOrCreateBrowser').mockResolvedValue({});
    vi.spyOn(tool as any, 'createBrowserContext').mockResolvedValue(context);
    vi.mocked(fetchGuarded).mockResolvedValueOnce(new Response('openapi: 3.0.0\npaths: {}'));
    const result = await (tool as any).fetchPage({ url: 'https://example.com/docs' });
    expect(result).toMatchObject({ sourceUrl: 'https://example.com/openapi.yaml', extraction: 'linked-openapi-schema', text: 'openapi: 3.0.0\npaths: {}' });
    expect(result.warning).toBeUndefined();
    expect(page.close).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
    vi.mocked(fetchGuarded).mockRejectedValueOnce(new Error('Schema unavailable'));
    const failure = await (tool as any).fetchPage({ url: 'https://example.com/docs' });
    expect(failure.warning).toContain('Schema unavailable');
    expect(failure.sourceUrl).toBeUndefined();
  });
});
