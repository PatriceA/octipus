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
 * Wire the gateway hub's message handler to route authenticated messages
 * to the appropriate backend services (orchestrator, permissions, agents).
 */
export function wireMessageHandler(hub: GatewayHub): void {
  hub.setMessageHandler(async (connectionId, context, message) => {
    switch (message.type) {
      case 'chat.send':
        await handleChatSend(hub, connectionId, context, message);
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
    const { getOrchestratorService } = await import('@/core/orchestrator');
    const orchestrator = getOrchestratorService();

    // Track the session on the connection for /status command
    context.sessionId = message.sessionId;

    // Set project context on the session if provided (enables dev mode)
    if (message.projectPath) {
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
      }
    }

    // Route through orchestrator
    const userId = await resolveUserId(context.userId);
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
    const result = await orchestrator.handleMessage(
      message.sessionId,
      userId,
      message.content,
      context.clientType,
      expertId,
    );

    // Send response back through gateway
    hub.publishEvent({
      type: 'chat.response',
      source: 'orchestrator',
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
    const { getOrchestratorService } = await import('@/core/orchestrator');
    const orchestrator = getOrchestratorService();

    orchestrator.resolveApproval(message.requestId, message.approved, message.response);
  } catch (err) {
    coreLogger.error({ err, connectionId, requestId: message.requestId }, 'Approval respond error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'APPROVAL_ERROR',
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
