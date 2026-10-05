import type { TurnEvent } from '@/core/agent/service';
import type { AgentEvent } from '@/core/agent-base';
import type { PermissionRequestEvent, PermissionResolvedEvent } from '@/security/permissions';
import { coreLogger } from '@/utils/logger';
import { narrate } from '@/voice/narrator';
import type { GatewayHub } from './hub';

/**
 * Bridge existing root agent and agent manager events to the gateway event bus.
 * This runs after both the gateway hub and root agent are initialized.
 *
 * Call `connectEventBridge(hub)` from the startup sequence after the root agent
 * is ready. The sources are imported here, lazily, because several of them
 * import the gateway themselves; a source that cannot load fails the call —
 * the web would otherwise wait on events nothing forwards.
 */
export async function connectEventBridge(hub: GatewayHub): Promise<() => void> {
  const cleanups: (() => void)[] = [];
  const [
    { getAgentService },
    { getAgentManager },
    { getPermissionManager },
    { getDocumentQueue },
    { onInstallProgress },
  ] = await Promise.all([
    import('@/core/agent'),
    import('@/core/agent-manager'),
    import('@/security/permissions'),
    import('@/core/documents/queue'),
    import('@/capabilities/hwfit/install-events'),
  ]);

  // Bridge root agent events → gateway event bus
  {
    const rootAgent = getAgentService();

    const unsubOrch = rootAgent.onEvent((event: TurnEvent) => {
      hub.publishEvent(turnEventToGateway(event));
      // Narrate the lifecycle to the connection(s) that put this session into
      // voice mode (`voice.set`) — not the user's other tabs or sessions.
      const line = narrate(event);
      if (line) {
        hub.publishEvent(
          { type: 'voice.speak', source: 'narrator', userId: event.userId, sessionId: event.sessionId, payload: { text: line } },
          (ctx) => ctx.voiceSessionId === event.sessionId,
        );
      }
    });

    cleanups.push(unsubOrch);
    coreLogger.debug('Connected rootAgent events to gateway event bus');
  }

  // Bridge agent manager events → gateway event bus
  {
    const agentManager = getAgentManager();

    const unsubAgent = agentManager.onEvent((event: AgentEvent) => {
      // AgentEvent carries { type, agentId, data, timestamp } — no userId/
      // sessionId; the owner comes from the agent's context. The worker's emitted
      // `type` union is thought|action|observation|error|complete|
      // status_change|permission_request.
      //
      // Every event goes to the agent's owner only. An event whose agent is
      // already gone has no owner to go to and is dropped, never broadcast.
      const ctx = agentManager.get(event.agentId)?.getContext();
      if (!ctx) {
        coreLogger.debug({ agentId: event.agentId, type: event.type }, 'agent event after agent removal — dropped');
        return;
      }

      // Filter `thought` events down to the iteration-update sub-shape so
      // chats and TUIs can show a "iter N/M" tick while the agent is
      // still reasoning. The other `thought` payloads (free-form chain-
      // of-thought) stay internal — surfacing them as gateway events
      // would explode bandwidth and leak reasoning.
      if (event.type === 'thought') {
        const data = event.data as { type?: string; iteration?: number; reason?: string; blockedForMs?: number; delta?: string } | undefined;
        if (data?.type === 'text_delta' && typeof data.delta === 'string') {
          // Scoped to the owner and session: the hub filters by userId, the
          // TUI by envelope sessionId.
          hub.publishEvent({
            type: 'chat.delta',
            source: `agent:${event.agentId}`,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            payload: { agentId: event.agentId, delta: data.delta, iteration: data.iteration ?? 0 },
          });
          return;
        }
        if (data?.type === 'iteration_update' && typeof data.iteration === 'number') {
          hub.publishEvent({
            type: 'agent.iteration',
            source: `agent:${event.agentId}`,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            payload: { agentId: event.agentId, iteration: data.iteration },
          });
        }
        // A long silence is indistinguishable from a hang unless we say what we
        // are waiting for. Low volume by construction — one every 20s, and only
        // while genuinely blocked (docs/plans/blocked-vs-stuck.md Phase 1).
        if (data?.type === 'blocked_progress' && typeof data.reason === 'string') {
          hub.publishEvent({
            type: 'agent.blocked',
            source: `agent:${event.agentId}`,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            payload: { agentId: event.agentId, reason: data.reason, blockedForMs: data.blockedForMs ?? 0 },
          });
        }
        return;
      }
      // 'action' carries the tool-call stream payload — bridge it as its own
      // subtype so the TUI (and any other `/gateway` client) can match it
      // instead of fishing through the generic `agent.event` bucket.
      const subtype = event.type === 'action' ? 'agent.action' : 'agent.event';
      // `source` is dropped before the payload reaches a client, so the agent
      // has to ride IN the payload — without it a client can't tell a
      // subagent's tool call from the root agent's. `agentEvent` keeps the
      // worker's own event kind (`complete`, `status_change`, …), which the
      // generic `agent.event` type would otherwise lose.
      const data = event.data ?? event;
      hub.publishEvent({
        type: subtype,
        source: `agent:${event.agentId}`,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        payload: typeof data === 'object' && data !== null && !Array.isArray(data)
          ? { agentId: event.agentId, agentEvent: event.type, ...(data as Record<string, unknown>) }
          : data,
      });
    });

    cleanups.push(unsubAgent);
    coreLogger.debug('Connected agent manager events to gateway event bus');
  }

  // Bridge permission requests → gateway event bus
  {
    const permissionManager = getPermissionManager();

    const unsubPerm = permissionManager.onRequest((request: PermissionRequestEvent) => {
      // Field names must match `PermissionManager.emitRequest` in
      // `src/security/permissions.ts` — the emitter sends `requestId`,
      // `toolName`, and `args`. Reading `request.id`/`request.context` here
      // produced undefined values, leaving the TUI permission prompt with
      // an empty requestId so users could never approve/deny.
      hub.publishEvent({
        type: 'permission.request',
        source: `agent:${request.agentId}`,
        userId: request.userId,
        sessionId: request.sessionId,
        payload: {
          requestId: request.requestId,
          toolId: request.toolId,
          action: request.action,
          toolName: request.toolName,
          args: request.args,
        },
      });
    });

    const unsubResolved = permissionManager.onResolved((event: PermissionResolvedEvent) => {
      hub.publishEvent({
        type: 'permission.resolved', source: `agent:${event.agentId}`,
        userId: event.userId, sessionId: event.sessionId,
        payload: { requestId: event.requestId, status: event.status },
      });
    });
    cleanups.push(unsubPerm, unsubResolved);
    coreLogger.debug('Connected permission manager to gateway event bus');
  }

  // Bridge document processing → gateway, stamped with the uploader. A job
  // with no uploader has nobody to tell and is not published.
  {
    const queue = getDocumentQueue();
    // One publish per type, written out: the generated catalog reads the
    // `type:` literal at each publish site.
    const onEnqueued = (documentId: string, userId?: string) => {
      if (userId) hub.publishEvent({ type: 'document.enqueued', source: 'documents', userId, payload: { documentId } });
    };
    const onProcessing = (documentId: string, userId?: string) => {
      if (userId) hub.publishEvent({ type: 'document.processing', source: 'documents', userId, payload: { documentId } });
    };
    const onCompleted = (documentId: string, userId?: string) => {
      if (userId) hub.publishEvent({ type: 'document.completed', source: 'documents', userId, payload: { documentId } });
    };
    const onFailed = (documentId: string, error: string, userId?: string) => {
      if (userId) hub.publishEvent({ type: 'document.failed', source: 'documents', userId, payload: { documentId, error } });
    };
    queue.on('enqueued', onEnqueued);
    queue.on('processing', onProcessing);
    queue.on('completed', onCompleted);
    queue.on('failed', onFailed);
    cleanups.push(() => {
      queue.off('enqueued', onEnqueued);
      queue.off('processing', onProcessing);
      queue.off('completed', onCompleted);
      queue.off('failed', onFailed);
    });
  }

  // Bridge local model installs → gateway, to whoever started the install.
  cleanups.push(onInstallProgress((job) => {
    hub.publishEvent({ type: 'model.install_progress', source: 'hwfit', userId: job.ownerId, payload: { job } });
  }));

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (err) { coreLogger.warn({ err }, 'event-bridge cleanup failed'); }
    }
  };
}

/**
 * Map root agent event types to gateway event type namespaces.
 */
function mapTurnEventType(type: string): import('./protocol').UserEventType {
  switch (type) {
    case 'chat_response': return 'chat.response';
    case 'status_update': return 'rootAgent.status';
    case 'approval_required': return 'agent.approval_required';
    case 'approval_resolved': return 'approval.resolved';
    case 'worker_spawned': return 'agent.spawned';
    case 'worker_completed': return 'agent.completed';
    case 'pipeline_event': return 'pipeline.event';
    case 'team_started': return 'team.started';
    case 'team_completed': return 'team.completed';
    default: return 'agent.event';
  }
}

/** Keep background replies in the same wire shape as chat.send responses. */
export function turnEventToGateway(event: TurnEvent): Omit<import('./protocol').UserGatewayEvent, 'id' | 'timestamp'> {
  return { type: mapTurnEventType(event.type), source: 'root', userId: event.userId, sessionId: event.sessionId,
    payload: event.type === 'chat_response' ? { response: event.data } : event.data };
}
