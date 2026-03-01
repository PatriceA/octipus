import { getOrchestratorService, type OrchestratorEvent } from './service';
import { coreLogger } from '@/utils/logger';

/**
 * MessageDispatcher connects any message channel (web chat, Telegram, etc.)
 * to the OrchestratorService. It provides a unified entry point for all
 * incoming messages regardless of their source channel.
 */
export class MessageDispatcher {
  private channelHandlers: Map<string, (event: OrchestratorEvent) => void> = new Map();

  /**
   * Register a channel's event handler for receiving orchestrator events.
   * Returns an unsubscribe function.
   */
  registerChannel(
    channelId: string,
    handler: (event: OrchestratorEvent) => void,
  ): () => void {
    this.channelHandlers.set(channelId, handler);

    const orchestrator = getOrchestratorService();
    const unsubscribe = orchestrator.onEvent((event) => {
      handler(event);
    });

    coreLogger.info({ channelId }, 'Channel registered with dispatcher');

    return () => {
      this.channelHandlers.delete(channelId);
      unsubscribe();
      coreLogger.info({ channelId }, 'Channel unregistered from dispatcher');
    };
  }

  /**
   * Dispatch a message from any channel to the orchestrator.
   */
  async dispatch(
    sessionId: string,
    userId: string,
    message: string,
    channel?: string,
  ): Promise<{ response: string; agentId?: string }> {
    coreLogger.debug({ sessionId, userId, channel }, 'Dispatching message');

    const orchestrator = getOrchestratorService();
    const result = await orchestrator.handleMessage(sessionId, userId, message, channel);

    return {
      response: result.response,
      agentId: result.agentId,
    };
  }

  /**
   * Resolve a pending approval from a channel.
   */
  resolveApproval(requestId: string, approved: boolean, response?: string): boolean {
    const orchestrator = getOrchestratorService();
    return orchestrator.resolveApproval(requestId, approved, response);
  }
}

// Singleton
let instance: MessageDispatcher | null = null;

export function getMessageDispatcher(): MessageDispatcher {
  if (!instance) {
    instance = new MessageDispatcher();
  }
  return instance;
}
