import { chromium, type Browser, type Page } from 'playwright';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';

/**
 * Web search tool — tries SearXNG first, falls back to DuckDuckGo via Playwright.
 * Provides search and page fetch capabilities for research agents.
 */
export class WebSearchTool extends BaseTool {
  readonly id = 'websearch';
  readonly name = 'Web Search';
  readonly version = '2.0.0';
  readonly description = 'Search the web and fetch pages (SearXNG or browser-based)';

  private browser: Browser | null = null;
  private searxngAvailable: boolean | null = null; // null = not checked yet

  private get searxngUrl(): string {
    return process.env.SEARXNG_URL || 'http://localhost:8888';
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'search', description: 'Search the web', defaultLevel: 'ALLOW' },
        { action: 'fetch', description: 'Fetch web pages', defaultLevel: 'ALLOW' },
      ],
      tools: [
        {
          name: 'search',
          description: 'Search the web for information',
          parameters: {
            query: { type: 'string', description: 'Search query', required: true },
            max_results: { type: 'number', description: 'Max results' },
          },
          returns: 'Search results with titles, URLs, and snippets',
        },
        {
          name: 'fetch_page',
          description: 'Fetch and extract text from a URL',
          parameters: {
            url: { type: 'string', description: 'URL to fetch', required: true },
            max_length: { type: 'number', description: 'Max text length' },
          },
          returns: 'Extracted text content from the page',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'search',
      'Search the web for information. Returns a list of results with titles, URLs, and snippets.',
      createParameterSchema({
        query: { type: 'string', description: 'Search query', required: true },
        max_results: { type: 'number', description: 'Maximum results to return (default: 10)', required: false },
      }),
      async (args) => this.search(args),
      { requiresPermission: false },
    );

    this.registerTool(
      'fetch_page',
      'Fetch a web page and extract its text content. Uses a real browser for JavaScript-rendered pages.',
      createParameterSchema({
        url: { type: 'string', description: 'URL to fetch', required: true },
        max_length: { type: 'number', description: 'Maximum text length to return (default: 10000)', required: false },
      }),
      async (args) => this.fetchPage(args),
      { requiresPermission: false },
    );
  }

  /**
   * Search — tries SearXNG, falls back to DuckDuckGo via Playwright
   */
  private async search(args: Record<string, unknown>): Promise<unknown> {
    const query = args.query as string;
    const maxResults = (args.max_results as number) || 10;

    // Try SearXNG first (if we haven't already determined it's down)
    if (this.searxngAvailable !== false) {
      try {
        const result = await this.searchViaSearxng(query, maxResults);
        this.searxngAvailable = true;
        return result;
      } catch {
        this.searxngAvailable = false;
        toolLogger.info('SearXNG unavailable, falling back to browser-based search');
      }
    }

    // Fall back to DuckDuckGo via Playwright
    return this.searchViaBrowser(query, maxResults);
  }

  private async searchViaSearxng(query: string, maxResults: number): Promise<unknown> {
    const params = new URLSearchParams({
      q: query,
      categories: 'general',
      format: 'json',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${this.searxngUrl}/search?${params}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }

    const data = await response.json();
    const results = (data.results || []).slice(0, maxResults).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || '',
    }));

    return { query, resultCount: results.length, results };
  }

  private createBrowserContext(browser: Browser) {
    return browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
  }

  private async searchViaBrowser(query: string, maxResults: number): Promise<unknown> {
    // Try Google first, then DuckDuckGo as fallback
    try {
      return await this.searchViaGoogle(query, maxResults);
    } catch (error) {
      toolLogger.warn({ error: (error as Error).message, query }, 'Google search failed, trying DuckDuckGo');
    }

    try {
      return await this.searchViaDuckDuckGo(query, maxResults);
    } catch (error) {
      toolLogger.error({ error, query }, 'All browser search methods failed');
      throw new Error(`Web search failed: ${(error as Error).message}`);
    }
  }

  private async searchViaGoogle(query: string, maxResults: number): Promise<unknown> {
    const browser = await this.getOrCreateBrowser();
    const context = await this.createBrowserContext(browser);
    const page = await context.newPage();

    try {
      // Use Google's standard search
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}&hl=en`;
      await page.goto(searchUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });

      // Wait for results to be present
      await page.waitForSelector('#search', { timeout: 5000 }).catch(() => {});

      const results = await page.evaluate((max) => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];

        // Google organic results: each result is a div with a data-sokoban or a child with <a> inside #search
        const resultDivs = Array.from(document.querySelectorAll('#search .g'));

        for (const div of resultDivs) {
          if (items.length >= max) break;

          const linkEl = div.querySelector('a[href^="http"]') as HTMLAnchorElement;
          const titleEl = div.querySelector('h3');
          // Snippet is typically in a div after the link container
          const snippetParts = Array.from(div.querySelectorAll('span'))
            .filter(s => s.textContent && s.textContent.length > 40)
            .map(s => s.textContent?.trim() || '');

          if (linkEl && titleEl) {
            items.push({
              title: titleEl.textContent?.trim() || '',
              url: linkEl.href,
              snippet: snippetParts[0] || '',
            });
          }
        }

        return items;
      }, maxResults);

      if (results.length === 0) {
        throw new Error('No results extracted from Google');
      }

      toolLogger.debug({ query, resultCount: results.length, method: 'google' }, 'Search completed');
      return { query, resultCount: results.length, results, method: 'google' };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  private async searchViaDuckDuckGo(query: string, maxResults: number): Promise<unknown> {
    const browser = await this.getOrCreateBrowser();
    const context = await this.createBrowserContext(browser);
    const page = await context.newPage();

    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });

      const results = await page.evaluate((max) => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];
        const resultElements = Array.from(document.querySelectorAll('.result'));

        for (const el of resultElements) {
          if (items.length >= max) break;

          const linkEl = el.querySelector('.result__a') as HTMLAnchorElement;
          const snippetEl = el.querySelector('.result__snippet');

          if (linkEl) {
            let url = linkEl.href;
            try {
              const decoded = new URL(url);
              const uddg = decoded.searchParams.get('uddg');
              if (uddg) url = decodeURIComponent(uddg);
            } catch { /* use original */ }

            items.push({
              title: linkEl.textContent?.trim() || '',
              url,
              snippet: snippetEl?.textContent?.trim() || '',
            });
          }
        }

        return items;
      }, maxResults);

      if (results.length === 0) {
        throw new Error('No results extracted from DuckDuckGo');
      }

      toolLogger.debug({ query, resultCount: results.length, method: 'duckduckgo' }, 'Search completed');
      return { query, resultCount: results.length, results, method: 'duckduckgo' };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  /**
   * Fetch page — uses Playwright for full JS rendering
   */
  private async fetchPage(args: Record<string, unknown>): Promise<unknown> {
    const url = args.url as string;
    const maxLength = (args.max_length as number) || 10000;

    const browser = await this.getOrCreateBrowser();
    const context = await this.createBrowserContext(browser);
    const page = await context.newPage();

    try {
      await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });

      // Wait briefly for dynamic content
      await page.waitForTimeout(1000);

      // Extract text content
      const text = await page.evaluate(() => {
        // Remove unwanted elements
        const removeSelectors = ['script', 'style', 'nav', 'header', 'footer', 'iframe', '.cookie-banner', '#cookie-consent'];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach(el => el.remove());
        }

        // Try to find main content first
        const main = document.querySelector('main, article, [role="main"], .content, #content');
        const target = (main || document.body) as HTMLElement;
        return target.innerText || target.textContent || '';
      });

      const trimmedText = text
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, maxLength);

      toolLogger.debug({ url, textLength: trimmedText.length }, 'Page fetched via browser');

      return {
        url,
        title: await page.title(),
        textLength: trimmedText.length,
        text: trimmedText,
      };
    } catch (error) {
      toolLogger.error({ error, url }, 'Browser page fetch failed');
      throw new Error(`Failed to fetch page: ${(error as Error).message}`);
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  private async getOrCreateBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
      toolLogger.info('Browser launched for web search');
    }
    return this.browser;
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      toolLogger.info('Web search browser closed');
    }
  }
}

export const websearchTool = new WebSearchTool();
