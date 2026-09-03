import { coreLogger } from '@/utils/logger';
import { getCommandRegistry } from './commands';
import type { GatewayHub } from './hub';
import type { ClientMessage, ConnectionContext } from './protocol';

/**
 * Resolve a gateway userId to a real DB user ID.
 * Local auth gives 'local', system auth gives 'system' — these aren't DB UUIDs.
 */
async function resolveUserId(userId: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return userId; // Already a UUID
  }
  // Resolve to the first admin user (same as MASTER_KEY auth in REST API)
  try {
    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { eq } = await import('drizzle-orm');
    const db = getDb();
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1);
    if (admin) return admin.id;
  } catch (err) { coreLogger.error({ err }, 'silent failure in message-handler'); }
  return userId; // Fallback
}

/**
 * Inject a user message into a running root agent turn for this session, if
 * one exists, so it changes course mid-flight instead of racing a concurrent
 * turn. Returns true when a live root agent absorbed the message.
 *
 * This is the per-session lock the steering design calls for: one live
 * root agent per session; while it runs, further user messages steer it. The
 * root agent drains its steering queue at the next iteration boundary, and
 * because spawning is always-detach it is genuinely free between iterations to
 * react. The injected message is persisted so the transcript stays complete
 * (the steering queue itself does not persist).
 */
type SteerableWorker = { steer: (m: { role: 'user'; content: string; timestamp: Date }) => void };

/** Exported for unit tests. */
export async function trySteerRunningRootAgent(sessionId: string, content: string): Promise<boolean> {
  const { getAgentManager } = await import('@/core/agent-manager');
  const mgr = getAgentManager();
  const target = mgr
    .getBySession(sessionId)
    .filter((a) => a.getStatus() === 'running' && a.getContext().root === true)
    .find((a): a is typeof a & SteerableWorker => typeof (a as Partial<SteerableWorker>).steer === 'function');
  if (!target) return false;

  // Guard the injected content exactly as handleMessage guards a normal turn —
  // a steer must not be a hole around the input guard. On block, return false so
  // the caller falls through to the normal path, which surfaces the block.
  const { guardInput } = await import('@/core/agent/input-guard');
  if (guardInput(content).action === 'block') {
    coreLogger.warn({ sessionId }, 'Input guard blocked a steering message — routing through normal path');
    return false;
  }

  target.steer({ role: 'user', content, timestamp: new Date() });

  // Race guard: if the root agent finished between the status check and the
  // steer, its steering queue will never drain. Don't persist an orphaned user
  // message — fall back to a normal turn (the dead queue copy is harmless).
  if (target.getStatus() !== 'running') return false;

  try {
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    await messageRepository.create({ sessionId, role: 'user', content });
    await sessionRepository.incrementMessageCount(sessionId);
  } catch (err) {
    coreLogger.error({ err, sessionId }, 'failed to persist steered user message');
  }
  return true;
}

/**
 * Wire the gateway hub's message handler to route authenticated messages
 * to the appropriate backend services (root agent, permissions, agents).
 */
export function wireMessageHandler(hub: GatewayHub): void {
  hub.setMessageHandler(async (connectionId, context, message) => {
    switch (message.type) {
      case 'chat.send':
        await handleChatSend(hub, connectionId, context, message);
        break;

      case 'chat.interject':
        await handleChatInterject(hub, connectionId, context, message);
        break;

      case 'chat.steer':
        await handleChatSteer(hub, connectionId, context, message);
        break;

      case 'command':
        await handleCommand(hub, connectionId, context, message);
        break;

      case 'permission.respond':
        await handlePermissionRespond(hub, connectionId, context, message);
        break;

      case 'approval.respond':
        await handleApprovalRespond(hub, connectionId, context, message);
        break;

      case 'agent.stop':
        await handleAgentStop(hub, connectionId, context, message);
        break;

      default:
        // ping, subscribe, unsubscribe handled by hub itself
        break;
    }
  });
}

