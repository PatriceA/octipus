#!/usr/bin/env bun
/**
 * E2E Test Suite for the Assistant API
 *
 * Usage: bun run scripts/e2e/index.ts
 *   or:  bun run scripts/test-e2e.ts  (thin wrapper)
 *
 * Requires a running backend server. By default connects to http://localhost:3005/api.
 * Set API_URL env to override.
 */

import { TestRunner } from './runner';
import { APIClient } from './client';
import { fixtures, BASE_URL } from './fixtures';

import { testHealth } from './tests/health';
import { testAuth } from './tests/auth';
import { testModels } from './tests/models';
import { testVault } from './tests/vault';
import { testSessions } from './tests/sessions';
import { testAgents } from './tests/agents';
import { testSkills, testSkillExecution } from './tests/skills';
import { testMCP } from './tests/mcp';
import { testPipelines } from './tests/pipelines';
import { testNotifications } from './tests/notifications';
import { testHooks } from './tests/hooks';
import { testSettings } from './tests/settings';
import { testAudit } from './tests/audit';
import { testChat } from './tests/chat';

export async function run() {
  const runner = new TestRunner();
  const client = new APIClient(BASE_URL);

  console.log(`\x1b[1m\x1b[36mAssistant E2E Test Suite\x1b[0m`);
  console.log(`API: ${BASE_URL}\n`);

  try {
    await testHealth(runner, client);
    await testAuth(runner, client);
    await testModels(runner, client);
    await testVault(runner, client);
    await testSessions(runner, client);
    await testAgents(runner, client);
    await testSkills(runner, client);
    await testSkillExecution(runner, client);
    await testMCP(runner, client);
    await testPipelines(runner, client);
    await testNotifications(runner, client);
    await testHooks(runner, client);
    await testSettings(runner, client);
    await testAudit(runner, client);
    await testChat(runner, client);
  } catch (err) {
    console.error('\n\x1b[31mTest suite crashed:\x1b[0m', (err as Error).message);
  }

  // Cleanup: delete test user session (logout)
  if (fixtures.authToken) {
    try {
      await client.request('POST', '/auth/logout');
    } catch {
      // Ignore
    }
  }

  // Summary
  runner.printSummary();

  if (runner.failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Run directly if this is the entry point
run();
