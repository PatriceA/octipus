#!/usr/bin/env bun
/**
 * E2E Test Suite for the Assistant API
 *
 * Usage: bun run scripts/test-e2e.ts
 *
 * Requires a running backend server. By default connects to http://localhost:3005/api.
 * Set API_URL env to override.
 */

const API_URL = process.env.API_URL || 'http://localhost:3005/api';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];
let authToken: string | null = null;
let testUserId: string | null = null;
const testUsername = `e2e_test_${Date.now()}`;
const testPassword = 'TestP@ssw0rd!2024';

// Cleanup items to delete after tests
const cleanup: Array<() => Promise<void>> = [];

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const t = token ?? authToken;
  if (t) {
    headers['Authorization'] = `Bearer ${t}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}) as T);
  return { status: response.status, data: data as T };
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start });
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name} (${Date.now() - start}ms)\n`);
  } catch (err) {
    const error = (err as Error).message;
    results.push({ name, passed: false, error, durationMs: Date.now() - start });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}: ${error}\n`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number): void {
  assert(actual === expected, `Expected status ${expected}, got ${actual}`);
}

// ─── Health ──────────────────────────────────────────────────────
async function testHealth() {
  console.log('\n\x1b[1mHealth\x1b[0m');

  await test('GET /health returns ok', async () => {
    const { status, data } = await request<{ status: string }>('GET', '/health', undefined, '');
    assertStatus(status, 200);
    assert(data.status === 'ok', `Expected status ok, got ${data.status}`);
  });

  await test('GET /health/detailed returns services', async () => {
    const { status, data } = await request<{ status: string; health?: unknown }>('GET', '/health/detailed', undefined, '');
    assertStatus(status, 200);
    assert(!!data.status, 'Missing status field');
  });
}

// ─── Auth ────────────────────────────────────────────────────────
async function testAuth() {
  console.log('\n\x1b[1mAuthentication\x1b[0m');

  await test('POST /auth/register creates test user', async () => {
    const { status, data } = await request<{ token: string; user: { id: string } }>(
      'POST', '/auth/register', { username: testUsername, password: testPassword }, '',
    );
    assertStatus(status, 200);
    assert(!!data.token, 'No token returned');
    assert(!!data.user?.id, 'No user ID returned');
    authToken = data.token;
    testUserId = data.user.id;
  });

  await test('POST /auth/login with correct credentials', async () => {
    const { status, data } = await request<{ token: string }>(
      'POST', '/auth/login', { username: testUsername, password: testPassword }, '',
    );
    assertStatus(status, 200);
    assert(!!data.token, 'No token returned');
    authToken = data.token;
  });

  await test('POST /auth/login with wrong password fails', async () => {
    const { status, data } = await request<{ error?: string }>(
      'POST', '/auth/login', { username: testUsername, password: 'wrongpassword' }, '',
    );
    assert(status === 200 || status === 401, `Unexpected status ${status}`);
    assert(!!(data as any).error, 'Expected error response');
  });

  await test('GET /auth/me returns current user', async () => {
    const { status, data } = await request<{ username: string }>('GET', '/auth/me');
    assertStatus(status, 200);
    assert(data.username === testUsername, `Expected username ${testUsername}, got ${data.username}`);
  });
}

// ─── Models ──────────────────────────────────────────────────────
async function testModels() {
  console.log('\n\x1b[1mModels\x1b[0m');

  await test('GET /models returns model list', async () => {
    const { status, data } = await request<{ models: unknown[] }>('GET', '/models');
    assertStatus(status, 200);
    assert(Array.isArray(data.models), 'models should be an array');
  });

  await test('GET /models/providers/ollama/models handles missing ollama', async () => {
    const { status } = await request<unknown>('GET', '/models/providers/ollama/models');
    // May return 200 with empty list or 500 if ollama not running — both are valid
    assert(status === 200 || status === 500, `Unexpected status ${status}`);
  });
}

// ─── Vault ───────────────────────────────────────────────────────
async function testVault() {
  console.log('\n\x1b[1mVault\x1b[0m');
  let credentialId: string | null = null;

  await test('POST /vault creates credential', async () => {
    const { status, data } = await request<{ id: string }>(
      'POST', '/vault', { name: 'e2e_test_key', value: 'test_secret_value', credentialType: 'api_key' },
    );
    assertStatus(status, 200);
    assert(!!data.id, 'No credential ID returned');
    credentialId = data.id;
  });

  await test('GET /vault lists credentials', async () => {
    const { status, data } = await request<{ credentials: Array<{ name: string }> }>('GET', '/vault');
    assertStatus(status, 200);
    assert(Array.isArray(data.credentials), 'credentials should be an array');
    const found = data.credentials.some(c => c.name === 'e2e_test_key');
    assert(found, 'Created credential not found');
  });

  await test('DELETE /vault/:id removes credential', async () => {
    if (!credentialId) throw new Error('No credential to delete');
    const { status } = await request<unknown>('DELETE', `/vault/${credentialId}`);
    assertStatus(status, 200);
  });
}

// ─── Sessions ────────────────────────────────────────────────────
async function testSessions() {
  console.log('\n\x1b[1mSessions\x1b[0m');

  await test('GET /sessions returns session list', async () => {
    const { status, data } = await request<{ sessions: unknown[] }>('GET', '/sessions');
    assertStatus(status, 200);
    assert(Array.isArray(data.sessions), 'sessions should be an array');
  });
}

// ─── Agents ──────────────────────────────────────────────────────
async function testAgents() {
  console.log('\n\x1b[1mAgents\x1b[0m');

  await test('GET /agents returns agent list', async () => {
    const { status, data } = await request<{ agents: unknown[] }>('GET', '/agents');
    assertStatus(status, 200);
    assert(Array.isArray(data.agents), 'agents should be an array');
  });
}

// ─── Pipelines ───────────────────────────────────────────────────
async function testPipelines() {
  console.log('\n\x1b[1mPipelines\x1b[0m');
  let templateId: string | null = null;

  await test('GET /pipelines/templates returns template list', async () => {
    const { status, data } = await request<{ templates: unknown[] }>('GET', '/pipelines/templates');
    assertStatus(status, 200);
    assert(Array.isArray(data.templates), 'templates should be an array');
  });

  await test('POST /pipelines/templates creates template', async () => {
    const { status, data } = await request<{ id: string; name: string }>(
      'POST', '/pipelines/templates', {
        name: 'E2E Test Pipeline',
        description: 'Test template',
        steps: [
          { name: 'Step 1', topic: 'general' },
          { name: 'Step 2', topic: 'coding', requiresApproval: true },
        ],
      },
    );
    assertStatus(status, 200);
    assert(!!data.id, 'No template ID returned');
    templateId = data.id;
  });

  await test('PUT /pipelines/templates/:id updates template', async () => {
    if (!templateId) throw new Error('No template to update');
    const { status, data } = await request<{ id: string; name: string }>(
      'PUT', `/pipelines/templates/${templateId}`, {
        name: 'E2E Test Pipeline (Updated)',
        steps: [{ name: 'Updated Step', topic: 'analysis' }],
      },
    );
    assertStatus(status, 200);
    assert(data.name === 'E2E Test Pipeline (Updated)', 'Name not updated');
  });

  await test('DELETE /pipelines/templates/:id deletes template', async () => {
    if (!templateId) throw new Error('No template to delete');
    const { status, data } = await request<{ deleted: boolean }>(
      'DELETE', `/pipelines/templates/${templateId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Template not deleted');
  });

  await test('GET /pipelines returns pipeline runs', async () => {
    const { status, data } = await request<{ pipelines: unknown[] }>('GET', '/pipelines');
    assertStatus(status, 200);
    assert(Array.isArray(data.pipelines), 'pipelines should be an array');
  });
}

