import { decodeChatAttachment, storeChatUploads } from '@/core/chat-uploads';
import { WorkspaceFS } from '@/security/workspace-fs';
import { resolveSession, turnWorkspaceId } from '@/core/agent/session-resolver';
import { isSessionControlMessage } from '@/core/session-controls';
import { coreLogger } from '@/utils/logger';
import { getCommandRegistry } from './commands';
import type { GatewayHub } from './hub';
import type { ClientMessage, ConnectionContext } from './protocol';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * May this connection use `sessionId`? Null when yes: the session is the
 * caller's own or does not exist yet (a fresh client id). Otherwise the
 * refusal text. One gate for every path that binds a connection to a session
 * (chat.send, chat.steer, chat.interject, command adoption) — before it, any
 * authenticated client could attach to another user's existing session by id
 * and read or extend it. It compares user ids and nothing else: no trust
 * level and no admin flag opens another user's session.
 */
export async function sessionAccessError(sessionId: string, context: Pick<ConnectionContext, 'userId'>): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null; // channel-style ids resolve per user inside resolveSession
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  return session && session.userId !== context.userId ? 'Session not found' : null;
}

/** Exported for unit tests. */
export async function trySteerRunningRootAgent(sessionId: string, content: string): Promise<boolean> {
  // Slash commands must reach the command registry, never become model guidance.
  if (content.trimStart().startsWith('/') || isSessionControlMessage(content)) return false;
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

    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: refused });
      return;
    }
    // Track the session on the connection for /status command
    context.sessionId = message.sessionId;

    const userId = context.userId;

    // If a root agent turn is already running for this session, steer it
    // with this message instead of spawning a concurrent turn. Keeps one live
    // root agent per session; the user can redirect work mid-flight.
    if (!message.attachments?.length && !message.fileRefs?.length && await trySteerRunningRootAgent(message.sessionId, message.content)) {
      hub.publishEvent({
        type: 'chat.message',
        source: `steer:${connectionId}`,
        userId,
        sessionId: message.sessionId,
        payload: { role: 'user', content: message.content, injected: true },
      });
      return;
    }

    // A new session is created in the send's workspace: the one the message
    // names, else the connection's (the TUI's `?workspace=`, resolved at
    // auth). Either must be the user's own (`turnWorkspaceId` checks); an
    // existing session keeps the workspace it was created in.
    const sendWorkspace = message.workspaceId ?? context.workspaceId;

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
        // see the row exists and skip its own create. Created in the
        // send's workspace so the session shows up only in that
        // workspace's session list.
        const workspaceId = await turnWorkspaceId(userId, sendWorkspace);
        await sessionRepository.create({
          id: message.sessionId,
          userId,
          workspaceId,
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

    await resolveSession(message.sessionId, userId, context.clientType, sendWorkspace);

    if (message.attachments?.length) {
      if (message.attachments.length + (message.fileRefs?.length ?? 0) > 10) throw new Error('Attach at most 10 files per message.');
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const session = await sessionRepository.findById(message.sessionId);
      if (!session || session.userId !== userId) throw new Error('Session not found');
      const uploaded = await storeChatUploads(WorkspaceFS.forSession(session), message.attachments.map(decodeChatAttachment));
      message.fileRefs = [...(message.fileRefs ?? []), ...uploaded.map(file => ({ path: file.path }))];
      message.content += '\n\n' + uploaded.map(file => `Attached file: ${file.path}`).join('\n');
    }

    // Route through root agent
    const result = await rootAgent.handleMessage(
      message.sessionId,
      userId,
      message.content,
      context.clientType,
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

    await publishSessionStats(hub, context.userId, message.sessionId);
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
 * Publish the session's authoritative usage after a turn: totals from the cost
 * log (which counts every child agent, not just the completions this client
 * happened to see) plus the last prompt's context fill. Best-effort — a stats
 * query must never fail the turn that produced the answer.
 */
async function publishSessionStats(hub: GatewayHub, userId: string, sessionId: string): Promise<void> {
  try {
    const [{ getCostTracker }, { getContextFill }] = await Promise.all([
      import('@/models/cost-tracker'),
      import('@/core/agent/prompt-budget'),
    ]);
    const usage = await getCostTracker().getSessionStats(sessionId);
    const fill = getContextFill(sessionId);
    hub.publishEvent({
      type: 'session.stats',
      source: 'rootAgent',
      userId,
      sessionId,
      payload: {
        totalTokens: usage.totalInputTokens + usage.totalOutputTokens,
        inputTokens: usage.totalInputTokens,
        outputTokens: usage.totalOutputTokens,
        totalCostUsd: usage.totalCost,
        requestCount: usage.requestCount,
        contextTokens: fill?.promptTokens,
        contextWindow: fill?.contextWindow,
      },
    });
  } catch (err) {
    coreLogger.debug({ err, sessionId }, 'session stats publish skipped');
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

    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: refused });
      return;
    }
    const userId = context.userId;
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

  // A client may point the connection at a session before its first chat.send
  // (resume). Only the owner's sessions; trusted consoles act for the admin.
  if (message.sessionId && message.sessionId !== context.sessionId) {
    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'command.result', name: message.name, result: null, error: refused });
      return;
    }
    context.sessionId = message.sessionId;
  }

  const result = await registry.execute(input, {
    userId: context.userId,
    sessionId: context.sessionId,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    clientType: context.clientType,
    trustLevel: context.trustLevel,
    metadata: context.metadata,
  });

  hub.connectionManager.sendToConnection(connectionId, {
    type: 'command.result',
    name: message.name,
    result: result?.text || null,
    error: result ? undefined : 'Unknown command',
    data: result?.data,
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
    // Only the requester answers: the manager matches the request's owner.
    // An admin answering someone else's request goes through the audited
    // POST /api/admin/permission-requests/:id/resolve, never through here.
    // An unresolved request is reported instead of swallowed.
    const resolved = message.approved
      ? await permissionManager.approve(message.requestId, context.userId)
      : await permissionManager.deny(message.requestId, context.userId);

    if (!resolved) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'PERMISSION_ERROR',
        message: 'That permission request is no longer pending (already answered, or expired).',
      });
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

    // Same rule as REST /chat/approve: only the requester answers. Admins
    // use the audited POST /api/admin/approvals/:id/resolve.
    const outcome = await rootAgent.resolveApprovalDetailed(
      message.requestId, message.approved, message.response,
      { forUserId: context.userId, resolvedBy: context.userId },
    );
    if ('message' in outcome) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'APPROVAL_EXPIRED',
        message: outcome.message,
      });
    }
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
    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: refused });
      return;
    }
    context.sessionId = message.sessionId;
    const userId = context.userId;

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
  try {
    const { getAgentManager } = await import('@/core/agent-manager');
    const agentManager = getAgentManager();
    // A connection stops its own user's agents only — the owner check compares
    // user ids, whatever the connection's admin flag. Unknown and foreign ids
    // get the same answer so ids cannot be probed.
    const agent = agentManager.get(message.agentId);
    if (!agent || agent.getContext().userId !== context.userId) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'AGENT_NOT_FOUND',
        message: 'Agent not found',
      });
      return;
    }
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
