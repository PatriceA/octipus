import { registerCommand } from './registry';

registerCommand({
  name: 'cost',
  description: 'Show token usage and cost for this session',
  async execute(ctx) {
    try {
      const { getCostTracker } = await import('@/models/cost-tracker');
      const costTracker = getCostTracker();
      const usage = await costTracker.getSessionStats(ctx.sessionId);
      const { formatUsageSummary } = await import('@/models/usage-summary');
      return { response: formatUsageSummary(usage) };
    } catch {
      return { response: 'Token usage tracking not available.' };
    }
  },
});