// ─── Notifications ───────────────────────────────────────────────
async function testNotifications() {
  console.log('\n\x1b[1mNotifications\x1b[0m');

  await test('GET /notifications returns notification list', async () => {
    const { status, data } = await request<{ notifications: unknown[] }>('GET', '/notifications');
    assertStatus(status, 200);
    assert(Array.isArray(data.notifications), 'notifications should be an array');
  });

  await test('POST /notifications/read-all marks all read', async () => {
    const { status } = await request<unknown>('POST', '/notifications/read-all');
    assertStatus(status, 200);
  });
}

// ─── Chat ────────────────────────────────────────────────────────
async function testChat() {
  console.log('\n\x1b[1mChat\x1b[0m');

  await test('POST /chat sends a message', async () => {
    const { status, data } = await request<{ response?: string; error?: string }>(
      'POST', '/chat', { message: 'Hello, this is an E2E test.' },
    );
    assertStatus(status, 200);
    // May return an error if no model is configured, which is fine for E2E
    assert(!!data.response || !!data.error, 'Expected response or error');
  });
}

// ─── Main ────────────────────────────────────────────────────────
async function run() {
  console.log(`\x1b[1m\x1b[36mAssistant E2E Test Suite\x1b[0m`);
  console.log(`API: ${API_URL}\n`);

  try {
    await testHealth();
    await testAuth();
    await testModels();
    await testVault();
    await testSessions();
    await testAgents();
    await testPipelines();
    await testNotifications();
    await testChat();
  } catch (err) {
    console.error('\n\x1b[31mTest suite crashed:\x1b[0m', (err as Error).message);
  }

  // Cleanup: delete test user session (logout)
  if (authToken) {
    try {
      await request('POST', '/auth/logout');
    } catch {
      // Ignore
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log('\n' + '─'.repeat(60));
  console.log(`\x1b[1mResults:\x1b[0m ${passed}/${total} passed, ${failed} failed (${totalTime}ms)`);

  if (failed > 0) {
    console.log('\n\x1b[31mFailed tests:\x1b[0m');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  } else {
    console.log('\x1b[32m\nAll tests passed!\x1b[0m');
    process.exit(0);
  }
}

run();
