import type { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger';

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  quality?: number;
  format?: 'png' | 'jpeg';
  scale?: 'css' | 'device';
  timeout?: number;
}

export interface ElementInfo {
  selector: string;
  tagName: string;
  text?: string;
  attributes: Record<string, string>;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  isVisible: boolean;
  isEnabled: boolean;
}

export interface ScreenshotResult {
  image: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  url: string;
  timestamp: number;
  elements?: ElementInfo[];
}

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

/**
 * Screenshot capture service using Playwright
 */
export class ScreenshotCapture {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private browserType: BrowserType;
  private headless: boolean;
  private log = logger.child({ component: 'screenshot' });

  constructor(browserType: BrowserType = 'chromium', headless: boolean = true) {
    this.browserType = browserType;
    this.headless = headless;
  }

  /**
   * Initialize browser
   */
  async init(): Promise<void> {
    if (this.browser) return;

    const pw = await import('playwright');
    const launcher = this.browserType === 'firefox'
      ? pw.firefox
      : this.browserType === 'webkit'
        ? pw.webkit
        : pw.chromium;

    this.browser = await launcher.launch({
      headless: this.headless,
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });

    this.page = await this.context.newPage();
    this.log.info({ browserType: this.browserType }, 'Browser initialized');
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle'): Promise<void> {
    if (!this.page) await this.init();

    await this.page!.goto(url, { waitUntil });
    this.log.debug({ url }, 'Navigated to URL');
  }

  /**
   * Capture screenshot
   */
  async capture(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    if (!this.page) await this.init();

    const {
      fullPage = false,
      selector,
      quality = 80,
      format = 'png',
      timeout = 30000,
    } = options;

    let image: Buffer;

    if (selector) {
      const element = await this.page!.waitForSelector(selector, { timeout });
      image = await element!.screenshot({
        type: format,
        quality: format === 'jpeg' ? quality : undefined,
      });
    } else {
      image = await this.page!.screenshot({
        fullPage,
        type: format,
        quality: format === 'jpeg' ? quality : undefined,
      });
    }

    const viewport = this.page!.viewportSize();

    return {
      image,
      format,
      width: viewport?.width || 1920,
      height: viewport?.height || 1080,
      url: this.page!.url(),
      timestamp: Date.now(),
    };
  }

  /**
   * Capture screenshot with element information
   */
  async captureWithElements(
    options: ScreenshotOptions = {},
    elementSelectors?: string[]
  ): Promise<ScreenshotResult> {
    const result = await this.capture(options);

    // Extract element information
    const elements: ElementInfo[] = [];

    const selectors = elementSelectors || [
      'button',
      'a',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[onclick]',
    ];

    for (const selector of selectors) {
      const els = await this.page!.$$(selector);

      for (const el of els) {
        try {
          const tagName = await el.evaluate((e) => e.tagName.toLowerCase());
          const text = await el.textContent();
          const boundingBox = await el.boundingBox();
          const isVisible = await el.isVisible();
          const isEnabled = await el.isEnabled();

          const attributes: Record<string, string> = await el.evaluate((e) => {
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(e.attributes)) {
              attrs[attr.name] = attr.value;
            }
            return attrs;
          });

          // Generate unique selector
          const uniqueSelector = await el.evaluate((e) => {
            if (e.id) return `#${e.id}`;
            if (e.className) {
              const classes = e.className.split(' ').filter(Boolean).slice(0, 2).join('.');
              if (classes) return `${e.tagName.toLowerCase()}.${classes}`;
            }
            return e.tagName.toLowerCase();
          });

          elements.push({
            selector: uniqueSelector,
            tagName,
            text: text?.trim().substring(0, 100) || undefined,
            attributes,
            boundingBox,
            isVisible,
            isEnabled,
          });
        } catch {
          // Element may have been removed
        }
      }
    }

    result.elements = elements;
    return result;
  }

  /**
   * Execute JavaScript in page
   */
  async evaluate<T>(script: string | (() => T)): Promise<T> {
    if (!this.page) await this.init();
    return this.page!.evaluate(script);
  }

  /**
   * Click element
   */
  async click(selector: string): Promise<void> {
    if (!this.page) await this.init();
    await this.page!.click(selector);
    this.log.debug({ selector }, 'Clicked element');
  }

  /**
   * Type text
   */
  async type(selector: string, text: string): Promise<void> {
    if (!this.page) await this.init();
    await this.page!.fill(selector, text);
    this.log.debug({ selector, textLength: text.length }, 'Typed text');
  }

  /**
   * Get page content
   */
  async getContent(): Promise<string> {
    if (!this.page) await this.init();
    return this.page!.content();
  }

  /**
   * Get current URL
   */
  getUrl(): string {
    return this.page?.url() || '';
  }

  /**
   * Set viewport size
   */
  async setViewport(width: number, height: number): Promise<void> {
    if (!this.page) await this.init();
    await this.page!.setViewportSize({ width, height });
  }

  /**
   * Wait for element
   */
  async waitForSelector(selector: string, timeout: number = 30000): Promise<void> {
    if (!this.page) await this.init();
    await this.page!.waitForSelector(selector, { timeout });
  }

  /**
   * Wait for navigation
   */
  async waitForNavigation(timeout: number = 30000): Promise<void> {
    if (!this.page) await this.init();
    await this.page!.waitForLoadState('networkidle', { timeout });
  }

  /**
   * Clean up
   */
  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.log.info('Browser closed');
  }
}
