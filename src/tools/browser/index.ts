import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';

const DEFAULT_TIMEOUT = 30000;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB

export class BrowserTool extends BaseTool {
  readonly id = 'browser';
  readonly name = 'Browser';
  readonly version = '1.0.0';
  readonly description = 'Web browser automation using Playwright';

  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'navigate', description: 'Open and navigate to URLs in a headless Playwright browser', defaultLevel: 'ASK' },
        { action: 'interact', description: 'Click buttons, fill forms, and type text on web pages via Playwright', defaultLevel: 'ASK' },
        { action: 'screenshot', description: 'Capture PNG screenshots of web pages in the headless browser', defaultLevel: 'ALLOW' },
        { action: 'execute', description: 'Run arbitrary JavaScript code in the context of the loaded web page', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'open',
      'Open a new browser page',
      createParameterSchema({
        url: { type: 'string', description: 'URL to navigate to', required: true },
        contextId: { type: 'string', description: 'Browser context ID' },
        headless: { type: 'boolean', description: 'Run headless', default: true },
      }),
      async (args) => {
        const { validateExternalUrl } = await import('@/utils/sanitize');
        const validation = await validateExternalUrl(args.url as string);
        if (!validation.valid) {
          return { error: `URL blocked: ${validation.reason}` };
        }

        const page = await this.getOrCreatePage(args.contextId as string);
        await page.goto(args.url as string, { timeout: DEFAULT_TIMEOUT });

        const pageId = this.generatePageId();
        this.pages.set(pageId, page);

        return {
          pageId,
          url: page.url(),
          title: await page.title(),
        };
      },
      { permissionAction: 'navigate' }
    );

    this.registerTool(
      'navigate',
      'Navigate to a URL on an existing page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        url: { type: 'string', description: 'URL to navigate to', required: true },
      }),
      async (args) => {
        const { validateExternalUrl } = await import('@/utils/sanitize');
        const validation = await validateExternalUrl(args.url as string);
        if (!validation.valid) {
          return { error: `URL blocked: ${validation.reason}` };
        }

        const page = this.getPage(args.pageId as string);
        await page.goto(args.url as string, { timeout: DEFAULT_TIMEOUT });

        return {
          url: page.url(),
          title: await page.title(),
        };
      },
      { permissionAction: 'navigate' }
    );

    this.registerTool(
      'click',
      'Click an element on the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'CSS selector or text', required: true },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        await page.click(args.selector as string, { timeout: DEFAULT_TIMEOUT });

        return { clicked: args.selector, url: page.url() };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'type',
      'Type text into an input field',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Input selector', required: true },
        text: { type: 'string', description: 'Text to type', required: true },
        clear: { type: 'boolean', description: 'Clear field first', default: false },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);

        if (args.clear) {
          await page.fill(args.selector as string, '');
        }

        await page.type(args.selector as string, args.text as string);

        return { typed: args.text, selector: args.selector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'screenshot',
      'Take a screenshot of the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        fullPage: { type: 'boolean', description: 'Capture full page', default: false },
        selector: { type: 'string', description: 'Element selector to screenshot' },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        let screenshot: Buffer;

        if (args.selector) {
          const element = await page.locator(args.selector as string).first();
          screenshot = await element.screenshot();
        } else {
          screenshot = await page.screenshot({ fullPage: args.fullPage as boolean });
        }

        return {
          base64: screenshot.toString('base64'),
          size: screenshot.length,
          url: page.url(),
        };
      },
      { permissionAction: 'screenshot' }
    );

    this.registerTool(
      'get_text',
      'Get text content from the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Element selector' },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);

        if (args.selector) {
          const element = await page.locator(args.selector as string).first();
          return { text: await element.textContent() };
        }

        return { text: await page.textContent('body') };
      },
      { permissionAction: 'navigate', requiresPermission: false }
    );

    this.registerTool(
      'get_html',
      'Get HTML content from the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Element selector' },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);

        if (args.selector) {
          const element = await page.locator(args.selector as string).first();
          return { html: await element.innerHTML() };
        }

        return { html: await page.content() };
      },
      { permissionAction: 'navigate', requiresPermission: false }
    );

    this.registerTool(
      'evaluate',
      'Execute JavaScript in the page context',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        script: { type: 'string', description: 'JavaScript code', required: true },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        const result = await page.evaluate(args.script as string);

        return { result };
      },
      { permissionAction: 'execute' }
    );

    this.registerTool(
      'wait_for',
      'Wait for an element or condition',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Element selector' },
        state: { type: 'string', description: 'Element state', default: 'visible', enum: ['visible', 'hidden', 'attached', 'detached'] },
        timeout: { type: 'number', description: 'Timeout in ms', default: DEFAULT_TIMEOUT },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);

        if (args.selector) {
          await page.waitForSelector(args.selector as string, {
            state: args.state as 'visible' | 'hidden' | 'attached' | 'detached',
            timeout: args.timeout as number,
          });
        }

        return { success: true };
      },
      { permissionAction: 'navigate', requiresPermission: false }
    );

    this.registerTool(
      'close',
      'Close a browser page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
      }),
      async (args) => {
        const page = this.pages.get(args.pageId as string);
        if (page) {
          await page.close();
          this.pages.delete(args.pageId as string);
        }

        return { closed: args.pageId };
      },
      { requiresPermission: false }
    );

    this.registerTool(
      'select',
      'Select an option from a dropdown',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Select element selector', required: true },
        value: { type: 'string', description: 'Option value or label', required: true },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        await page.selectOption(args.selector as string, args.value as string);

        return { selected: args.value, selector: args.selector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'scroll',
      'Scroll the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        direction: { type: 'string', description: 'Scroll direction', default: 'down', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Scroll amount in pixels', default: 500 },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        const amount = args.amount as number || 500;

        const scrollMap = {
          down: [0, amount],
          up: [0, -amount],
          right: [amount, 0],
          left: [-amount, 0],
        };

        const [x, y] = scrollMap[args.direction as keyof typeof scrollMap] || [0, amount];
        await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);

        return { scrolled: args.direction, amount };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'hover',
      'Hover over an element on the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'CSS selector to hover', required: true },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        await page.hover(args.selector as string, { timeout: DEFAULT_TIMEOUT });
        return { hovered: args.selector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'press_key',
      'Press a keyboard key on the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        key: { type: 'string', description: 'Key to press (Enter, Tab, Escape, etc.)', required: true },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        await page.keyboard.press(args.key as string);
        return { pressed: args.key };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'drag',
      'Drag an element to a target position',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        sourceSelector: { type: 'string', description: 'Source element selector', required: true },
        targetSelector: { type: 'string', description: 'Target element selector', required: true },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        await page.dragAndDrop(args.sourceSelector as string, args.targetSelector as string, { timeout: DEFAULT_TIMEOUT });
        return { dragged: args.sourceSelector, to: args.targetSelector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'pdf',
      'Generate a PDF of the current page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        format: { type: 'string', description: 'Paper format (A4, Letter, etc.)', default: 'A4' },
      }),
      async (args) => {
        const page = this.getPage(args.pageId as string);
        const buffer = await page.pdf({
          format: (args.format as string) || 'A4',
          printBackground: true,
        });
        return {
          base64: buffer.toString('base64'),
          size: buffer.length,
          url: page.url(),
        };
      },
      { permissionAction: 'screenshot' }
    );
  }

  private async getOrCreateBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      toolLogger.info('Browser launched');
    }
    return this.browser;
  }

  private async getOrCreatePage(contextId?: string): Promise<Page> {
    const browser = await this.getOrCreateBrowser();

    if (contextId && this.contexts.has(contextId)) {
      return this.contexts.get(contextId)!.newPage();
    }

    const context = await browser.newContext();
    if (contextId) {
      this.contexts.set(contextId, context);
    }

    return context.newPage();
  }

  private getPage(pageId: string): Page {
    const page = this.pages.get(pageId);
    if (!page) {
      throw new Error(`Page not found: ${pageId}`);
    }
    return page;
  }

  private generatePageId(): string {
    return `page_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  async shutdown(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch(() => {});
    }
    this.pages.clear();

    for (const context of this.contexts.values()) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      toolLogger.info('Browser closed');
    }
  }
}

export const browserTool = new BrowserTool();
