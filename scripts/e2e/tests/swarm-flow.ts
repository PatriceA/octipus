import type { APIClient } from '../client';
import { fixtures } from '../fixtures';
import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import { GatewayWSClient, type WsFrame } from '../ws-client';

/**
 * Swarm-flow E2E — end-to-end smoke for the 3-level swarm wiring.
 *
 * Three scenarios:
 *   1. Topic coverage — every specialist role has a model bound in the DB.
 *      Without this, children will fail-loud with "No model bound to topic".
 *   2. Simple job — one user turn, orchestrator picks one role, spawns
 *      exactly one level, response returns, no Subagents.
 *   3. Complex job — multi-topic prompt. Orchestrator fans out; at least
 *      one Agent (depth 1) spawns; ideally a Subagent (depth 2) appears.
 *      Each spawned node's model must match its topic's DB binding
 *      (proves topic→model routing; catches the "inherit parent model" bug).
 *
 * Assertions lean on swarm gateway events (`swarm.node_spawned`,
 * `swarm.node_completed`) — these carry `{nodeId, depth, kind, role, model,
 * topicPath}` and are the load-bearing contract the runtime guarantees.
 *
 * Real LLM responses ARE required; if no default / bound model exists,
 * the tests skip with a clear reason.
 */
export async function testSwarmFlow(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mSwarm flow (topic routing + simple + complex)\x1b[0m');

  if (!fixtures.authToken) {
    console.log('  \x1b[33m⊘ No auth token — skipping\x1b[0m');
    return;
  }

  // ── Specialist roles every swarm child could pick ────────────────────
  // Mirrors `AgentRole` minus 'orchestrator' (see src/core/orchestrator/types.ts).
  const SPECIALIST_ROLES = [
    'research', 'coding', 'review', 'qa', 'communication', 'general',
    'design', 'devops', 'security', 'data', 'ai',
    'finance', 'automation', 'pm', 'writing', 'architecture',
  ];

  // Cache: role → bound modelId (from the Models page, primary binding).
  let topicBindings: Record<string, string> = {};
  let defaultModelId: string | null = null;

  // Precondition: models exist and have topic bindings for every role.
  await runner.test('Topic coverage — every specialist role has a model bound', async () => {
    const { status, data } = await client.request<{
      models: Array<{ id: string; name: string; modelId: string; topics: string[]; topicRoles?: Record<string, string>; isDefault?: boolean; isEnabled?: boolean }>;
    }>('GET', '/models');
    assertStatus(status, 200);
    assert(Array.isArray(data.models) && data.models.length > 0, 'expected at least one configured model');

    const def = data.models.find(m => m.isDefault && m.isEnabled !== false);
    assert(!!def, 'expected a default model to be set');
    defaultModelId = def!.modelId;

    const missing: string[] = [];
    for (const role of SPECIALIST_ROLES) {
      // Primary topicRole wins; fall back to legacy topics[].
      const primary = data.models.find(m =>
        m.isEnabled !== false && m.topicRoles && m.topicRoles[role] === 'primary',
      );
      const legacy = primary ?? data.models.find(m =>
        m.isEnabled !== false && Array.isArray(m.topics) && m.topics.includes(role),
      );
      if (!legacy) {
        missing.push(role);
      } else {
        topicBindings[role] = legacy.modelId;
      }
    }

    assert(
      missing.length === 0,
      `Unmapped topics (set a primary model in the Models page): ${missing.join(', ')}`,
    );
  });

  // Short-circuit — every subsequent test needs topic bindings + default.
  if (!defaultModelId) {
    console.log('  \x1b[33m⊘ No default model — skipping swarm scenarios\x1b[0m');
    return;
  }

  // ── Helper: fresh session ────────────────────────────────────────────
  async function newSession(tag: string): Promise<string> {
    const { status, data } = await client.request<{ id: string }>(
      'POST', '/sessions', { channelType: 'webchat', channelId: `e2e-swarm-${tag}-${Date.now()}` },
    );
    if (status !== 200 || !data.id) throw new Error(`newSession failed (status ${status})`);
    return data.id;
  }

  // ── Helper: send chat via REST, collect swarm events via WS ──────────
  interface SpawnEvent {
    nodeId: string;
    parentNodeId: string | null;
    kind: 'orchestrator' | 'agent' | 'subagent';
    depth: 0 | 1 | 2;
    role: string;
    model: string;
    topicPath: string;
  }

  async function runTurn(
    sessionId: string,
    message: string,
    timeoutMs: number,
  ): Promise<{ spawns: SpawnEvent[]; completions: unknown[]; response: string | null; error: string | null }> {
    const ws = new GatewayWSClient();
    await ws.connect();
    // Subscribe to swarm events. GatewayWSClient auto-subscribes to '*' by default
    // but re-subscribing narrow keeps the test resilient if defaults change.
    const spawns: SpawnEvent[] = [];
    const completions: unknown[] = [];

    // Background collector — polls the WS buffer via waitFor(predicate).
    // Fire-and-forget; we just drain into local arrays.
    let collecting = true;
    (async () => {
      while (collecting && ws.isOpen) {
        try {
          const frame = await ws.waitFor(
            (f) => {
              const wrapped = f as unknown as { event?: { type?: string } };
              const t = wrapped.event?.type;
              return f.type === 'event' && (t === 'swarm.node_spawned' || t === 'swarm.node_completed');
            },
            1000,
          );
          const wrapped = frame as unknown as { event: { type: string; payload: Record<string, unknown> } };
          const evt = wrapped.event;
          if (evt.type === 'swarm.node_spawned') {
            spawns.push(evt.payload as unknown as SpawnEvent);
          } else {
            completions.push(evt.payload);
          }
        } catch {
          // timeout — loop back and keep polling until the outer await resolves
        }
      }
    })();

    try {
      // Fire the chat via REST (which is what real clients do) then await the reply.
      const fetchPromise = fetch(`${client.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fixtures.authToken}`,
        },
        body: JSON.stringify({ message, sessionId }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const response = await fetchPromise;
      const data = await response.json() as { response?: string; error?: string };

      // Give the event stream a beat to flush any trailing completion events.
      await new Promise((r) => setTimeout(r, 500));
      collecting = false;
      ws.close();

      return {
        spawns,
        completions,
        response: typeof data.response === 'string' ? data.response : null,
        error: typeof data.error === 'string' ? data.error : null,
      };
    } catch (err) {
      collecting = false;
      ws.close();
      throw err;
    }
  }

  // ── Shared assertions about a spawn set ──────────────────────────────
  function assertModelMatchesTopic(spawn: SpawnEvent): void {
    // Orchestrator is seeded with the default model; specialist roles must
    // come from their topic binding.
    if (spawn.kind === 'orchestrator') return;
    const expected = topicBindings[spawn.role];
    assert(
      !!expected,
      `Spawn role '${spawn.role}' has no topic binding — precondition test should have failed first`,
    );
    assert(
      spawn.model === expected,
      `Spawn ${spawn.nodeId} (role=${spawn.role}, kind=${spawn.kind}) ran on '${spawn.model}' but topic '${spawn.role}' is bound to '${expected}'. ` +
        `Indicates parent-model inheritance (routing bug) OR child-tier-clamp re-route.`,
    );
  }

  // ── 2. Simple job — single agent, single level ──────────────────────
  await runner.test('Simple job — orchestrator delegates once, answer returns', async () => {
    const sessionId = await newSession('simple');
    const timeoutMs = 90_000;
    const { spawns, response, error } = await runTurn(
      sessionId,
      'In one sentence: what is 2 + 2?',
      timeoutMs,
    );

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');
    // Content check — must contain "4" somewhere. Loose: models ramble.
    assert(/\b4\b|\bfour\b/i.test(response || ''), `expected the answer to mention 4: ${response?.slice(0, 200)}`);

    // Depth constraint: simple job must NOT spawn Subagents.
    const subagents = spawns.filter(s => s.kind === 'subagent');
    assert(
      subagents.length === 0,
      `Simple job spawned ${subagents.length} subagent(s): ${subagents.map(s => s.role).join(',')}. ` +
        `LLM over-delegated — tighten orchestrator prompt or check Agent-depth spawn guard.`,
    );

    // Every spawn (agent or subagent) must use the topic-bound model.
    for (const s of spawns) assertModelMatchesTopic(s);

    // Fan-out bound: orchestrator should have spawned at most ONE child.
    const depth1 = spawns.filter(s => s.kind === 'agent');
    assert(
      depth1.length <= 1,
      `Simple job should spawn at most 1 agent, saw ${depth1.length}: ${depth1.map(s => s.role).join(',')}`,
    );
  });

  // ── 3. Complex job — orchestrator → agent → subagents ───────────────
  await runner.test('Complex job — 3-level swarm fans out, results aggregate, answer returns', async () => {
    const sessionId = await newSession('complex');
    const timeoutMs = 240_000; // Complex takes longer — 4 min ceiling.
    const { spawns, response, error } = await runTurn(
      sessionId,
      // Multi-faceted prompt that maps cleanly to multiple specialist roles.
      'Briefly: suggest (a) a SQL query pattern for paginated listings, ' +
        '(b) one security concern when using session cookies, ' +
        '(c) one Docker best practice for production images. ' +
        'One sentence per item.',
      timeoutMs,
    );

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');

    // The Orchestrator itself should have registered as a depth-0 node.
    const roots = spawns.filter(s => s.kind === 'orchestrator');
    assert(roots.length >= 1, `expected at least one orchestrator node in the swarm, got ${roots.length}`);

    // Delegation happened: at least one Agent (depth 1).
    const agents = spawns.filter(s => s.kind === 'agent');
    assert(
      agents.length >= 1,
      `Complex job produced no Agent (depth 1) spawns — orchestrator refused to delegate. ` +
        `spawns seen: ${spawns.map(s => `${s.kind}:${s.role}`).join(',')}`,
    );

    // Every spawned node's model must match its topic binding.
    for (const s of spawns) assertModelMatchesTopic(s);

    // Depth invariant: never 3+.
    for (const s of spawns) {
      assert(s.depth <= 2, `Swarm node at illegal depth ${s.depth} (role=${s.role}, kind=${s.kind})`);
    }

    // Content sanity — final answer should reference the three subtopics.
    // Use term-alternatives: strong models often answer a "SQL pagination"
    // question with the concrete technique (OFFSET / keyset / LIMIT) rather
    // than repeating the word "SQL", etc. A strict substring check
    // produced false negatives.
    const low = (response || '').toLowerCase();
    const sqlHit = /\b(sql|offset|limit|keyset|cursor|pagination|query)\b/.test(low);
    const securityHit = /\b(security|cookie|httponly|samesite|secure flag|xss|csrf|session token)\b/.test(low);
    const dockerHit = /\b(docker|image|container|multi[- ]stage|dockerfile|base image)\b/.test(low);
    const hits = [sqlHit, securityHit, dockerHit].filter(Boolean).length;
    assert(hits >= 2, `Final answer missed ≥2 subtopics. Response: ${response?.slice(0, 400)}`);
  });

  // ── 3b. Agent → Subagent (depth-2) exercise ─────────────────────────
  // A separate scenario designed to encourage a specialist Agent to
  // delegate. When the LLM cooperates, we verify the 3-level chain and
  // check topic routing on depth-2 nodes. If no subagent spawns (LLM
  // judgment call — sometimes the Agent synthesizes directly), the test
  // still passes but logs the outcome so the user sees the signal.
  await runner.test('Agent spawns Subagent — 3-level chain when the task warrants it', async () => {
    const sessionId = await newSession('subagent');
    const { spawns, response, error } = await runTurn(
      sessionId,
      // Prompt framed as a single specialist domain (security audit) with
      // explicit sub-dimensions that map to DIFFERENT specialist roles
      // (data / devops / review). A well-behaved security Agent sees
      // these and delegates rather than faking expertise.
      'Act as a security auditor. Briefly audit an OAuth2 implementation: ' +
        '(1) the SQL-stored refresh-token table design (delegate to a data specialist), ' +
        '(2) the Docker image that runs the auth service (delegate to a devops specialist), ' +
        '(3) the handler code review for the token-refresh endpoint (delegate to a code-review specialist). ' +
        'Delegate each sub-part to the right subagent, then synthesize a one-paragraph summary.',
      240_000,
    );

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');

    // Every spawned node honors its topic→model binding (the hard invariant).
    for (const s of spawns) assertModelMatchesTopic(s);

    // Soft assertion: did a Subagent actually appear?
    const subagents = spawns.filter(s => s.kind === 'subagent');
    const agents = spawns.filter(s => s.kind === 'agent');
    console.log(
      `    \x1b[2m→ spawned: ${agents.length} agent(s), ${subagents.length} subagent(s). ` +
      `${subagents.length > 0 ? '3-level chain exercised.' : 'Agent synthesized directly (no subagent delegation this run).'}\x1b[0m`,
    );

    // Strong assertion: if a Subagent DID spawn, it must come from an Agent
    // parent (never directly from the Orchestrator or from another Subagent).
    for (const sa of subagents) {
      const parent = spawns.find(p => p.nodeId === sa.parentNodeId);
      assert(!!parent, `Subagent ${sa.nodeId} has no recorded parent spawn`);
      assert(
        parent?.kind === 'agent',
        `Subagent ${sa.nodeId} parent is ${parent?.kind} (expected 'agent') — depth-2 must spawn from depth-1`,
      );
      // Subagent role must differ from its Agent parent's role (same-role
      // guard in spawner). If this fires, the guard regressed.
      assert(
        parent?.role !== sa.role,
        `Subagent role '${sa.role}' equals parent Agent role — same-role guard regressed`,
      );
    }
  });

  // ── 4. Sanity — no orphaned spawns (every spawn has a completion) ────
  await runner.test('Every spawned swarm node produced a completion event', async () => {
    const sessionId = await newSession('orphan-check');
    const { spawns, completions } = await runTurn(
      sessionId,
      'Say "ok" and nothing else.',
      60_000,
    );

    const spawnIds = new Set(spawns.map(s => s.nodeId));
    const completedIds = new Set(
      completions.map(c => (c as { nodeId?: string }).nodeId).filter(Boolean) as string[],
    );
    const orphans = [...spawnIds].filter(id => !completedIds.has(id));
    assert(
      orphans.length === 0,
      `Swarm nodes spawned but never completed (leak): ${orphans.join(', ')}`,
    );
  });
}