async function handleChatSend(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'chat.send' }>,
): Promise<void> {
  try {
    const { getAgentService } = await import('@/core/agent');
    const rootAgent = getAgentService();

    // Track the session on the connection for /status command
    context.sessionId = message.sessionId;

    // Resolve the principal up front — we need userId both for the optional
    // session pre-create below AND for the root agent call.
    const userId = await resolveUserId(context.userId);

    // If a root agent turn is already running for this session, steer it
    // with this message instead of spawning a concurrent turn. Keeps one live
    // root agent per session; the user can redirect work mid-flight.
    if (await trySteerRunningRootAgent(message.sessionId, message.content)) {
      hub.publishEvent({
        type: 'chat.message',
        source: `steer:${connectionId}`,
        userId,
        sessionId: message.sessionId,
        payload: { role: 'user', content: message.content, injected: true },
      });
      return;
    }

    // Set project context on the session if provided (enables dev mode).
    //
    // The TUI generates a fresh sessionId per launch — so when the very
    // first message arrives, `findById` returns null, the previous version
    // of this block silently skipped the projectPath write, and by the
    // time the root agent created the row inside `resolveSession`,
    // devMode/projectPath had been lost. The root agent then fell back
    // to the generic workspace path and child workers operated against
    // the wrong repo. Pre-create the session row here when projectPath
    // is supplied so the dev-mode context is in place before the
    // root agent reads it.
    // devMode/projectPath point the agent at an arbitrary host path, so honor
    // them only for a single-user install or an admin caller — otherwise any
    // user on a shared instance could escape their workspace sandbox by
    // sending projectPath='/etc'. Gated at this ingestion site so the flag
    // never reaches session context for an untrusted caller. (See
    // src/security/devmode.ts; mirrors the REST /chat gate.)
    let devModeOk = false;
    if (message.projectPath) {
      const { userRepository } = await import('@/db/repositories/user-repository');
      const { checkProjectPath, devModeAllowed } = await import('@/security/devmode');
      const u = await userRepository.findById(userId);
      devModeOk = devModeAllowed(!!u?.isAdmin, message.projectPath);
      if (!devModeOk) {
        // Distinguish the two rejection causes — "you're not an admin" and
        // "that path isn't a project" need very different operator responses.
        const pathCheck = u?.isAdmin ? checkProjectPath(message.projectPath) : undefined;
        coreLogger.warn(
          { userId, sessionId: message.sessionId, projectPath: message.projectPath, reason: pathCheck?.reason },
          pathCheck
            ? 'Ignoring devMode/projectPath — rejected project path'
            : 'Ignoring devMode/projectPath from non-admin under multiuser',
        );
      }
    }
    if (message.projectPath && devModeOk) {
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const session = await sessionRepository.findById(message.sessionId);
      if (session) {
        const existingCtx = (session.context || {}) as Record<string, unknown>;
        if (!existingCtx.projectPath) {
          await sessionRepository.update(message.sessionId, {
            context: {
              ...existingCtx,
              devMode: true,
              projectPath: message.projectPath,
              projectName: message.projectPath.split(/[/\\]/).pop() || 'project',
            },
          });
          coreLogger.info({ sessionId: message.sessionId, projectPath: message.projectPath }, 'Set project context on session');
        }
      } else {
        // Pre-create with dev-mode context baked in. resolveSession will
        // see the row exists and skip its own create. Also tag with the
        // user's default workspace_id so the session shows up only in
        // that workspace's session list — TUI sessions were previously
        // created with workspace_id=NULL which made them visible from
        // every workspace via the legacy "NULL = visible everywhere"
        // fallback in scopedRepos.workspaceFilter.
        let workspaceId: string | null = null;
        try {
          const { getOrgWorkspaceManager } = await import('@/security/orgs');
          const def = await getOrgWorkspaceManager().ensureDefaultWorkspace(userId);
          workspaceId = def?.id ?? null;
        } catch (err) {
          coreLogger.debug({ err, userId }, 'No default workspace available for session tagging');
        }
        await sessionRepository.create({
          id: message.sessionId,
          userId,
          workspaceId: workspaceId ?? undefined,
          channelType: context.clientType,
          channelId: message.sessionId,
          title: `${context.clientType} conversation`,
          status: 'active',
          context: {
            devMode: true,
            projectPath: message.projectPath,
            projectName: message.projectPath.split(/[/\\]/).pop() || 'project',
          },
        });
        coreLogger.info({ sessionId: message.sessionId, projectPath: message.projectPath, workspaceId }, 'Pre-created session with dev-mode project context');
      }
    }

    // Route through root agent
    // Use expert from message, connection metadata, or session DB (set via /expert command)
    let expertId = message.expertId || (context.metadata?.activeExpertId as string | undefined);
    if (!expertId && message.sessionId) {
      try {
        const { sessionRepository } = await import('@/db/repositories/session-repository');
        const session = await sessionRepository.findById(message.sessionId);
        const sessionCtx = session?.context as Record<string, unknown> | undefined;
        if (sessionCtx?.activeExpertId) {
          expertId = sessionCtx.activeExpertId as string;
        }
      } catch { /* ignore — no expert override */ }
    }
    const result = await rootAgent.handleMessage(
      message.sessionId,
      userId,
      message.content,
      context.clientType,
      expertId,
      message.fileRefs,
      message.outputMode,
    );

    // Send response back through gateway
    hub.publishEvent({
      type: 'chat.response',
      source: 'rootAgent',
      userId: context.userId,
      sessionId: message.sessionId,
      payload: { response: result },
    });
  } catch (err) {
    coreLogger.error({ err, connectionId, userId: context.userId }, 'Chat send error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'CHAT_ERROR',
      message: (err as Error).message,
    });
  }
}

