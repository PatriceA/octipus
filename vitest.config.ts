import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test-runner configuration.
 *
 * Tracked deliberately. `.gitignore`'s `/*.ts` rule — there to keep ad-hoc
 * root scripts out of the tree — matched this file for its whole life, so a
 * clean clone had no path aliases and no `.md` loader and every suite failed at
 * import. CI referenced `vitest.config.ts` by name in a comment while nothing
 * tracked it, which is the "present locally, absent on the shipping path" shape
 * this repo keeps paying for.
 *
 * Two things the suite cannot run without:
 *
 * 1. **Path aliases**, mirroring `tsconfig.json#compilerOptions.paths`. They are
 *    written out rather than derived through `vite-tsconfig-paths` so the test
 *    runner gains no dependency the product does not already have.
 * 2. **The `.md` loader.** Role prompts live beside their config as markdown and
 *    are imported as strings; the bundle gets this from esbuild's text loader
 *    and Node from `scripts/md-loader.mjs`. Vite needs its own, and without it
 *    every module that reaches the role registry fails to import.
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Mirror of `scripts/md-loader.mjs` for the Vite module graph. */
const markdownAsString = {
  name: 'octipus-markdown-as-string',
  transform(_code: string, id: string) {
    if (!id.split('?')[0].endsWith('.md')) return null;
    const text = readFileSync(id.split('?')[0], 'utf8');
    return { code: `export default ${JSON.stringify(text)};`, map: null };
  },
};

export default defineConfig({
  plugins: [markdownAsString],
  resolve: {
    alias: {
      // Exact specifiers first: Vite matches aliases in order, and a trailing
      // slash prefix would not catch these two.
      '@octipus/plugin-sdk/testing': r('./plugin-sdk/testing.ts'),
      '@octipus/plugin-sdk': r('./plugin-sdk/index.ts'),
      '@/': `${r('./src')}/`,
      '@db/': `${r('./src/db')}/`,
      '@core/': `${r('./src/core')}/`,
      '@models/': `${r('./src/models')}/`,
      '@security/': `${r('./src/security')}/`,
      '@skills/': `${r('./src/skills')}/`,
      '@channels/': `${r('./src/channels')}/`,
      '@api/': `${r('./src/api')}/`,
      '@utils/': `${r('./src/utils')}/`,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Ephemeral per-process secrets, so config parses without a developer
    // exporting anything and no committed fixture resembles a real credential.
    setupFiles: ['./src/test-setup.ts'],
    // Removes the embedded-database DATA_DIRs the suite creates and does not
    // clean up — see the file for why that is centralized here.
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    // The web app has its own runner (Playwright) and its own config; including
    // it here would run React components under the Node environment.
    // `.spec.ts` as well as `.test.ts`: the tree carries both, and matching
    // only one silently skips a real suite (`src/utils/sanitize.spec.ts`).
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'web/**', 'tests/web/**'],
    // Integration suites talk to one Postgres. Isolating each file in its own
    // process is what lets them share it without cross-talk.
    isolate: true,
    testTimeout: 30_000,
    // Hooks get the same budget as tests, and for the same reason: several
    // suites boot an embedded PGlite database in `beforeAll`, which takes
    // longer than the 10s default once the full suite is competing for the
    // machine. That is the intermittent failure recorded as "not understood"
    // in docs/plans/rebuild-execution-plan.md — it reproduces only in a full
    // run, which is why it never survived being re-run alone.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // `scripts/coverage-check.ts` reads lcov; CI compares it to the committed
      // baseline. Keep both reporters — text is what a human reads locally.
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.{test,spec}.ts', 'src/test-helpers/**', 'src/test-setup.ts'],
    },
  },
});
