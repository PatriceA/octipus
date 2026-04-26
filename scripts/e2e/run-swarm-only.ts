#!/usr/bin/env bun
import { TestRunner } from './runner';
import { APIClient } from './client';
import { fixtures, BASE_URL } from './fixtures';
import { testSwarmFlow } from './tests/swarm-flow';

const runner = new TestRunner();
const client = new APIClient(BASE_URL);

console.log(`\x1b[1m\x1b[36mAssistant E2E — Swarm Only\x1b[0m`);
console.log(`API: ${BASE_URL}`);
console.log(`Auth: ${fixtures.usingMasterKey ? 'MASTER_KEY' : 'register/login'}\n`);

try {
  await testSwarmFlow(runner, client);
} catch (err) {
  console.error('\n\x1b[31mTest crashed:\x1b[0m', (err as Error).message);
}

runner.printSummary();
process.exit(runner.failed > 0 ? 1 : 0);
