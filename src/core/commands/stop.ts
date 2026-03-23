import { registerCommand } from './registry';
import { getAgentManager } from '@/core/agent-manager';

registerCommand({
  name: 'stop',
  description: 'Stop all running agents in this session',
  async execute(ctx) {
    const agentManager = getAgentManager();
    const count = agentManager.stopSession(ctx.sessionId);
    return {
      response: count > 0
        ? `Stopped ${count} running agent${count > 1 ? 's' : ''}.`
        : 'No running agents in this session.',
    };
  },
});
