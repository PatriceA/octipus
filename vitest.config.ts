import { globSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * `.md` imported as a string, matching how `scripts/build.ts` bundles the role
 * prompts — so a suite reads exactly what ships rather than a path that only
 * exists in the source tree.
 */
function markdownAsText(): Plugin {
  return {
    name: 'octipus:markdown-as-text',
    enforce: 'pre',
    transform(_code, id) {
      if (!id.endsWith('.md')) return null;
      const text = readFileSync(id.split('?')[0], 'utf8');
      return { code: `export default ${JSON.stringify(text)};`, map: null };
    },
  };
}

/**
 * Shared settings. The two projects below differ only in how much of the suite
 * may run at once.
 */
const common = {
  setupFiles: ['./src/test-setup.ts'],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  teardownTimeout: 10_000,
  // One process per test file. The previous runner shared a process, which is
  // how a module mock in one suite leaked into another and produced tests that
  // passed alone and failed in CI. Isolation is the fix for that class.
  pool: 'forks' as const,
};

// `.spec.ts` as well as `.test.ts`: the tree carries both, and matching only
// one silently skips a real suite — `src/utils/sanitize.spec.ts` had never run.
const ALL = [
  'src/**/*.test.ts',
  'scripts/**/*.test.ts',
  // `bin/` was never scanned, so bin/octi.test.ts sat dead for the whole Node
  // migration — still importing `bun:test`, never run, and covering the CLI
  // that every install goes through.
  'bin/**/*.test.ts',
  'src/**/*.spec.ts',
  'scripts/**/*.spec.ts',
];
const NEVER = ['node_modules/**', 'dist/**', 'tests/web/**', 'web/**'];

/**
 * A test file talks to a real database if it stands up embedded PGlite or if it
 * runs against the shared Postgres under `INTEGRATION=1`. Those get a project of
 * their own with a single worker, for two separate reasons that both end in a
 * red run:
 *
 *  - Several WASM Postgres instances booting at once do not merely go slow. The
 *    runtime wedges inside a syscall where no timer can fire, so the file's own
 *    hook timeout never trips and the whole run hangs instead of failing.
 *  - The integration suites truncate shared tables. Run in parallel against one
 *    server they deadlock against each other, which reads as a product bug and
 *    is not one.
 *
 * Classified by reading the files rather than from a hand-maintained list, so a
 * new database suite lands in the right project without anyone remembering to
 * add it — the failure mode of a stale list being a hang or a deadlock, which
 * are the worst kinds of thing to leave to memory.
 */
const DATABASE_MARKERS = [
  "STORAGE_MODE = 'embedded'",
  "STORAGE_MODE='embedded'",
  "mode: 'embedded'",
  'runMigrations',
  'initializeDb',
  '@/test-helpers/integration',
  'process.env.INTEGRATION',
  'getDb(',
];

function usesDatabase(file: string): boolean {
  const source = readFileSync(file, 'utf8');
  return DATABASE_MARKERS.some((marker) => source.includes(marker));
}

const testFiles = ALL.flatMap((pattern) => globSync(pattern)).sort();
const database = testFiles.filter(usesDatabase);
const pure = testFiles.filter((f) => !database.includes(f));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [markdownAsText()],
  test: {
    // Once per run, after every file — not per file. Sweeping the shared
    // `/tmp/octipus-*` scratch from a per-file hook deletes the live scratch of
    // every worker still running.
    globalSetup: ['./src/test-helpers/tmp-cleanup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['lcov'],
      reportsDirectory: 'coverage',
      exclude: ['**/octipus-ext-*/**', '**/*.test.ts', 'node_modules/**'],
    },
    projects: [
      {
        plugins: [markdownAsText()],
        resolve: { tsconfigPaths: true },
        test: { ...common, name: 'unit', include: pure, exclude: NEVER },
      },
      {
        plugins: [markdownAsText()],
        resolve: { tsconfigPaths: true },
        test: {
          ...common,
          name: 'database',
          include: database,
          exclude: NEVER,
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
