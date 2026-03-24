import { registerCommand } from './registry';
import { getAgentManager } from '@/core/agent-manager';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m ${remainSec}s`;
}

registerCommand({
  name: 'status',
  description: 'Show running agents and session info',
  async execute(ctx) {
    const agentManager = getAgentManager();
    const agents = agentManager.getBySession(ctx.sessionId);
    const running = agents.filter(a => a.getStatus() === 'running');
    const completed = agents.filter(a => a.getStatus() === 'completed');
    const failed = agents.filter(a => a.getStatus() === 'failed');

    const lines: string[] = [
      '**Session Status**\n',
      `Session: \`${ctx.sessionId.slice(0, 8)}...\``,
      `Agents: ${running.length} running, ${completed.length} completed, ${failed.length} failed`,
    ];

    if (running.length > 0) {
      lines.push('\n**Running:**');
      for (const a of running) {
        const c = a.getContext();
        const elapsed = a.getElapsedMs();
        const tokens = a.getTotalTokens();
        const iter = a.getIteration();
        const parts = [`- **${c.role}** (${c.model})`];
        parts.push(`— iteration ${iter}`);
        if (elapsed > 0) parts.push(`| ${formatDuration(elapsed)}`);
        if (tokens > 0) parts.push(`| ${tokens.toLocaleString()} tokens`);
        lines.push(parts.join(' '));
      }
    }

    if (failed.length > 0) {
      lines.push('\n**Failed:**');
      for (const a of failed) {
        const c = a.getContext();
        lines.push(`- ${c.role} (${c.model})`);
      }
    }

    // Show plan state if relevant
    const session = await sessionRepository.findById(ctx.sessionId);
    const sessionCtx = (session?.context as SessionContext) || {};
    const planState = sessionCtx.planningState;
    if (planState) {
      lines.push('');
      if (planState.active) {
        lines.push(`**Plan:** In progress (step ${planState.step})`);
      } else if (planState.brief && !planState.executed) {
        lines.push('**Plan:** Ready — reply **go** to execute');
      } else if (planState.executed) {
        lines.push('**Plan:** Executing');
      }
    }

    if (running.length === 0 && completed.length === 0 && failed.length === 0 && !planState) {
      lines.push('\nNo active work in this session.');
    }

    return { response: lines.join('\n') };
  },
});
