import { type BrowserContext, expect, type Page, test as base } from '@playwright/test';
import { stubAllDefaults } from './api-stubs';

/**
 * Authentication fixture.
 *
 * Modes:
 * - MASTER_KEY set in env → use master key as Bearer token, skip login form.
 *   Matches the pattern used by scripts/e2e/fixtures.ts.
 * - Otherwise → inject a stub token + user into localStorage and intercept
 *   /api/auth/me so the AuthProvider thinks we're logged in.
 *
 * The fixture also wires a console-error watchdog that fails the test on any
 * unhandled `pageerror` or `console.error` emitted by the page.
 *
 * Critically, the fixture installs `stubAllDefaults` + a catch-all handler
 * that returns `200 {}` for any unmocked `/api/**` path. This prevents real
 * backend 401s from triggering the app's auto-logout behavior — which would
 * otherwise redirect every test to /login.
 *
 * `unauthenticatedPage` is a sibling fixture for tests that need a fresh,
 * unauthenticated page (login, setup, etc).
 */

export const STUB_TOKEN = 'e2e-stub-token-1234';
export const STUB_USER = {
  id: 'e2e-user-id',
  username: 'e2etest',
  email: 'e2e@test.local',
  isAdmin: true,
};

const MASTER_KEY = process.env.MASTER_KEY || null;

type AuthFixtures = {
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  consoleErrors: string[];
  contextWithStorage: BrowserContext;
};

export const test = base.extend<AuthFixtures>({
  consoleErrors: async ({}, use) => {
    const errors: string[] = [];
    await use(errors);
  },

  contextWithStorage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await use(ctx);
    await ctx.close();
  },

  authenticatedPage: async ({ browser, consoleErrors }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const token = MASTER_KEY || STUB_TOKEN;

    // Seed localStorage before any script runs.
    await ctx.addInitScript(
      ({ token, user }) => {
        try {
          localStorage.setItem('auth_token', token);
          localStorage.setItem('assistant-user', JSON.stringify(user));
        } catch {
          /* SSR / no storage — ignore */
        }
      },
      { token, user: STUB_USER },
    );

    // ORDER MATTERS: Playwright matches routes in reverse registration order
    // (last registered wins). We want the catch-all to be the fallback, so it
    // must be registered FIRST — specific stubs registered after will override.
    await page.route('**/api/**', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    // Stub /api/auth/me so the AuthProvider accepts our session.
    await page.route('**/api/auth/me', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STUB_USER),
      });
    });

    // Install default stubs — these override the catch-all for specific paths.
    await stubAllDefaults(page);

    installConsoleWatchdog(page, consoleErrors);

    await use(page);
    await ctx.close();
  },

  unauthenticatedPage: async ({ browser, consoleErrors }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Catch-all 401 registered FIRST so specific routes can override.
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauth"}' }),
    );

    // Fail /api/auth/me so AuthProvider redirects us to /login.
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauth"}' }),
    );

    installConsoleWatchdog(page, consoleErrors);

    await use(page);
    await ctx.close();
  },
});

/**
 * Watchdog: collect console.error + pageerror emissions. Tests can inspect
 * the `consoleErrors` fixture and assert it's empty, or call `expectNoErrors`
 * helper below.
 *
 * Some well-known *benign* messages are allow-listed.
 */
const ERROR_ALLOWLIST: RegExp[] = [
  // Next.js 14 dev may log 404 HMR polling on disconnect
  /ChunkLoadError/,
  // React DevTools suggestion
  /Download the React DevTools/,
  // Fast refresh noise
  /\[Fast Refresh\]/,
  // Favicon 404 when devs haven't wired it
  /favicon.ico/,
  // Generic "Failed to load resource" noise — we assert explicit statuses elsewhere
  /Failed to load resource/,
  // Live-update WebSockets (permissions, notifications, …) have no backend in
  // stubbed E2E mode, so the browser logs a connection-refused error. Expected.
  /WebSocket connection to .* failed/,
];

export function installConsoleWatchdog(page: Page, bucket: string[]): void {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ERROR_ALLOWLIST.some((re) => re.test(text))) return;
    bucket.push(`[console.error] ${text}`);
  });

  page.on('pageerror', (err) => {
    bucket.push(`[pageerror] ${err.message}`);
  });
}

/**
 * Helper to assert no console errors accumulated during the test.
 * Call at the end of tests that want strict console cleanliness.
 */
export function expectNoConsoleErrors(errors: string[]): void {
  if (errors.length > 0) {
    throw new Error(`Unexpected console errors (${errors.length}):\n${errors.join('\n')}`);
  }
}

export { expect };
