import { getAgentManager } from '@/core/agent-manager';
import { registerCommand } from './registry';
import { recordCompanionOwnerStop } from '@/core/companion/user-control';
import { coreLogger } from '@/utils/logger';

registerCommand({
  name: 'stop',
  description: 'Stop all running agents in this session',
  async execute(ctx) {
    const agentManager = getAgentManager();
    try { await recordCompanionOwnerStop(ctx.sessionId, ctx.userId); }
    catch (error) { coreLogger.error({ error, sessionId: ctx.sessionId }, 'Could not persist Companion owner stop'); }
    const count = agentManager.stopSession(ctx.sessionId, ctx.userId);
    return {
      response: count > 0
        ? `Stopped ${count} running agent${count > 1 ? 's' : ''}.`
        : 'No running agents in this session.',
    };
  },
});
