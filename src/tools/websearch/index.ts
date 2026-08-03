import type { Browser, } from 'playwright';
import type { ToolManifest } from '@/core/types';
import { coreLogger, toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Web search tool — tries SearXNG first, falls back to DuckDuckGo via Playwright.
 * Provides search and page fetch capabilities for research agents.
 */
/**
 * Build the SearXNG query string.
 *
 * `categories` and `engines` do NOT compose the way they look like they do:
 * SearXNG treats them as a UNION, so `categories=general&engines=bing` runs
 * bing *plus* every other general-category engine. Measured: that combination
 * returns 30 results (10 bing + 20 google cse) where `engines=bing` alone
 * returns 10. An allowlist sent alongside `categories` is therefore not an
 * allowlist at all — it can only add engines, never restrict to them, which is
 * the exact opposite of why an operator would set one.
 *
 * So when an allowlist is configured we send `engines` ALONE. Otherwise we
 * send `categories` alone and let the instance choose.
 */
export function buildSearxngParams(query: string, engines: string | null): URLSearchParams {
  const params = new URLSearchParams({ q: query, format: 'json' });
  if (engines) params.set('engines', engines);
  else params.set('categories', 'general');
  return params;
}

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

  /**
   * Optional comma-separated engine allowlist, e.g. `SEARXNG_ENGINES=google`.
   * Unset (the default) leaves engine selection to the SearXNG instance.
   *
   * This exists because engine health varies wildly and fails in two very
   * different ways. Measured 2026-08-03 on a stock instance: duckduckgo,
   * brave and startpage were all CAPTCHA'd or rate-limited (they fail loudly,
   * which the caller can see), while bing returned ten confident, well-formed
   * results that had nothing to do with the query — `zzzqqq Berchtesgaden`
   * came back with furniture shops. A silently-wrong engine is far more
   * dangerous to an agent than a dead one, and no amount of code here can
   * detect it, so the operator needs a way to pin the engines they trust.
   */
  private get searxngEngines(): string | null {
    const raw = (process.env.SEARXNG_ENGINES || '').trim();
    return raw.length > 0 ? raw : null;
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'search', description: 'Search the web via SearXNG or DuckDuckGo/Google and return result titles, URLs, and snippets', defaultLevel: 'ALLOW' },
        { action: 'fetch', description: 'Fetch and extract text content from web pages using a headless browser', defaultLevel: 'ALLOW' },
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
    const params = buildSearxngParams(query, this.searxngEngines);

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

    // Distinguish "genuinely no results" from "the engines are dead". A dead
    // SearXNG returns HTTP 200 with 0 results AND a populated
    // `unresponsive_engines` list (network/DNS down inside the container). That
    // is an infra failure, not an answer — throw so the browser fallback in
    // `search()` engages. Reporting it as an empty-but-ok result is exactly the
    // silent failure that let a small model confabulate "my tools are disabled".
    const unresponsive = (data.unresponsive_engines || []) as unknown[];
    if (results.length === 0 && unresponsive.length > 0) {
      throw new Error(
        `SearXNG returned no results and ${unresponsive.length} engine(s) are unresponsive — treating as infra failure`,
      );
    }

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
      await page.waitForSelector('#search', { timeout: 5000 }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));

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
      await page.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
      await context.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
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
      await page.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
      await context.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
    }
  }

  /**
   * Fetch page — uses Playwright for full JS rendering
   */
  private async fetchPage(args: Record<string, unknown>): Promise<unknown> {
    const url = args.url as string;
    const maxLength = (args.max_length as number) || 10000;

    const { validateExternalUrl, assertPublicAddress } = await import('@/utils/sanitize');
    const validation = await validateExternalUrl(url);
    if (!validation.valid) {
      return { error: `URL blocked: ${validation.reason}` };
    }

    const browser = await this.getOrCreateBrowser();
    const context = await this.createBrowserContext(browser);
    const page = await context.newPage();

    try {
      const response = await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });

      // Post-connect SSRF check: reject a rebind to a private IP that happened
      // between validation and this navigation (Playwright can't be IP-pinned).
      const addrCheck = assertPublicAddress((await response?.serverAddr())?.ipAddress);
      if (!addrCheck.ok) {
        return { error: `URL blocked: ${addrCheck.reason}` };
      }

      // Let JS-heavy SPAs (fifa.com, most modern sites) actually render. A fixed
      // 1s timeout returned empty bodies as silent "ok" successes. `networkidle`
      // returns as soon as the network settles; the 3s cap bounds the tax on
      // pages that never idle (streaming/analytics/websockets) — waiting longer
      // there rarely changes the extracted text, but multiplies across a fan-out.
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);

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

      const title = await page.title();

      // Surface renders-nothing and bot-wall pages as warnings, not silent
      // successes. An empty body or a "verify you're human / enable JavaScript"
      // interstitial is NOT evidence the information is absent — a small model
      // reading `text: ""` with `status: ok` will conclude exactly that and
      // fabricate a reason. Name the failure so it can't be mistaken for data.
      // Only treat interstitial signatures as a bot-wall when the page has
      // little real content — a long article that merely mentions "captcha" or
      // "cloudflare" is legitimate content, not a wall. Interstitials are short.
      const botWall = trimmedText.length < 800
        && /enable javascript|verify (you'?re|that you'?re|you are).*(human|robot)|are you a robot|complete the captcha|access denied|just a moment/i.test(text.slice(0, 2000));
      let warning: string | undefined;
      if (trimmedText.length === 0) {
        warning = 'Page rendered no extractable text (JS-heavy SPA, empty render, or bot-wall). This is NOT confirmation the information is absent — try another source.';
      } else if (botWall) {
        warning = 'Page looks like a bot-wall / CAPTCHA / "enable JavaScript" interstitial, not real content — treat this text as unreliable and try another source.';
      }

      toolLogger.debug({ url, textLength: trimmedText.length, warning }, 'Page fetched via browser');

      return {
        url,
        title,
        textLength: trimmedText.length,
        text: trimmedText,
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      toolLogger.error({ error, url }, 'Browser page fetch failed');
      throw new Error(`Failed to fetch page: ${(error as Error).message}`);
    } finally {
      await page.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
      await context.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
    }
  }

  private async getOrCreateBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless: true });
      toolLogger.info('Browser launched for web search');
    }
    return this.browser;
  }

  override async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
      this.browser = null;
      toolLogger.info('Web search browser closed');
    }
  }
}

export const websearchTool = new WebSearchTool();