/**
 * Side-channel rate limiter. Interject bypasses the root agent queue
 * and triggers an LLM call directly, so it needs its own brake. Per-session
 * sliding window: at most INTERJECT_MAX hits in INTERJECT_WINDOW_MS.
 */
const INTERJECT_WINDOW_MS = 10_000;
const INTERJECT_MAX = 5;
const interjectHits = new Map<string, number[]>();

function allowInterject(sessionId: string): boolean {
  const now = Date.now();
  const cutoff = now - INTERJECT_WINDOW_MS;
  const history = (interjectHits.get(sessionId) ?? []).filter((t) => t > cutoff);
  if (history.length >= INTERJECT_MAX) {
    interjectHits.set(sessionId, history);
    return false;
  }
  history.push(now);
  interjectHits.set(sessionId, history);
  return true;
}

/**
 * Side-channel chat message — does NOT go through the root agent
 * queue. Routes directly through the persona-aware direct-response
 * path so the user can ask a quick question while a swarm is
 * running. Reply is prefixed with the persona's name and "side
 * question:" so the user can tell it apart from the main thread.
 */
async function handleChatInterject(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'chat.interject' }>,
): Promise<void> {
  try {
    if (!allowInterject(message.sessionId)) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'INTERJECT_RATE_LIMITED',
        message: `Interject rate limit hit (${INTERJECT_MAX} per ${INTERJECT_WINDOW_MS / 1000}s). Slow down.`,
      });
      return;
    }

    const userId = await resolveUserId(context.userId);
    context.sessionId = message.sessionId;

    const { directResponse } = await import('@/core/agent/direct-response');
    const { ModelSelector } = await import('@/core/agent/model-selector');
    const { resolvePersonaForUser } = await import('@/core/personas/resolver');

    const persona = await resolvePersonaForUser(userId).catch(() => null);
    const personaName = persona?.name || 'Octipus';
    const selector = new ModelSelector();

    let reply: string;
    try {
      const result = await directResponse(
        message.content,
        message.sessionId,
        userId,
        selector,
        'simple',
      );
      reply = `${personaName} — side question: ${result.response}`;
    } catch (err) {
      reply = `${personaName} — side question: ${(err as Error).message}`;
    }

    hub.publishEvent({
      type: 'chat.message',
      source: `interject:${connectionId}`,
      userId,
      sessionId: message.sessionId,
      payload: {
        role: 'assistant',
        content: reply,
        sideChannel: true,
      },
    });
  } catch (err) {
    coreLogger.error({ err, sessionId: message.sessionId }, 'chat.interject failed');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'INTERJECT_ERROR',
      message: (err as Error).message,
    });
  }
}

