#!/usr/bin/env tsx
/**
 * Integration test runner.
 *
 * 1. Starts docker-compose.test.yml (Postgres/pgvector, ephemeral).
 * 2. Runs drizzle migrations against the test database.
 * 3. Runs the suite with INTEGRATION=1 and the test DATABASE_URL so
 *    `describe.skipIf(!process.env.INTEGRATION)` blocks execute.
 * 4. Tears down docker-compose on exit, regardless of test pass/fail.
 *
 * Override the port with the TEST_POSTGRES_PORT env var.
 * Pass extra args through to the runner, e.g.:
 *   npm run test:integration -- src/db/repositories
 */
import { spawn } from 'child_process';

const TEST_POSTGRES_PORT = process.env.TEST_POSTGRES_PORT || '5443';

const DATABASE_URL = `postgres://octipus:test@localhost:${TEST_POSTGRES_PORT}/octipus_test`;

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- local test harness; args are array-form (no shell) and callers pass only hardcoded docker/node commands
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    proc.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const composeArgs = ['compose', '-f', 'docker-compose.test.yml'];
  let testExit = 1;

  try {
    console.log('\n[integration] Bringing up the test Postgres...');
    const upCode = await run('docker', [...composeArgs, 'up', '-d', '--wait'], {
      TEST_POSTGRES_PORT,
    });
    if (upCode !== 0) {
      console.error('[integration] docker compose up failed');
      process.exit(upCode);
    }

    console.log('\n[integration] Running migrations against test DB...');
    const migrateCode = await run('npx', ['tsx', '--import', './scripts/md-loader.mjs', 'scripts/migrate.ts'], {
      DATABASE_URL,
      STORAGE_MODE: 'external',
    });
    if (migrateCode !== 0) {
      console.error('[integration] migrations failed');
      testExit = migrateCode;
      return;
    }

    console.log('\n[integration] Running tests (INTEGRATION=1)...');
    // The runner's own config already excludes `tests/web` (Playwright owns
    // those). Extra args narrow the run to specific files.
    testExit = await run('npx', ['vitest', 'run', ...extraArgs], {
      INTEGRATION: '1',
      DATABASE_URL,
      STORAGE_MODE: 'external',
    });
  } finally {
    console.log('\n[integration] Tearing down test containers...');
    await run('docker', [...composeArgs, 'down', '-v'], {
      TEST_POSTGRES_PORT,
    });
    process.exit(testExit);
  }
}

main().catch((err) => {
  console.error('[integration] runner failed:', err);
  process.exit(1);
});
