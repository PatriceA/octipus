import { deriveParamCount } from '../../../src/core/orchestrator/mode-selector';
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

  // Specialist models can reference a vault key by name (model.apiKeyRef).
  // The swarm child runs as the test user, so the key must live in *that*
  // user's vault (custom providers resolve user-scope → system → env). System
  // scope isn't writable here, so seed any provider keys into the test user's
  // own vault from the environment. Idempotent: POST /vault updates by name.
  // Add more `NAME` entries as new specialist providers need keys.
  for (const name of ['TPG_API_KEY']) {
    const value = process.env[name];
    if (!value) continue;
    const { status } = await client.request('POST', '/vault', { name, value, credentialType: 'api_key' });
    console.log(status === 200
      ? `  \x1b[2m→ seeded vault key '${name}' for test user\x1b[0m`
      : `  \x1b[33m⊘ failed to seed vault key '${name}' (status ${status})\x1b[0m`);
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

    // Topic↔model binding is owned by the Topics page (topicRoles table) and is
    // intentionally omitted from GET /models. Read the authoritative primary
    // binding from GET /topics; map its model *name* → modelId via /models.
    const modelIdByName = new Map(data.models.map(m => [m.name, m.modelId]));
    const { status: tStatus, data: tData } = await client.request<{
      topics: Array<{ value: string; primaryModel: string | null }>;
    }>('GET', '/topics');
    assertStatus(tStatus, 200);
    const primaryByTopic = new Map(tData.topics.map(t => [t.value, t.primaryModel]));

    const missing: string[] = [];
    for (const role of SPECIALIST_ROLES) {
      // Primary binding from /topics wins (matches getModelForTopic routing);
      // fall back to legacy topics[] on the model card.
      const primaryName = primaryByTopic.get(role);
      const modelId = (primaryName && modelIdByName.get(primaryName))
        ?? data.models.find(m =>
          m.isEnabled !== false && Array.isArray(m.topics) && m.topics.includes(role),
        )?.modelId;
      if (!modelId) {
        missing.push(role);
      } else {
        topicBindings[role] = modelId;
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

  interface CompletionEvent {
    nodeId: string;
    status: 'completed' | 'tool_error' | 'timeout' | 'cancelled' | 'budget_exceeded' | string;
    error?: string | null;
  }

  /** Throw if any spawn node did not finish with status='completed'. */
  function assertAllSpawnsSucceeded(spawns: SpawnEvent[], completions: CompletionEvent[]): void {
    const byId = new Map(completions.map((c) => [c.nodeId, c]));
    const failures: string[] = [];
    for (const s of spawns) {
      const c = byId.get(s.nodeId);
      if (!c) {
        failures.push(`${s.kind}:${s.role} (${s.nodeId.slice(0, 8)}) — no completion event`);
        continue;
      }
      if (c.status !== 'completed') {
        const trimmedErr = (c.error || '').slice(0, 160);
        failures.push(`${s.kind}:${s.role} (${s.nodeId.slice(0, 8)}) status=${c.status} err="${trimmedErr}"`);
      }
    }
    assert(
      failures.length === 0,
      `Swarm node(s) did not succeed:\n    - ${failures.join('\n    - ')}`,
    );
  }

  /**
   * A node cancelled because the *e2e test user* can't resolve a vault-referenced
   * provider key — e.g. a specialist model (devops → custom provider) whose key
   * lives only in a real user's vault. Custom providers resolve user→system→env,
   * so this is an environment gap (seed the key via its env var or the test
   * user's vault), NOT a swarm/routing regression. Callers skip rather than fail.
   * Returns the apiKeyRef for the skip message, or null if no such gap.
   */
  function unresolvedProviderKey(completions: CompletionEvent[]): string | null {
    for (const c of completions) {
      const m = (c.error || '').match(/no API key resolved \(apiKeyRef='([^']*)'\)/i);
      if (m) return m[1];
    }
    return null;
  }

  async function runTurn(
    sessionId: string,
    message: string,
    timeoutMs: number,
  ): Promise<{ spawns: SpawnEvent[]; completions: CompletionEvent[]; response: string | null; error: string | null }> {
    const ws = new GatewayWSClient();
    await ws.connect();
    // Subscribe to swarm events. GatewayWSClient auto-subscribes to '*' by default
    // but re-subscribing narrow keeps the test resilient if defaults change.
    const spawns: SpawnEvent[] = [];
    const completions: CompletionEvent[] = [];

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
            completions.push(evt.payload as unknown as CompletionEvent);
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
    const { spawns, completions, response, error } = await runTurn(
      sessionId,
      'In one sentence: what is 2 + 2?',
      timeoutMs,
    );

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');
    // Content check — must contain "4" somewhere. Loose: models ramble.
    assert(/\b4\b|\bfour\b/i.test(response || ''), `expected the answer to mention 4: ${response?.slice(0, 200)}`);

    // Hard invariant: every spawned node must reach status='completed'.
    // A tool_error / timeout is a test failure even if the top-level
    // response string looked fine — the orchestrator hid the child failure.
    assertAllSpawnsSucceeded(spawns, completions);

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
    if (process.env.E2E_SKIP_SLOW_SWARM === '1') {
      console.log('    \x1b[33m⊘ E2E_SKIP_SLOW_SWARM=1 — skipping\x1b[0m');
      return;
    }
    const sessionId = await newSession('complex');
    // 6-minute ceiling. Per-level wall-clock cap is 240s (config.defaults).
    // A child failing once and triggering retry burst (2+4+8s) leaves no
    // headroom under a 240s outer fetch deadline — give the retry path room.
    const timeoutMs = 360_000;
    const { spawns, completions, response, error } = await runTurn(
      sessionId,
      // Multi-faceted prompt that maps cleanly to multiple specialist roles.
      //
      // The instruction MUST explicitly order delegation. Left implicit,
      // orchestrator LLMs (esp. deepseek-chat) often synthesize directly —
      // which makes the fan-out contract untestable. We want to prove the
      // routing works when delegation is chosen, not gamble on the LLM's
      // mood.
      'You are the orchestrator. Do NOT answer directly — you MUST use ' +
        'spawn_child to delegate each of the three sub-parts below to the ' +
        'best-fitting specialist role (data, security, devops, review, etc.), ' +
        'then synthesize their outputs into the final answer. ' +
        'Sub-parts (one sentence each in the final reply): ' +
        '(a) a SQL query pattern for paginated listings, ' +
        '(b) one security concern when using session cookies, ' +
        '(c) one Docker best practice for production images.',
      timeoutMs,
    );

    const keyGap = unresolvedProviderKey(completions);
    if (keyGap) {
      console.log(`    \x1b[33m⊘ specialist model needs key '${keyGap}', not resolvable for the e2e test user — seed via env or the test user's vault; skipping\x1b[0m`);
      return;
    }

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');

    // Hard invariant: every spawned node must reach status='completed'.
    assertAllSpawnsSucceeded(spawns, completions);

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
    if (process.env.E2E_SKIP_SLOW_SWARM === '1') {
      console.log('    \x1b[33m⊘ E2E_SKIP_SLOW_SWARM=1 — skipping\x1b[0m');
      return;
    }
    const sessionId = await newSession('subagent');
    const { spawns, completions, response, error } = await runTurn(
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
      360_000,
    );

    const keyGap = unresolvedProviderKey(completions);
    if (keyGap) {
      console.log(`    \x1b[33m⊘ specialist model needs key '${keyGap}', not resolvable for the e2e test user — seed via env or the test user's vault; skipping\x1b[0m`);
      return;
    }

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');

    // Hard invariant: every spawned node must reach status='completed'.
    assertAllSpawnsSucceeded(spawns, completions);

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

  // ── 3c. Parallel fan-out ─────────────────────────────────────────────
  // Proves orchestrator can spawn multiple children *concurrently*. The
  // swarm-tool schema exposes `parallelGroup`; tool-executor runs same-
  // group calls via `Promise.all`. If the orchestrator emits them
  // serially (spawn → await → spawn), we lose this optimisation.
  //
  // Detection: look at the spawn wall-clock timestamps. Parallel siblings
  // must overlap — i.e. the second sibling starts before the first one
  // finishes. Serial execution would show them strictly non-overlapping.
  await runner.test('Parallel fan-out — siblings overlap in wall-clock', async () => {
    if (process.env.E2E_SKIP_SLOW_SWARM === '1') {
      console.log('    \x1b[33m⊘ E2E_SKIP_SLOW_SWARM=1 — skipping\x1b[0m');
      return;
    }
    const sessionId = await newSession('parallel');
    const timeoutMs = 360_000;
    const { spawns, completions, response, error } = await runTurn(
      sessionId,
      // Three independent, orthogonal sub-questions. The prompt *explicitly*
      // asks for parallelism so the orchestrator uses `parallelGroup`.
      'You are the orchestrator. Use spawn_child THREE TIMES IN THE SAME ' +
        'TURN with the same `parallelGroup` value (e.g. "q1") so the three ' +
        'children run concurrently. Do NOT answer directly. The three ' +
        'independent questions: ' +
        '(A) name one SQL index type for range queries, ' +
        '(B) name one OWASP top-10 risk category, ' +
        '(C) name one Docker multi-stage-build benefit. ' +
        'Delegate A → data, B → security, C → devops, then return one sentence per item.',
      timeoutMs,
    );

    const keyGap = unresolvedProviderKey(completions);
    if (keyGap) {
      console.log(`    \x1b[33m⊘ specialist model needs key '${keyGap}', not resolvable for the e2e test user — seed via env or the test user's vault; skipping\x1b[0m`);
      return;
    }

    assert(!error, `chat returned error: ${error}`);
    assert(typeof response === 'string' && response.length > 0, 'expected a non-empty response');
    assertAllSpawnsSucceeded(spawns, completions);

    const agents = spawns.filter((s) => s.kind === 'agent');
    if (agents.length < 2) {
      // Orchestrator refused to fan out enough — this scenario can't prove
      // parallelism with <2 siblings. Surface as a soft skip rather than a
      // false pass (the prompt was explicit; this usually means the LLM
      // decided to answer directly, which scenario "Complex job" already
      // flags).
      console.log(`    \x1b[33m⊘ orchestrator produced ${agents.length} agent(s); cannot check overlap — skipping\x1b[0m`);
      return;
    }

    // Map agent nodeId → spawn event (has `timestamp` injected by runTurn?
    // The WS payload doesn't carry explicit start/complete ms, but
    // completion payloads carry durationMs. We reconstruct overlap from
    // (completion.timestamp - durationMs) windows per node.
    const completionById = new Map(completions.map((c) => [c.nodeId, c]));

    // Pull `createdAt` + `completedAt` from the REST list — the canonical
    // wall-clock record. Event timestamps over WS are per-emit, not start.
    interface TimingRow { id: string; created: number; completed: number }
    const { data } = await client.request<{ nodes?: Array<{ id: string; createdAt: string; completedAt?: string | null; kind: string; }> }>(
      'GET', `/swarm/nodes?rootSessionId=${sessionId}`,
    );
    const timings: TimingRow[] = [];
    for (const n of data.nodes || []) {
      if (n.kind !== 'agent') continue;
      if (!n.completedAt) continue;
      timings.push({
        id: n.id,
        created: new Date(n.createdAt).getTime(),
        completed: new Date(n.completedAt).getTime(),
      });
    }
    timings.sort((a, b) => a.created - b.created);
    assert(timings.length >= 2, `expected ≥2 agent timings, got ${timings.length}`);

    // Overlap check: for at least one pair (i, j<i), j.created must land
    // before i.completed. In strict serial mode, j.created >= i.completed.
    let anyOverlap = false;
    for (let i = 1; i < timings.length && !anyOverlap; i++) {
      for (let j = 0; j < i; j++) {
        if (timings[i].created < timings[j].completed) {
          anyOverlap = true;
          break;
        }
      }
    }

    // Log the timeline so regressions are easy to eyeball.
    const baseTs = timings[0].created;
    const timeline = timings.map((t) =>
      `${t.id.slice(0, 8)}: [${t.created - baseTs}ms → ${t.completed - baseTs}ms]`,
    ).join('  ');
    console.log(`    \x1b[2m→ ${timeline}\x1b[0m`);
    console.log(`    \x1b[2m→ completion count: ${completionById.size}\x1b[0m`);

    assert(
      anyOverlap,
      `All agent spawns ran strictly sequentially. Timeline:\n    ${timeline}\n    ` +
        'Either orchestrator did not use parallelGroup, or tool-executor regressed to serial execution.',
    );
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
    const completedIds = new Set(completions.map(c => c.nodeId).filter(Boolean));
    const orphans = [...spawnIds].filter(id => !completedIds.has(id));
    assert(
      orphans.length === 0,
      `Swarm nodes spawned but never completed (leak): ${orphans.join(', ')}`,
    );
    // And every completion must report status='completed' — not just "exited".
    assertAllSpawnsSucceeded(spawns, completions);
  });

  // ── 5. Size → orchestrator mode (auto) ───────────────────────────────
  // The runtime half of the model-size → mode feature: in `auto` mode the
  // orchestrator mode is re-derived each turn from the default model's param
  // count against the configured thresholds (router < small < lite < full).
  // The size→mode *mapping* is unit-tested (mode-selector.test.ts); here we
  // prove the chosen mode actually changes runtime BEHAVIOUR end-to-end.
  //
  // Discriminator (deterministic, not LLM-mood-dependent): router mode runs a
  // single role-scoped worker with NO orchestrator node in the swarm, while
  // lite/full always create a depth-0 'orchestrator' node up-front — regardless
  // of whether the LLM chooses to delegate. So we hold the model fixed and slide
  // the thresholds across its size, asserting the orchestrator node appears or
  // disappears accordingly.
  //
  // Admin-only (mutates global orchestrator settings) — skips cleanly otherwise.
  await runner.test('Auto mode derives orchestrator behaviour from model size (router ↔ full)', async () => {
    // Two trivial "say ok" turns — lighter than the 6-min fan-out scenarios
    // above, so it is NOT gated behind E2E_SKIP_SLOW_SWARM; it self-skips when
    // the caller lacks admin or the model size can't be derived.

    // Admin gate: a non-admin PUT returns 403 — skip rather than fail.
    const gate = await client.request<{ error?: string }>('PUT', '/settings/orchestrator.mode', { value: 'auto' });
    if (gate.status === 403 || (gate.data?.error || '').includes('Admin')) {
      console.log('    \x1b[33m⊘ requires admin to flip orchestrator settings — skipping\x1b[0m');
      return;
    }
    assertStatus(gate.status, 200);

    // The size the thresholds key off. If the default model id carries no
    // parseable size, `auto` would fall back to lite (no router branch) and the
    // router half couldn't be exercised — skip with a clear reason.
    const params = deriveParamCount(defaultModelId!);
    if (!params) {
      console.log(`    \x1b[33m⊘ cannot derive param count from default model '${defaultModelId}' — skipping\x1b[0m`);
      return;
    }

    // Read + remember the live values so we can restore them afterwards.
    const { data: cat } = await client.request<{ settings?: Array<{ key: string; value: unknown }> }>(
      'GET', '/settings/category/orchestrator',
    );
    const original = new Map((cat.settings ?? []).map((s) => [s.key, s.value]));
    const KEYS = ['orchestrator.mode', 'orchestrator.routerSmallModelMaxParams', 'orchestrator.liteModelMaxParams'];

    const setKey = async (key: string, value: unknown) => {
      const { status, data } = await client.request<{ error?: string }>('PUT', `/settings/${key}`, { value });
      assert(status === 200 && !data.error, `failed to set ${key}=${value}: status ${status} ${data.error ?? ''}`);
    };

    try {
      // ROUTER: thresholds set ABOVE the model size ⇒ params < router cap ⇒ router.
      await setKey('orchestrator.routerSmallModelMaxParams', params + 1);
      await setKey('orchestrator.liteModelMaxParams', params + 2);
      const routerTurn = await runTurn(await newSession('mode-router'), 'Say "ok" and nothing else.', 60_000);
      assert(!routerTurn.error, `router-mode turn errored: ${routerTurn.error}`);
      assertAllSpawnsSucceeded(routerTurn.spawns, routerTurn.completions);
      const routerOrch = routerTurn.spawns.filter((s) => s.kind === 'orchestrator');
      assert(
        routerOrch.length === 0,
        `router mode (params ${params} < cap ${params + 1}) must NOT spawn an orchestrator node, saw ${routerOrch.length}. ` +
          'Either auto-mode mis-derived the mode, or the router short-circuit regressed.',
      );

      // FULL: thresholds set BELOW the model size ⇒ params >= lite cap ⇒ full.
      await setKey('orchestrator.routerSmallModelMaxParams', 1);
      await setKey('orchestrator.liteModelMaxParams', 2);
      const fullTurn = await runTurn(await newSession('mode-full'), 'Say "ok" and nothing else.', 90_000);
      assert(!fullTurn.error, `full-mode turn errored: ${fullTurn.error}`);
      assertAllSpawnsSucceeded(fullTurn.spawns, fullTurn.completions);
      const fullOrch = fullTurn.spawns.filter((s) => s.kind === 'orchestrator');
      assert(
        fullOrch.length >= 1,
        `full mode (params ${params} >= caps) must spawn a depth-0 orchestrator node, saw ${fullOrch.length}. ` +
          'Either auto-mode mis-derived the mode, or the swarm root node stopped being recorded.',
      );

      console.log(
        `    \x1b[2m→ model '${defaultModelId}' (~${(params / 1e9).toFixed(1)}B): ` +
          'router-cap above size ⇒ no orchestrator node; caps below size ⇒ orchestrator node present.\x1b[0m',
      );
    } finally {
      // Restore the original orchestrator settings, whatever they were.
      for (const key of KEYS) {
        if (original.has(key)) {
          const { status } = await client.request('PUT', `/settings/${key}`, { value: original.get(key) });
          if (status !== 200) console.log(`    \x1b[33m⚠ failed to restore ${key} (status ${status})\x1b[0m`);
        }
      }
    }
  });
}
