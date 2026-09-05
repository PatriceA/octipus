import type { TestRunner } from '../runner';
import { assert } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';
import { GatewayWSClient } from '../ws-client';

/**
 * Multi-step /expert → chat flow over WebSocket.
 *
 * This is the regression test for the bug described in the task brief:
 * the gateway `/expert <name>` command used to store the active expert in
 * connection metadata only (volatile). `handleChatSend` read from that same
 * metadata, so after disconnect/reconnect the expert routing vanished.
 * The fix persists it to the session DB too; this test asserts that the
 * *session context* carries `activeExpertId` across a reconnect.
 *
 * We verify routing by reading the session's `context` from the REST API
 * rather than by inspecting the LLM response — model output is
 * non-deterministic. Session.context.activeExpertId / activeExpertName are
 * the load-bearing fields the bug was about.
 */

/**
 * How long one real chat turn may take before we call it a failure.
 *
 * These tests drive a genuine root agent turn, and the `agents` lane on a
 * normal install resolves to a CLI-backed model (`cli/claude`), which spawns a
 * process and loads its own config before it answers. A measured run of the
 * expert turn below completed in 33.5s — under the old 30s wait, so the suite
 * reported a hang for a turn that had in fact succeeded. A too-tight timeout on
 * a real-LLM test doesn't catch slowness, it just manufactures red.
 */
const CHAT_TURN_TIMEOUT_MS = 120_000;

