import { getGatewayHub } from '@/core/gateway/hub';
import type { GatewayEvent } from '@/core/gateway/protocol';
import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';
import { renderNarration, resolvePersonaForUser } from './resolver';

/**
 * Listen for `swarm.node_spawned` and `swarm.node_completed` events
 * and emit `swarm.narration` events with the active persona's rendered
 * one-liner ("Octipus dispatches a research arm.").
 *
 * Channels subscribe to `swarm.narration` independently — they can
 * surface it as a status update or skip it entirely. Keeping
 * narration in a separate event means turning persona narration on/off
 * is one config switch (`narration: off`) and doesn't ripple through
 * the spawner core.
 */

let installed = false;

export function installNarrationBridge(): () => void {
  if (installed) return () => {};
  installed = true;

  const hub = getGatewayHub();

  const offSpawn = hub.eventBus.subscribe('swarm.node_spawned', (event) => {
    void handleSpawn(event);
  });
  const offComplete = hub.eventBus.subscribe('swarm.node_completed', (event) => {
    void handleCompleted(event);
  });
  const offBudget = hub.eventBus.subscribe('swarm.budget_warning', (event) => {
    void handleBudget(event);
  });

  return () => {
    offSpawn();
    offComplete();
    offBudget();
    installed = false;
  };
}

async function handleSpawn(event: GatewayEvent): Promise<void> {
  try {
    if (!event.sessionId) return;
    const payload = event.payload as { role?: string; taskBriefPreview?: string; parallelGroup?: string };
    const userId = await sessionUserId(event.sessionId);
    if (!userId) return;
    const persona = await resolvePersonaForUser(userId);
    if (persona.narration === 'off') return;
    const verb = inferVerb(payload.role || 'general', payload.taskBriefPreview || '');
    const text = renderNarration(persona, 'spawn_single', {
      role: payload.role || 'specialist',
      verb,
      count: 1,
    });
    if (!text) return;
    publishNarration(event, text);
  } catch (err) {
    coreLogger.debug({ err }, 'narration-bridge: spawn handler failed');
  }
}

async function handleCompleted(event: GatewayEvent): Promise<void> {
  try {
    if (!event.sessionId) return;
    const payload = event.payload as { role?: string; status?: string; output?: string; error?: string };
    const userId = await sessionUserId(event.sessionId);
    if (!userId) return;
    const persona = await resolvePersonaForUser(userId);
    if (persona.narration === 'off') return;
    const ok = !payload.status || payload.status === 'ok' || payload.status === 'completed' || payload.status === 'cache_hit';
    const text = renderNarration(
      persona,
      ok ? 'completion_ok' : 'completion_error',
      {
        role: payload.role || 'specialist',
        summary_one_liner: oneLineSummary(payload.output) || '',
        error_line: oneLineSummary(payload.error) || (payload.status ?? 'failed'),
      },
    );
    if (!text) return;
    publishNarration(event, text);
  } catch (err) {
    coreLogger.debug({ err }, 'narration-bridge: completion handler failed');
  }
}

async function handleBudget(event: GatewayEvent): Promise<void> {
  try {
    if (!event.sessionId) return;
    const userId = await sessionUserId(event.sessionId);
    if (!userId) return;
    const persona = await resolvePersonaForUser(userId);
    if (persona.narration === 'off') return;
    const text = renderNarration(persona, 'budget_warning', {});
    if (!text) return;
    publishNarration(event, text);
  } catch (err) {
    coreLogger.debug({ err }, 'narration-bridge: budget handler failed');
  }
}

function publishNarration(source: GatewayEvent, text: string): void {
  getGatewayHub().publishEvent({
    type: 'swarm.narration',
    source: source.source,
    userId: source.userId,
    sessionId: source.sessionId,
    payload: {
      text,
      sourceEventId: source.id,
      sourceEventType: source.type,
    },
  });
}

async function sessionUserId(sessionId: string): Promise<string | null> {
  try {
    const session = await sessionRepository.findById(sessionId);
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort verb pick for the spawn template. Persona templates
 * accept a `{{verb}}` placeholder; map common role→verb so the
 * narration reads naturally ("dispatches a research arm to look into
 * this").
 */
function inferVerb(role: string, _brief: string): string {
  switch (role) {
    case 'research': return 'to look into this';
    case 'coding': return 'to write the change';
    case 'review': return 'to review';
    case 'qa': return 'to run the tests';
    case 'security': return 'to check for issues';
    case 'devops': return 'to handle the infra';
    case 'design': return 'to design this';
    case 'architecture': return 'to plan the architecture';
    case 'writing': return 'to write the docs';
    case 'communication': return 'to send the message';
    case 'data': return 'to crunch the data';
    case 'pm': return 'to map this out';
    case 'finance': return 'to do the math';
    case 'automation': return 'to schedule this';
    case 'general': return 'to handle this';
    default: return 'to handle this';
  }
}

function oneLineSummary(text: string | undefined): string {
  if (!text) return '';
  const trimmed = text.trim().split('\n')[0].trim();
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '...';
}

export function _resetNarrationBridgeForTesting(): void {
  installed = false;
}