async function handleCommand(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'command' }>,
): Promise<void> {
  const registry = getCommandRegistry();
  const input = `/${message.name}${message.args ? ' ' + Object.values(message.args).join(' ') : ''}`;

  const result = await registry.execute(input, {
    userId: context.userId,
    sessionId: context.sessionId,
    clientType: context.clientType,
    trustLevel: context.trustLevel,
    metadata: context.metadata,
  });

  hub.connectionManager.sendToConnection(connectionId, {
    type: 'command.result',
    name: message.name,
    result: result?.text || null,
    error: result ? undefined : 'Unknown command',
  });
}

async function handlePermissionRespond(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'permission.respond' }>,
): Promise<void> {
  try {
    const { getPermissionManager } = await import('@/security/permissions');
    const permissionManager = getPermissionManager();

    if (message.approved) {
      await permissionManager.approve(message.requestId, context.userId);
    } else {
      await permissionManager.deny(message.requestId, context.userId);
    }
  } catch (err) {
    coreLogger.error({ err, connectionId, requestId: message.requestId }, 'Permission respond error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'PERMISSION_ERROR',
      message: (err as Error).message,
    });
  }
}

async function handleApprovalRespond(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'approval.respond' }>,
): Promise<void> {
  try {
    const { getAgentService } = await import('@/core/agent');
    const rootAgent = getAgentService();

    rootAgent.resolveApproval(message.requestId, message.approved, message.response);
  } catch (err) {
    coreLogger.error({ err, connectionId, requestId: message.requestId }, 'Approval respond error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'APPROVAL_ERROR',
      message: (err as Error).message,
    });
  }
}

/**
 * Explicit mid-run steer. Injects into the running root agent turn; if none
 * is running for the session, falls back to treating it as a normal chat.send
 * so a steer is always safe to fire.
 */
async function handleChatSteer(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'chat.steer' }>,
): Promise<void> {
  try {
    context.sessionId = message.sessionId;
    const userId = await resolveUserId(context.userId);

    if (await trySteerRunningRootAgent(message.sessionId, message.content)) {
      hub.publishEvent({
        type: 'chat.message',
        source: `steer:${connectionId}`,
        userId,
        sessionId: message.sessionId,
        payload: { role: 'user', content: message.content, injected: true },
      });
      return;
    }

    // Nothing running — behave like a normal send.
    await handleChatSend(hub, connectionId, context, {
      type: 'chat.send',
      sessionId: message.sessionId,
      content: message.content,
    });
  } catch (err) {
    coreLogger.error({ err, sessionId: message.sessionId }, 'chat.steer failed');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'STEER_ERROR',
      message: (err as Error).message,
    });
  }
}

async function handleAgentStop(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'agent.stop' }>,
): Promise<void> {
  // Only admin/local trust can stop agents
  if (context.trustLevel !== 'local' && context.trustLevel !== 'system' && !(context.metadata as any)?.isAdmin) {
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'FORBIDDEN',
      message: 'Insufficient permissions to stop agents',
    });
    return;
  }

  try {
    const { getAgentManager } = await import('@/core/agent-manager');
    const agentManager = getAgentManager();
    agentManager.stop(message.agentId);

    hub.publishEvent({
      type: 'agent.stopped',
      source: `user:${context.userId}`,
      userId: context.userId,
      payload: { agentId: message.agentId, stoppedBy: context.userId },
    });
  } catch (err) {
    coreLogger.error({ err, connectionId, agentId: message.agentId }, 'Agent stop error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'AGENT_STOP_ERROR',
      message: (err as Error).message,
    });
  }
}
