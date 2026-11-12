import { getAgentManager } from '@/core/agent-manager';
import { cancelQueuedTurns } from '@/core/session-turn-lock';
import { registerCommand } from './registry';
import { recordCompanionOwnerStop } from '@/core/companion/user-control';
import { coreLogger } from '@/utils/logger';

/**
 * A stop's reply: what stopped, and how many of the caller's queued messages
 * were dropped. `none` is the text for nothing running (`/abort` stops across
 * sessions).
 */
export function stopReply(stopped: number, dropped: number, none = 'No running agents in this session'): string {
  const agents = stopped > 0 ? `Stopped ${stopped} running agent${stopped > 1 ? 's' : ''}` : none;
  if (!dropped) return `${agents}.`;
  return `${agents}; ${dropped} queued message${dropped > 1 ? 's' : ''} dropped.`;
}

registerCommand({
  name: 'stop',
  description: 'Stop all running agents in this session and drop your messages queued behind them',
  async execute(ctx) {
    const agentManager = getAgentManager();
    try { await recordCompanionOwnerStop(ctx.sessionId, ctx.userId); }
    catch (error) { coreLogger.error({ error, sessionId: ctx.sessionId }, 'Could not persist Companion owner stop'); }
    // Drop the waiting turns first, so none of them starts in the gap the
    // stopped turn leaves; each one's sender is told it was dropped. Only the
    // caller's messages and hook runs: other members' messages in a group
    // session, and monitor / companion wake-ups (redelivered by their own
    // services), stay queued.
    const dropped = cancelQueuedTurns(ctx.sessionId, { owner: ctx.userId });
    const count = agentManager.stopSession(ctx.sessionId, ctx.userId);
    return { response: stopReply(count, dropped) };
  },
});