export async function testExpertRoutingFlow(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mExpert routing flow (WS)\x1b[0m');

  if (!fixtures.authToken) {
    console.log('  \x1b[33m⊘ No auth token — skipping\x1b[0m');
    return;
  }

  // Look up the Coder expert — we need a real name that exists.
  let coderName = 'Coder';
  {
    const { status, data } = await client.request<{
      experts: Array<{ name: string; isSystem: boolean }>;
    }>('GET', '/experts');
    if (status === 200 && data.experts?.length) {
      const coder = data.experts.find(e => e.name === 'Coder');
      if (coder) coderName = coder.name;
      else coderName = data.experts[0].name; // fallback to first expert
    }
  }

  // Helper: fresh session per test
  async function newSession(): Promise<string> {
    const { status, data } = await client.request<{ id: string }>(
      'POST', '/sessions', { channelType: 'webchat', channelId: `e2e-expert-${Date.now()}` },
    );
    if (status !== 200 || !data.id) {
      throw new Error(`Could not create session (status ${status})`);
    }
    return data.id;
  }

  async function getSessionContext(sessionId: string): Promise<Record<string, unknown>> {
    const { status, data } = await client.request<{ context?: Record<string, unknown> }>(
      'GET', `/sessions/${sessionId}`,
    );
    if (status !== 200) throw new Error(`getSession failed: ${status}`);
    return data.context || {};
  }

  // ── Test 1: /expert <name> switches expert ──────────────────────
  await runner.test(`WS /expert ${coderName} sets activeExpertId on connection`, async () => {
    const sessionId = await newSession();
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      // The gateway command registry needs the session for the /expert
      // handler to persist to session DB — send a chat.send first so the
      // connection context.sessionId is populated, OR pass sessionId via the
      // command... but the CommandSchema only allows string args. The
      // command handler uses ctx.sessionId from ConnectionContext, which is
      // only set after chat.send. So we first send a no-op chat to attach
      // the session, then send the /expert command.
      //
      // Note: we rely on /expert storing activeExpertId in *both* the
      // connection metadata and the session DB. The REST-visible session
      // context is what proves DB persistence.
      // Use a trivial casual phrase so the classifier short-circuits to
      // `directResponse` and the root agent never spawns a worker.
      // "ping (attaches session to conn)" was classified as ambiguous and
      // kicked off a 4-minute general-agent run with browser-ext tool
      // attempts — the session attaches fine, but the side-effects
      // dwarfed the test budget.
      ws.send({ type: 'chat.send', sessionId, content: 'hi' });
      await ws.waitForEvent('chat.response', CHAT_TURN_TIMEOUT_MS);

      ws.send({ type: 'command', name: 'expert', args: { name: coderName } });
      const result = await ws.waitForCommandResult('expert', 10_000);
      const text = String((result as any).result || '');
      assert(
        /switched to expert|^set expert/i.test(text) || text.includes(coderName),
        `Expected switch confirmation for "${coderName}", got: ${text.slice(0, 200)}`,
      );

      const ctx = await getSessionContext(sessionId);
      assert(
        ctx.activeExpertName === coderName,
        `Expected session.context.activeExpertName="${coderName}", got ${JSON.stringify(ctx.activeExpertName)}`,
      );
      assert(
        typeof ctx.activeExpertId === 'string' && (ctx.activeExpertId as string).length > 0,
        'Expected session.context.activeExpertId to be a non-empty string',
      );
    } finally {
      ws.close();
    }
  });

  // ── Test 2: chat after /expert keeps activeExpertId ─────────────
  await runner.test('Chat after /expert preserves session.context.activeExpertId', async () => {
    const sessionId = await newSession();
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      // Attach session
      ws.send({ type: 'chat.send', sessionId, content: 'hi' });
      await ws.waitForEvent('chat.response', CHAT_TURN_TIMEOUT_MS);

      ws.send({ type: 'command', name: 'expert', args: { name: coderName } });
      await ws.waitForCommandResult('expert', 10_000);

      // Send a chat message — it should route through the expert.
      ws.send({ type: 'chat.send', sessionId, content: 'What is 2+2? One word.' });
      await ws.waitForEvent('chat.response', CHAT_TURN_TIMEOUT_MS);

      const ctx = await getSessionContext(sessionId);
      assert(
        ctx.activeExpertName === coderName,
        `After chat, expected activeExpertName="${coderName}", got ${JSON.stringify(ctx.activeExpertName)}`,
      );
    } finally {
      ws.close();
    }
  });

  // ── Test 3: /expert reset clears active expert ──────────────────
  await runner.test('WS /expert reset clears session.context.activeExpertId', async () => {
    const sessionId = await newSession();
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      ws.send({ type: 'chat.send', sessionId, content: 'hi' });
      await ws.waitForEvent('chat.response', CHAT_TURN_TIMEOUT_MS);

      ws.send({ type: 'command', name: 'expert', args: { name: coderName } });
      await ws.waitForCommandResult('expert', 10_000);

      ws.send({ type: 'command', name: 'expert', args: { name: 'reset' } });
      const resetResult = await ws.waitForCommandResult('expert', 10_000);
      const text = String((resetResult as any).result || '');
      assert(/reset|auto-rout/i.test(text), `Expected reset confirmation, got: ${text.slice(0, 200)}`);

      const ctx = await getSessionContext(sessionId);
      assert(!ctx.activeExpertId, `Expected activeExpertId to be cleared, got ${JSON.stringify(ctx.activeExpertId)}`);
      assert(!ctx.activeExpertName, `Expected activeExpertName to be cleared, got ${JSON.stringify(ctx.activeExpertName)}`);
    } finally {
      ws.close();
    }
  });

  // ── Test 4: THE REGRESSION — reconnect keeps expert routing ─────
  await runner.test('Reconnect with same sessionId preserves expert (bug regression)', async () => {
    const sessionId = await newSession();

    // First connection: /expert <name>, then disconnect.
    const ws1 = new GatewayWSClient();
    try {
      await ws1.connect();
      ws1.send({ type: 'chat.send', sessionId, content: 'hi' });
      await ws1.waitForEvent('chat.response', CHAT_TURN_TIMEOUT_MS);

      ws1.send({ type: 'command', name: 'expert', args: { name: coderName } });
      await ws1.waitForCommandResult('expert', 10_000);
    } finally {
      ws1.close();
    }

    // Give server a moment to finalize close and flush the DB write.
    await new Promise(r => setTimeout(r, 250));

    // Confirm the DB has it persisted before reconnect.
    const ctxBefore = await getSessionContext(sessionId);
    assert(
      ctxBefore.activeExpertName === coderName,
      `Pre-reconnect: expected activeExpertName="${coderName}", got ${JSON.stringify(ctxBefore.activeExpertName)}`,
    );
    const expectedExpertId = ctxBefore.activeExpertId;
    assert(typeof expectedExpertId === 'string' && expectedExpertId.length > 0, 'Missing expertId before reconnect');

    // Second connection: same sessionId, send a chat message, assert the
    // session still points to Coder after the message completes.
    const ws2 = new GatewayWSClient();
    try {
      await ws2.connect();
      ws2.send({ type: 'chat.send', sessionId, content: 'Say the word ok.' });
      await ws2.waitForEvent('chat.response', CHAT_TURN_TIMEOUT_MS);

      const ctxAfter = await getSessionContext(sessionId);
      assert(
        ctxAfter.activeExpertId === expectedExpertId,
        `Reconnect lost activeExpertId! expected ${expectedExpertId}, got ${JSON.stringify(ctxAfter.activeExpertId)}`,
      );
      assert(
        ctxAfter.activeExpertName === coderName,
        `Reconnect lost activeExpertName! expected "${coderName}", got ${JSON.stringify(ctxAfter.activeExpertName)}`,
      );
    } finally {
      ws2.close();
    }
  });
}
