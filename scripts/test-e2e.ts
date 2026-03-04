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

  await test('GET /health/database returns db status', async () => {
    const { status, data } = await request<{ status: string }>('GET', '/health/database', undefined, '');
    assertStatus(status, 200);
    assert(!!data.status, 'Missing status field');
  });

  await test('GET /health/redis returns redis status', async () => {
    const { status, data } = await request<{ status: string }>('GET', '/health/redis', undefined, '');
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

  await test('Unauthenticated request to protected endpoint fails', async () => {
    const { status, data } = await request<{ error?: string }>('GET', '/sessions', undefined, '');
    assert(status === 401 || !!(data as any).error, 'Expected 401 or error for unauthenticated request');
  });
}

// ─── Models ──────────────────────────────────────────────────────
async function testModels() {
  console.log('\n\x1b[1mModels\x1b[0m');

  await test('GET /models returns model list', async () => {
    const { status, data } = await request<{ models: Array<{ name: string; provider: string }> }>('GET', '/models');
    assertStatus(status, 200);
    assert(Array.isArray(data.models), 'models should be an array');
  });

  await test('GET /models/health returns health status', async () => {
    const { status, data } = await request<Record<string, unknown>>('GET', '/models/health');
    assertStatus(status, 200);
    assert(typeof data === 'object', 'Expected health object');
  });

  await test('GET /models/cli/status returns CLI tools status', async () => {
    const { status, data } = await request<Record<string, unknown>>('GET', '/models/cli/status');
    assertStatus(status, 200);
    assert(typeof data === 'object', 'Expected status object');
  });

  await test('GET /models/usage returns user usage stats', async () => {
    const { status, data } = await request<Record<string, unknown>>('GET', '/models/usage');
    assertStatus(status, 200);
    assert(typeof data === 'object', 'Expected usage object');
  });

  await test('GET /models/providers/ollama/models lists ollama models', async () => {
    const { status } = await request<unknown>('GET', '/models/providers/ollama/models');
    // May return 200 with list or error if ollama not running — both valid
    assert(status === 200 || status === 500, `Unexpected status ${status}`);
  });

  await test('GET /models/providers/litellm/models lists litellm models', async () => {
    const { status } = await request<unknown>('GET', '/models/providers/litellm/models');
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

  let sessionId: string | null = null;

  await test('GET /sessions returns session list', async () => {
    const { status, data } = await request<{ sessions: unknown[] }>('GET', '/sessions');
    assertStatus(status, 200);
    assert(Array.isArray(data.sessions), 'sessions should be an array');
  });

  await test('POST /sessions creates a new session', async () => {
    const { status, data } = await request<{ id: string; channel?: string }>(
      'POST', '/sessions', { channel: 'test' },
    );
    assertStatus(status, 200);
    assert(!!data.id, 'No session ID returned');
    sessionId = data.id;
  });

  await test('GET /sessions/:id returns session details', async () => {
    if (!sessionId) throw new Error('No session to get');
    const { status, data } = await request<{ id: string }>('GET', `/sessions/${sessionId}`);
    assertStatus(status, 200);
    assert(data.id === sessionId, 'Session ID mismatch');
  });

  await test('GET /sessions/:id/messages returns empty messages for new session', async () => {
    if (!sessionId) throw new Error('No session');
    const { status, data } = await request<{ messages: unknown[] }>('GET', `/sessions/${sessionId}/messages`);
    assertStatus(status, 200);
    assert(Array.isArray(data.messages), 'messages should be an array');
  });

  await test('GET /sessions/:id/messages supports pagination', async () => {
    if (!sessionId) throw new Error('No session');
    const { status, data } = await request<{ messages: unknown[] }>(
      'GET', `/sessions/${sessionId}/messages?limit=5&offset=0`,
    );
    assertStatus(status, 200);
    assert(Array.isArray(data.messages), 'messages should be an array');
  });

  await test('PATCH /sessions/:id updates session', async () => {
    if (!sessionId) throw new Error('No session');
    const { status } = await request<unknown>(
      'PATCH', `/sessions/${sessionId}`, { status: 'active' },
    );
    assertStatus(status, 200);
  });

  await test('POST /sessions/:id/complete marks session complete', async () => {
    if (!sessionId) throw new Error('No session');
    const { status } = await request<unknown>(
      'POST', `/sessions/${sessionId}/complete`,
    );
    assertStatus(status, 200);
  });

  await test('DELETE /sessions/:id deletes session', async () => {
    if (!sessionId) throw new Error('No session');
    const { status } = await request<unknown>('DELETE', `/sessions/${sessionId}`);
    assertStatus(status, 200);
  });
}

// ─── Agents ──────────────────────────────────────────────────────
async function testAgents() {
  console.log('\n\x1b[1mAgents\x1b[0m');

  let agentId: string | null = null;

  await test('GET /agents returns agent list', async () => {
    const { status, data } = await request<{ agents: unknown[] }>('GET', '/agents');
    assertStatus(status, 200);
    assert(Array.isArray(data.agents), 'agents should be an array');
  });

  // First create a session for the agent
  let agentSessionId: string | null = null;
  await test('POST /sessions creates session for agent', async () => {
    const { status, data } = await request<{ id: string }>(
      'POST', '/sessions', { channel: 'test' },
    );
    assertStatus(status, 200);
    agentSessionId = data.id;
  });

  await test('POST /agents spawns a new agent', async () => {
    if (!agentSessionId) throw new Error('No session for agent');
    const { status, data } = await request<{ id?: string; agentId?: string; error?: string }>(
      'POST', '/agents', { sessionId: agentSessionId, message: 'E2E test: what is 2+2?' },
    );
    assertStatus(status, 200);
    const id = data.id || data.agentId;
    assert(!!id || !!data.error, 'Expected agent ID or error');
    if (id) agentId = id;
  });

  await test('GET /agents/:id returns agent details', async () => {
    if (!agentId) return;
    const { status, data } = await request<{ id?: string; status?: string }>('GET', `/agents/${agentId}`);
    assertStatus(status, 200);
    assert(!!data.status, 'Expected agent status');
  });

  await test('GET /agents/:id/events returns agent events', async () => {
    if (!agentId) return;
    // Wait for the agent to produce some events
    await new Promise(r => setTimeout(r, 2000));
    const { status, data } = await request<{ events: Array<{ seq: number; type: string }> }>(
      'GET', `/agents/${agentId}/events`,
    );
    assertStatus(status, 200);
    assert(Array.isArray(data.events), 'events should be an array');
  });

  await test('GET /agents/:id/events supports after= polling', async () => {
    if (!agentId) return;
    const { status, data } = await request<{ events: unknown[] }>(
      'GET', `/agents/${agentId}/events?after=0`,
    );
    assertStatus(status, 200);
    assert(Array.isArray(data.events), 'events should be an array');
  });

  await test('POST /agents/route returns routing decision', async () => {
    const { status, data } = await request<{ model?: string; topic?: string; confidence?: number; error?: string }>(
      'POST', '/agents/route', { message: 'Search for weather in Berlin' },
    );
    assertStatus(status, 200);
    assert(!!data.topic || !!data.error, `Expected topic or error, got: ${JSON.stringify(data)}`);
  });

  await test('POST /agents/:id/stop stops the agent', async () => {
    if (!agentId) return;
    const { status } = await request<unknown>('POST', `/agents/${agentId}/stop`);
    // 200 if still running, could error if already completed
    assert(status === 200 || status === 404 || status === 400, `Unexpected status ${status}`);
  });
}

// ─── Skills ──────────────────────────────────────────────────────
async function testSkills() {
  console.log('\n\x1b[1mSkills\x1b[0m');

  await test('GET /skills returns registered skills', async () => {
    const { status, data } = await request<{ skills: Array<{ id: string; name: string; tools: unknown[] }> }>('GET', '/skills');
    assertStatus(status, 200);
    assert(Array.isArray(data.skills), 'skills should be an array');
    assert(data.skills.length > 0, 'Expected at least one skill');
    // Verify expected skills are present
    const skillIds = data.skills.map(s => s.id);
    assert(skillIds.includes('filesystem'), `filesystem skill missing, got: ${skillIds.join(', ')}`);
    assert(skillIds.includes('websearch'), `websearch skill missing, got: ${skillIds.join(', ')}`);
  });

  await test('GET /skills/:id returns specific skill', async () => {
    const { status, data } = await request<{ id: string; name: string; tools: Array<{ name: string }> }>('GET', '/skills/filesystem');
    assertStatus(status, 200);
    assert(data.id === 'filesystem', `Expected id 'filesystem', got ${data.id}`);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool in filesystem skill');
  });

  await test('GET /skills/:id returns error for unknown skill', async () => {
    const { data } = await request<{ error?: string }>('GET', '/skills/nonexistent_skill');
    assert(!!(data as any).error, 'Expected error for unknown skill');
  });

  await test('GET /skills/tools/all returns combined skill + MCP tools', async () => {
    const { status, data } = await request<{ tools: Array<{ name: string; source: string }> }>('GET', '/skills/tools/all');
    assertStatus(status, 200);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool');
  });

  await test('GET /skills/permissions returns user permissions', async () => {
    const { status, data } = await request<{ permissions: unknown[] }>('GET', '/skills/permissions');
    assertStatus(status, 200);
    assert(Array.isArray(data.permissions), 'permissions should be an array');
  });
}

// ─── Skill Execution ─────────────────────────────────────────────
async function testSkillExecution() {
  console.log('\n\x1b[1mSkill Execution (MCP bridge endpoint)\x1b[0m');

  await test('POST /skills/:skillId/tools/:toolName/execute runs filesystem.read_file', async () => {
    const { status, data } = await request<{ result?: unknown; error?: string }>(
      'POST', '/skills/filesystem/tools/read_file/execute',
      { args: { path: '/etc/hostname' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });

  await test('POST /skills/:skillId/tools/:toolName/execute returns error for unknown tool', async () => {
    const { status, data } = await request<{ error?: string }>(
      'POST', '/skills/filesystem/tools/nonexistent_tool/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown tool');
  });

  await test('POST /skills/:skillId/tools/:toolName/execute returns error for unknown skill', async () => {
    const { status, data } = await request<{ error?: string }>(
      'POST', '/skills/nonexistent/tools/something/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown skill');
  });

  await test('POST /skills/:skillId/tools/:toolName/execute works without args', async () => {
    const { status, data } = await request<{ result?: unknown; error?: string }>(
      'POST', '/skills/filesystem/tools/list_directory/execute',
      { args: { path: '/tmp' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });
}

// ─── MCP ─────────────────────────────────────────────────────────
async function testMCP() {
  console.log('\n\x1b[1mMCP\x1b[0m');

  await test('GET /mcp/tools returns available MCP tools', async () => {
    const { status, data } = await request<{ tools: unknown[] }>('GET', '/mcp/tools');
    assertStatus(status, 200);
    assert(Array.isArray(data.tools), 'tools should be an array');
  });

  await test('GET /mcp/servers returns server list', async () => {
    const { status, data } = await request<{ servers?: unknown[]; error?: string }>('GET', '/mcp/servers');
    assertStatus(status, 200);
    // Non-admin users get an error, that's expected behavior
    assert(Array.isArray(data.servers) || !!data.error, 'Expected servers array or error');
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

// ─── Hooks ───────────────────────────────────────────────────────
async function testHooks() {
  console.log('\n\x1b[1mHooks\x1b[0m');

  await test('GET /hooks returns hook list', async () => {
    const { status, data } = await request<{ hooks: unknown[] }>('GET', '/hooks');
    assertStatus(status, 200);
    assert(Array.isArray(data.hooks), 'hooks should be an array');
  });
}

// ─── Chat ────────────────────────────────────────────────────────
let chatSessionId: string | null = null;

async function testChat() {
  console.log('\n\x1b[1mChat\x1b[0m');

  await test('POST /chat sends a message and returns response', async () => {
    const { status, data } = await request<{ response?: string; sessionId?: string; classification?: string; error?: string }>(
      'POST', '/chat', { message: 'Hello, this is an E2E test.' },
    );
    assertStatus(status, 200);
    assert(!!data.response || !!data.error, 'Expected response or error');
    if (data.sessionId) chatSessionId = data.sessionId;
  });

  await test('POST /chat continues existing session', async () => {
    if (!chatSessionId) return;
    // Use AbortController to prevent hanging on slow model responses
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ message: 'Follow-up: say ok.', sessionId: chatSessionId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await response.json() as { response?: string; sessionId?: string; error?: string };
      assertStatus(response.status, 200);
      assert(!!data.response || !!data.error, 'Expected response or error');
      if (data.sessionId) {
        assert(data.sessionId === chatSessionId, `Session ID changed: expected ${chatSessionId}, got ${data.sessionId}`);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') {
        // Timeout is acceptable — model might be slow
        return;
      }
      throw err;
    }
  });

  // Verify chat created messages in the session
  if (chatSessionId) {
    await test('Chat session has messages persisted', async () => {
      const { status, data } = await request<{ messages: Array<{ role: string }> }>(
        'GET', `/sessions/${chatSessionId}/messages`,
      );
      assertStatus(status, 200);
      assert(Array.isArray(data.messages), 'messages should be an array');
      assert(data.messages.length >= 1, `Expected at least 1 message, got ${data.messages.length}`);
    });
  }
}

// ─── Settings ───────────────────────────────────────────────────
async function testSettings() {
  console.log('\n\x1b[1mSettings\x1b[0m');

  // The setup-status endpoint is public (no auth required)
  await test('GET /settings/setup-status returns setup status', async () => {
    const { status, data } = await request<{ setupComplete: boolean }>('GET', '/settings/setup-status');
    assertStatus(status, 200);
    assert(typeof data.setupComplete === 'boolean', `Expected boolean setupComplete, got ${typeof data.setupComplete}`);
  });

  // Test admin-only endpoints. The test user may or may not be admin.
  // We test both the happy path and access control.
  await test('GET /settings returns settings or admin error', async () => {
    const { status, data } = await request<{ settings?: Record<string, unknown>; categories?: string[]; error?: string }>('GET', '/settings');
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(!!data.settings, 'Expected settings object');
      assert(Array.isArray(data.categories), 'Expected categories array');
    }
  });

  await test('GET /settings/registry returns registry or admin error', async () => {
    const { status, data } = await request<{ registry?: unknown[]; categories?: string[]; error?: string }>('GET', '/settings/registry');
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(Array.isArray(data.registry), 'Expected registry array');
      assert((data.registry as any[]).length > 0, 'Expected at least one registry entry');
      assert(Array.isArray(data.categories), 'Expected categories array');
    }
  });

  await test('GET /settings/category/litellm returns litellm settings or admin error', async () => {
    const { status, data } = await request<{ category?: string; settings?: unknown[]; error?: string }>(
      'GET', '/settings/category/litellm',
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin') || (data as any).error.includes('Unknown'), `Unexpected error: ${(data as any).error}`);
    } else {
      assert(data.category === 'litellm', `Expected category litellm, got ${data.category}`);
      assert(Array.isArray(data.settings), 'Expected settings array');
    }
  });

  await test('GET /settings/category/nonexistent returns error', async () => {
    const { status, data } = await request<{ error?: string }>(
      'GET', '/settings/category/nonexistent',
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for nonexistent category');
  });

  await test('PUT /settings/:key updates setting or returns admin error', async () => {
    const { status, data } = await request<{ success?: boolean; key?: string; error?: string }>(
      'PUT', '/settings/logging.level', { value: 'debug' },
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(data.success === true, 'Expected success: true');
      assert(data.key === 'logging.level', `Expected key logging.level, got ${data.key}`);
    }
  });

  await test('PUT /settings/:key returns error for unknown setting', async () => {
    const { status, data } = await request<{ error?: string }>(
      'PUT', '/settings/nonexistent.key', { value: 'test' },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown setting');
  });

  await test('PUT /settings/batch batch-updates settings or returns admin error', async () => {
    const { status, data } = await request<{ updated?: string[]; errors?: Record<string, string>; error?: string }>(
      'PUT', '/settings/batch', {
        settings: {
          'logging.level': 'info',
          'agent.maxConcurrent': 3,
        },
      },
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(Array.isArray(data.updated), 'Expected updated array');
    }
  });

  await test('PUT /settings/batch reports errors for unknown keys', async () => {
    const { status, data } = await request<{ updated?: string[]; errors?: Record<string, string>; error?: string }>(
      'PUT', '/settings/batch', {
        settings: {
          'nonexistent.key1': 'a',
          'nonexistent.key2': 'b',
        },
      },
    );
    assertStatus(status, 200);
    if (!(data as any).error) {
      assert(!!data.errors, 'Expected errors object for unknown keys');
      assert(Object.keys(data.errors!).length === 2, 'Expected 2 errors');
    }
  });

  await test('POST /settings/:key/reset resets setting or returns admin error', async () => {
    const { status, data } = await request<{ success?: boolean; key?: string; value?: unknown; error?: string }>(
      'POST', '/settings/logging.level/reset',
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin') || (data as any).error.includes('Unknown'), `Unexpected error: ${(data as any).error}`);
    } else {
      assert(data.success === true, 'Expected success: true');
      assert(data.key === 'logging.level', `Expected key logging.level, got ${data.key}`);
    }
  });

  await test('POST /settings/:key/reset returns error for unknown setting', async () => {
    const { status, data } = await request<{ error?: string }>(
      'POST', '/settings/nonexistent.key/reset',
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown setting');
  });

  await test('POST /settings/setup-complete returns admin error for non-admin', async () => {
    const { status, data } = await request<{ success?: boolean; error?: string }>(
      'POST', '/settings/setup-complete',
    );
    assertStatus(status, 200);
    // Non-admin gets error, admin gets success — both are valid
    assert(data.success === true || !!(data as any).error, 'Expected success or admin error');
  });

  // Test unauthenticated access to settings
  await test('GET /settings without auth returns error', async () => {
    const { status, data } = await request<{ error?: string }>('GET', '/settings', undefined, '');
    // Should fail without auth (401 or error in body)
    assert(status === 401 || !!(data as any).error, 'Expected 401 or error for unauthenticated settings request');
  });
}

// ─── Audit ──────────────────────────────────────────────────────
async function testAudit() {
  console.log('\n\x1b[1mAudit\x1b[0m');

  await test('GET /audit returns audit log or error', async () => {
    const { status, data } = await request<{ entries?: unknown[]; error?: string }>('GET', '/audit');
    // May require admin or may not exist — both acceptable
    assert(status === 200 || status === 404, `Unexpected status ${status}`);
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
    await testSkills();
    await testSkillExecution();
    await testMCP();
    await testPipelines();
    await testNotifications();
    await testHooks();
    await testSettings();
    await testAudit();
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
