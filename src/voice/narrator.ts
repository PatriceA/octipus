/**
 * Voice narrator — turns orchestrator/agent lifecycle events into short spoken
 * lines. Phase A is a pure templater: no LLM, no state, can't spawn anything.
 * It only describes what the orchestrator already did, so it has zero runaway
 * surface (the only thing that starts work is the user's spoken request).
 *
 * Wired in `src/api/websocket.ts`: each `orchestrator.onEvent` / `agentManager
 * .onEvent` that already reaches a `/ws` client also gets narrated as a
 * `{type:"speak"}` frame when that connection has voice enabled. `/voice` can't
 * carry this — it's half-duplex and closes after each utterance (voice-ws.ts).
 *
 * Phase B swaps `narrate()` for an LLM on the assigned voice model; the wiring
 * and the `speak` frame stay the same.
 */

/** The subset of the orchestrator/agent event shape the narrator reads. */
export interface NarratableEvent {
  type: string;
  data?: unknown;
}

/** Roles that ARE the answer (spoken via the final reply), not worth announcing. */
const SILENT_ROLES = new Set(['octipus', 'direct']);

function field(data: unknown, key: string): string | undefined {
  if (data && typeof data === 'object' && key in data) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** A friendlier spoken name for an agent role. */
function roleLabel(role: string): string {
  return role.replace(/[_-]+/g, ' ').trim() || 'agent';
}

/**
 * Map one event to a spoken line, or null to stay silent. Deliberately terse and
 * selective — a narrator that reads every status_update is noise, not company.
 */
export function narrate(event: NarratableEvent): string | null {
  switch (event.type) {
    case 'worker_spawned': {
      const role = field(event.data, 'role');
      if (!role || SILENT_ROLES.has(role)) return null; // direct path = the answer itself
      return `On it — I've started the ${roleLabel(role)}. I'll let you know when it's done.`;
    }
    case 'worker_completed': {
      const role = field(event.data, 'role');
      if (!role || SILENT_ROLES.has(role)) return null; // spoken via the final reply
      return `The ${roleLabel(role)} just finished.`;
    }
    default:
      // The actual reply (casual, proposal, work answer) reaches the web client
      // as a `chat_response` WS message and is spoken there — the orchestrator
      // never emits it as an event, so the narrator only handles LIFECYCLE here.
      // status_update, pipeline_event, approval_required, raw agent_event: not
      // narrated in Phase A. Add cases here as the vision grows.
      return null;
  }
}

// ponytail: single runnable self-check — asserts the selection rules, not a framework.
export function demo(): void {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a !== b) throw new Error(`narrator demo: ${m} — got ${JSON.stringify(a)}`);
  };
  eq(narrate({ type: 'worker_spawned', data: { role: 'researcher' } }), 'On it — I\'ve started the researcher. I\'ll let you know when it\'s done.', 'spawn announces real worker');
  eq(narrate({ type: 'worker_spawned', data: { role: 'direct' } }), null, 'direct spawn stays silent');
  eq(narrate({ type: 'worker_completed', data: { role: 'deep_research' } }), 'The deep research just finished.', 'completion announces + de-snakes role');
  eq(narrate({ type: 'worker_completed', data: { role: 'octipus' } }), null, 'octipus completion stays silent');
  eq(narrate({ type: 'chat_response', data: { response: 'Here is your answer.' } }), null, 'reply is NOT narrated (spoken from the chat_response message instead)');
  eq(narrate({ type: 'status_update', data: { message: 'thinking' } }), null, 'status updates are not narrated in Phase A');
  eq(narrate({ type: 'worker_spawned', data: {} }), null, 'missing role stays silent');
  // eslint-disable-next-line no-console
  console.log('narrator demo: all assertions passed');
}

if (import.meta.main) demo();
