import { coreLogger } from '@/utils/logger';
import type { GatewayHub } from './hub';
import type { ConnectionContext, ClientMessage } from './protocol';
import { getCommandRegistry } from './commands';

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

    // Route through orchestrator (same as existing /ws chat handler)
    const result = await orchestrator.handleMessage(
      message.sessionId,
      context.userId,
      message.content,
      context.clientType,
      message.expertId,
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
