import { registerCommand } from './registry';
import { getAgentManager } from '@/core/agent-manager';

registerCommand({
  name: 'status',
  description: 'Show running agents and session info',
  async execute(ctx) {
    const agentManager = getAgentManager();
    const agents = agentManager.getBySession(ctx.sessionId);
    const running = agents.filter(a => a.getStatus() === 'running');
    const completed = agents.filter(a => a.getStatus() === 'completed');
    const failed = agents.filter(a => a.getStatus() === 'failed');
    return {
      response: [
        '**Session Status**\n',
        `Session: \`${ctx.sessionId.slice(0, 8)}...\``,
        `Agents: ${running.length} running, ${completed.length} completed, ${failed.length} failed`,
        ...(running.length > 0
          ? ['\n**Running:**', ...running.map(a => {
              const c = a.getContext();
              return `- ${c.role} (${c.model}) — iteration ${a.getIteration()}`;
            })]
          : []),
      ].join('\n'),
    };
  },
});
