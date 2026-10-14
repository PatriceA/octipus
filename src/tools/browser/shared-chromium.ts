import type { Browser } from 'playwright';
import { toolLogger } from '@/utils/logger';

/** A headless Chromium nobody used for this long is closed. */
export const BROWSER_IDLE_MS = 5 * 60_000;

type Launch = () => Promise<Browser>;

const defaultLaunch: Launch = async () => {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
};

/**
 * The one headless Chromium the `browser` and `websearch` tools share: a
 * process each costs hundreds of MB. Launched on first use and closed
 * `BROWSER_IDLE_MS` after the last — it used to stay up for the life of the
 * server once anything had browsed. Whoever holds page handles subscribes to
 * `onClosed` to drop them, since they die with it.
 */
export class SharedChromium {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private lastUsedAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closeListeners = new Set<() => void>();

  constructor(private readonly launch: Launch = defaultLaunch, private readonly idleMs = BROWSER_IDLE_MS) {}

  /** The browser, launched if needed; counts as a use (resets the idle clock). */
  async get(): Promise<Browser> {
    this.lastUsedAt = Date.now();
    this.armIdleTimer();
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = this.launch()
        .then((browser) => {
          browser.on('disconnected', () => {
            if (this.browser !== browser) return;
            this.browser = null;
            this.notifyClosed();
          });
          this.browser = browser;
          toolLogger.info('Headless browser launched');
          return browser;
        })
        .finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  /** The idle window, for messages. */
  get idleMinutes(): number {
    return Math.round(this.idleMs / 60_000);
  }

  /** Mark a use without needing the browser (an action on an open page). */
  touch(): void {
    this.lastUsedAt = Date.now();
  }

  /** Called when the browser goes away (idle, crash or `close`). Returns an unsubscribe. */
  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const pending = this.launching;
    const browser = this.browser ?? (pending ? await pending.catch((err: unknown) => {
      toolLogger.warn({ err }, 'Headless browser launch failed while closing');
      return null;
    }) : null);
    this.browser = null;
    if (!browser) return;
    this.notifyClosed();
    await browser.close().catch((err: unknown) => toolLogger.error({ err }, 'Closing the headless browser failed'));
    toolLogger.info('Headless browser closed');
  }

  private armIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.checkIdle(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private checkIdle(): void {
    this.idleTimer = null;
    if (!this.browser && !this.launching) return;
    const idle = Date.now() - this.lastUsedAt;
    if (idle < this.idleMs) {
      this.idleTimer = setTimeout(() => this.checkIdle(), this.idleMs - idle);
      this.idleTimer.unref?.();
      return;
    }
    toolLogger.info({ idleMs: idle }, 'Closing idle headless browser');
    void this.close();
  }

  private notifyClosed(): void {
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch (err) {
        toolLogger.error({ err }, 'Browser close listener failed');
      }
    }
  }
}

export const sharedChromium = new SharedChromium();
