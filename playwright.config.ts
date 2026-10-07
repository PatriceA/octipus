import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the web E2E suite (`tests/web`).
 *
 * The specs drive the web app (web/) with every `/api/**` call stubbed at the
 * browser (see tests/web/fixtures/), so no backend, database, or provider keys
 * are needed — just the front-end. `webServer` builds and serves a PRODUCTION
 * bundle on :3017 and Playwright waits for it before the run. See the
 * `webServer` block below for why production, not dev.
 *
 * The unit runner excludes tests/web (see vitest.config.ts); this config is the
 * only thing that runs these specs.
 */
// Tests own their server and output directory: never rebuild the live UI.
const PORT = Number(process.env.WEB_PORT || 3017);
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
    // Build a separate production bundle, including in CI, so tests cannot
    // remove chunks referenced by tabs connected to the live server.
    command: 'npm run build && npm run start',
    env: { WEB_PORT: String(PORT), OCTIPUS_WEB_DIST_DIR: 'dist-test' },
    cwd: 'web',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
