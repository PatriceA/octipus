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
import { testTools, testToolExecution } from './tests/tools';
import { testMCP } from './tests/mcp';
import { testPipelines } from './tests/pipelines';
import { testNotifications } from './tests/notifications';
import { testHooks } from './tests/hooks';
import { testSettings } from './tests/settings';
import { testAudit } from './tests/audit';
import { testChat } from './tests/chat';
import { testExperts } from './tests/experts';
import { testRecurringTasks } from './tests/recurring-tasks';
import { testSkills } from './tests/skills';
import { testDocuments } from './tests/documents';
import { testBrowserExt } from './tests/browser-ext';
import { testMessaging } from './tests/messaging';
import { testKnowledge } from './tests/knowledge';
import { testChannels } from './tests/channels';
import { testGateway } from './tests/gateway';
import { testGatewayWS } from './tests/gateway-ws';
import { testExpertRoutingFlow } from './tests/expert-routing-flow';
import { testExpertRegistryParity } from './tests/expert-registry-parity';
import { testSwarmFlow } from './tests/swarm-flow';

export async function run() {
  const runner = new TestRunner();
  const client = new APIClient(BASE_URL);

  console.log(`\x1b[1m\x1b[36mAssistant E2E Test Suite\x1b[0m`);
  console.log(`API: ${BASE_URL}`);
  console.log(`Auth: ${fixtures.usingMasterKey ? 'MASTER_KEY' : 'register/login'}\n`);

  try {
    await testHealth(runner, client);
    await testAuth(runner, client);
    await testModels(runner, client);
    await testVault(runner, client);
    await testSessions(runner, client);
    await testAgents(runner, client);
    await testTools(runner, client);
    await testToolExecution(runner, client);
    await testMCP(runner, client);
    await testPipelines(runner, client);
    await testNotifications(runner, client);
    await testHooks(runner, client);
    await testSettings(runner, client);
    await testAudit(runner, client);
    await testExperts(runner, client);
    await testSkills(runner, client);
    await testRecurringTasks(runner, client);
    await testChat(runner, client);
    await testDocuments(runner, client);
    await testBrowserExt(runner, client);
    await testMessaging(runner, client);
    await testKnowledge(runner, client);
    await testChannels(runner, client);
    await testGateway(runner, client);
    await testGatewayWS(runner, client);
    await testExpertRoutingFlow(runner, client);
    await testExpertRegistryParity(runner, client);
    await testSwarmFlow(runner, client);
  } catch (err) {
    console.error('\n\x1b[31mTest suite crashed:\x1b[0m', (err as Error).message);
  }

  // Cleanup: stop and remove all agents spawned during tests
  if (fixtures.authToken) {
    try {
      const { data } = await client.request<{ agents: Array<{ id: string; status: string }> }>('GET', '/agents');
      if (data.agents?.length) {
        for (const agent of data.agents) {
          try {
            if (agent.status === 'running' || agent.status === 'idle') {
              await client.request('POST', `/agents/${agent.id}/stop`);
            }
            await client.request('DELETE', `/agents/${agent.id}`);
          } catch {
            // Ignore individual cleanup failures
          }
        }
        console.log(`\n\x1b[2mCleaned up ${data.agents.length} agent(s)\x1b[0m`);
      }
    } catch {
      // Ignore
    }
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

// Run directly only when this file is the entry point
if (import.meta.main) {
  run();
}
