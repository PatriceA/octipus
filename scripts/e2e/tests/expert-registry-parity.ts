import type { TestRunner } from '../runner';
import { assert } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';
import { GatewayWSClient } from '../ws-client';

/**
 * Dual-registry parity check.
 *
 * /expert has two implementations:
 *   - src/core/commands/experts.ts   — root agent (used by REST POST /chat)
 *   - src/core/gateway/commands.ts   — gateway WS command handler
 *
 * These two must agree on behavior. This file drives the same sequence
 * through both paths and asserts response shape / DB side effects match.
 *
 * The REST `/chat` endpoint intercepts `/expert …` messages via
 * handleCommand() inside AgentService.handleMessage — so POSTing a chat
 * with content starting with "/expert" exercises the root agent registry.
 * The WS path uses `type: "command"` frames which go through the gateway
 * command registry.
 */
export async function testExpertRegistryParity(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mExpert registry parity (REST vs WS)\x1b[0m');

  if (!fixtures.authToken) {
    console.log('  \x1b[33m⊘ No auth token — skipping\x1b[0m');
    return;
  }

  // Pick a system expert that exists on both paths.
  let expertName = 'Coder';
  {
    const { data } = await client.request<{ experts: Array<{ name: string; isSystem: boolean }> }>(
      'GET', '/experts',
    );
    const coder = data.experts?.find(e => e.name === 'Coder');
    if (coder) expertName = coder.name;
    else if (data.experts?.length) expertName = data.experts[0].name;
  }

  // Track every session created during this test so we can clean up at the end.
  // Without this, sessions leak into the user's chat history (each WS path sends
  // an attach-marker chat message which then shows up as a session in the UI).
  const createdSessions: string[] = [];

  async function newSession(tag: string): Promise<string> {
    const { data } = await client.request<{ id: string }>(
      'POST', '/sessions', { channelType: 'webchat', channelId: `parity-${tag}-${Date.now()}` },
    );
    if (!data.id) throw new Error(`Could not create session (${tag})`);
    createdSessions.push(data.id);
    return data.id;
  }

  // Helpers for REST path: send a /expert command via POST /chat and return the response text.
  async function restExpert(args: string, sessionId: string): Promise<string> {
    const resp = await fetch(`${client.baseUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${fixtures.authToken}`,
      },
      body: JSON.stringify({ message: `/expert${args ? ' ' + args : ''}`, sessionId }),
    });
    const data = await resp.json() as { response?: string; error?: string };
    if (data.error) throw new Error(`REST /chat error: ${data.error}`);
    return data.response || '';
  }

  // Helpers for WS path: send a /expert command and return the command.result text.
  async function wsExpert(args: string, sessionId: string): Promise<string> {
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      // Attach the session to the connection. The gateway only binds
      // ctx.sessionId on chat.send, so we need *some* chat frame, but using a
      // visible string like "attach session" pollutes the chat history. A
      // single non-printing character keeps the binding while leaving nothing
      // human-readable behind (the session is also deleted in cleanup below).
      ws.send({ type: 'chat.send', sessionId, content: '​' });
      // A real root agent turn, and the `agents` lane commonly resolves to a
      // CLI-backed model that spawns a process before it answers — measured at
      // 33.5s, i.e. past a 30s wait. Too tight a bound on a real-LLM test
      // manufactures red rather than catching slowness.
      await ws.waitForEvent('chat.response', 120_000);

      const cmdArgs = args ? { name: args } : undefined;
      ws.send({ type: 'command', name: 'expert', args: cmdArgs });
      const frame = await ws.waitForCommandResult('expert', 10_000);
      return String((frame as any).result || '');
    } finally {
      ws.close();
    }
  }

  // ── List (no args) — both should return the same markdown shape ───
  await runner.test('Parity: /expert (list) — both produce a markdown expert list', async () => {
    const sRest = await newSession('list-rest');
    const sWs = await newSession('list-ws');
    const rest = await restExpert('', sRest);
    const ws = await wsExpert('', sWs);

    // Both must begin with "**Available experts:**"
    assert(
      rest.startsWith('**Available experts:**'),
      `REST list header mismatch. Got: ${rest.slice(0, 120)}`,
    );
    assert(
      ws.startsWith('**Available experts:**'),
      `WS list header mismatch. Got: ${ws.slice(0, 120)}`,
    );
    // Both must include the usage hint
    assert(
      rest.includes('/expert <name>') && rest.includes('/expert reset'),
      'REST list missing usage hint',
    );
    assert(
      ws.includes('/expert <name>') && ws.includes('/expert reset'),
      'WS list missing usage hint',
    );
    // Both must include the chosen expert name somewhere in the list.
    assert(rest.includes(expertName), `REST list missing expert "${expertName}"`);
    assert(ws.includes(expertName), `WS list missing expert "${expertName}"`);
  });

  // ── Switch — both should emit "Switched to expert: <name>." ───────
  await runner.test(`Parity: /expert ${expertName} — both confirm switch`, async () => {
    const sRest = await newSession('switch-rest');
    const sWs = await newSession('switch-ws');
    const rest = await restExpert(expertName, sRest);
    const ws = await wsExpert(expertName, sWs);

    const expectedPrefix = `Switched to expert: ${expertName}`;
    assert(
      rest.startsWith(expectedPrefix),
      `REST switch message mismatch. Expected "${expectedPrefix}…", got: ${rest.slice(0, 200)}`,
    );
    assert(
      ws.startsWith(expectedPrefix),
      `WS switch message mismatch. Expected "${expectedPrefix}…", got: ${ws.slice(0, 200)}`,
    );
  });

  // ── Unknown expert — both should error with same shape ────────────
  await runner.test('Parity: /expert <unknown> — both report not found', async () => {
    const sRest = await newSession('unknown-rest');
    const sWs = await newSession('unknown-ws');
    const bogus = 'NoSuchExpert_e2e_xyz_12345';
    const rest = await restExpert(bogus, sRest);
    const ws = await wsExpert(bogus, sWs);

    const expected = `Expert "${bogus}" not found`;
    assert(
      rest.includes(expected),
      `REST unknown-expert message mismatch. Expected to include "${expected}", got: ${rest.slice(0, 200)}`,
    );
    assert(
      ws.includes(expected),
      `WS unknown-expert message mismatch. Expected to include "${expected}", got: ${ws.slice(0, 200)}`,
    );
  });

  // ── Reset — both should emit "Expert reset to auto-routing." ──────
  await runner.test('Parity: /expert reset — both confirm reset and clear session', async () => {
    const sRest = await newSession('reset-rest');
    const sWs = await newSession('reset-ws');

    // First set to an expert so reset has something to clear.
    await restExpert(expertName, sRest);
    await wsExpert(expertName, sWs);

    const rest = await restExpert('reset', sRest);
    const ws = await wsExpert('reset', sWs);

    const expectedPrefix = 'Expert reset to auto-routing';
    assert(
      rest.startsWith(expectedPrefix),
      `REST reset message mismatch. Got: ${rest.slice(0, 200)}`,
    );
    assert(
      ws.startsWith(expectedPrefix),
      `WS reset message mismatch. Got: ${ws.slice(0, 200)}`,
    );

    // Both sessions should have no activeExpertId after reset.
    const { data: restSess } = await client.request<{ context?: Record<string, unknown> }>(
      'GET', `/sessions/${sRest}`,
    );
    const { data: wsSess } = await client.request<{ context?: Record<string, unknown> }>(
      'GET', `/sessions/${sWs}`,
    );
    assert(
      !restSess.context?.activeExpertId,
      `REST session still has activeExpertId: ${JSON.stringify(restSess.context?.activeExpertId)}`,
    );
    assert(
      !wsSess.context?.activeExpertId,
      `WS session still has activeExpertId: ${JSON.stringify(wsSess.context?.activeExpertId)}`,
    );
  });

  // Clean up every session created during this test run so they don't show
  // up in the user's chat history. Best-effort — individual failures are fine.
  for (const sid of createdSessions) {
    try {
      await client.request('DELETE', `/sessions/${sid}`);
    } catch {
      // Ignore — session may already be gone or DELETE not implemented.
    }
  }
}
