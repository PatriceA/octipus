import { registerCommand } from './registry';

registerCommand({
  name: 'cost',
  description: 'Show token usage and cost for this session',
  async execute(ctx) {
    try {
      const { getCostTracker } = await import('@/models/cost-tracker');
      const costTracker = getCostTracker();
      const usage = await costTracker.getSessionStats(ctx.sessionId);
      if (!usage || (usage.totalInputTokens === 0 && usage.totalOutputTokens === 0)) {
        return { response: 'No token usage recorded for this session yet.' };
      }
      const total = usage.totalInputTokens + usage.totalOutputTokens;
      let text = `📊 Session token usage:\n  Input: ${usage.totalInputTokens.toLocaleString()} tokens\n  Output: ${usage.totalOutputTokens.toLocaleString()} tokens\n  Total: ${total.toLocaleString()} tokens\n  Requests: ${usage.requestCount}`;
      if (usage.totalCost) {
        text += `\n  Cost: $${usage.totalCost.toFixed(4)}`;
      }
      return { response: text };
    } catch {
      return { response: 'Token usage tracking not available.' };
    }
  },
});
