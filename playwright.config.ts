import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the web E2E suite (`tests/web`).
 *
 * The specs drive the web app (web/) with every `/api/**` call stubbed at the
 * browser (see tests/web/fixtures/), so no backend, database, or provider keys
 * are needed — just the front-end. `webServer` builds and serves a PRODUCTION
 * bundle on :3007 and Playwright waits for it before the run. See the
 * `webServer` block below for why production, not dev.
 *
 * The unit runner excludes tests/web (see vitest.config.ts); this config is the
 * only thing that runs these specs.
 */
const PORT = 3007;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/web',
  // Fail the build if a spec is left `.only` in CI.
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The built bundle, not the dev server: a dev server compiles lazily (slow,
    // flaky first hits) and injects overlay elements that break keyboard-focus
    // assertions. In CI the build is a separate step, so `start` is instant;
    // locally the `&&` chain builds first.
    command: process.env.CI ? 'npm run start' : 'npm run build && npm run start',
    cwd: 'web',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
