import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright';
import { afterEach, expect, test, vi } from 'vitest';
import { SharedChromium } from './shared-chromium';

process.env.LOG_LEVEL ??= 'error';

afterEach(() => { vi.useRealTimers(); });

/** A stand-in browser: connected until closed, then emits `disconnected`. */
function fakeLauncher() {
  const launched: Array<Browser & { closed: boolean }> = [];
  const launch = async () => {
    const events = new EventEmitter();
    const browser = Object.assign(events, {
      closed: false,
      isConnected: () => !browser.closed,
      close: async () => { browser.closed = true; events.emit('disconnected'); },
    }) as unknown as Browser & { closed: boolean };
    launched.push(browser);
    return browser;
  };
  return { launch, launched };
}

test('one launch serves concurrent users; it closes after the idle window and relaunches on demand', async () => {
  vi.useFakeTimers();
  const { launch, launched } = fakeLauncher();
  const shared = new SharedChromium(launch, 1_000);
  const closed = vi.fn();
  shared.onClosed(closed);

  const [a, b] = await Promise.all([shared.get(), shared.get()]);
  expect(a).toBe(b);
  expect(launched).toHaveLength(1);

  // Used again before the window ends: still up.
  await vi.advanceTimersByTimeAsync(800);
  shared.touch();
  await vi.advanceTimersByTimeAsync(800);
  expect(launched[0].closed).toBe(false);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(launched[0].closed).toBe(true);
  expect(closed).toHaveBeenCalledTimes(1);

  await shared.get();
  expect(launched).toHaveLength(2);
  await shared.close();
});

test('a browser that crashes tells its users and is relaunched on the next use', async () => {
  const { launch, launched } = fakeLauncher();
  const shared = new SharedChromium(launch, 60_000);
  const closed = vi.fn();
  shared.onClosed(closed);
  await shared.get();
  launched[0].closed = true;
  (launched[0] as unknown as EventEmitter).emit('disconnected');
  expect(closed).toHaveBeenCalledTimes(1);
  await shared.get();
  expect(launched).toHaveLength(2);
  await shared.close();
});
