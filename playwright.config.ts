import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the web E2E suite (`tests/web`).
 *
 * The specs drive the Next.js web app (web/) with every `/api/**` call stubbed
 * at the browser (see tests/web/fixtures/), so no backend, database, or
 * provider keys are needed — just the front-end. `webServer` builds and serves
 * a PRODUCTION build (`next build && next start`, or just `next start` in CI
 * where the build is a separate step) on :3007 and Playwright waits for it
 * before the run. See the `webServer` block below for why production, not dev.
 *
 * bun's unit runner ignores tests/web (see bunfig.toml `pathIgnorePatterns`);
 * this config is the only thing that runs these specs.
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
    // Production build, not `next dev`: the dev server injects a `nextjs-portal`
    // overlay element (breaks keyboard-focus assertions) and compiles routes
    // lazily (slow, flaky first hits). `next build && next start` is stable and
    // representative. In CI the build is a separate step, so `start` is instant;
    // locally the `&&` chain builds first.
    command: process.env.CI ? 'bun run start' : 'bun run build && bun run start',
    cwd: 'web',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
