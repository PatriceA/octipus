import type { UsageStats } from './cost-tracker';

export function formatUsageSummary(usage: UsageStats): string {
  if (!usage.requestCount) return 'No token usage recorded for this session yet.';
  const total = usage.totalInputTokens + usage.totalOutputTokens;
  const cached = Number(usage.cacheReadTokens ?? 0);
  const ratio = usage.totalInputTokens ? 100 * cached / usage.totalInputTokens : 0;
  return [
    'Session usage:',
    `  Input: ${usage.totalInputTokens.toLocaleString()} tokens`,
    `  Output: ${usage.totalOutputTokens.toLocaleString()} tokens`,
    `  Total: ${total.toLocaleString()} tokens`,
    `  Requests: ${usage.requestCount}`,
    `  Cache reads: ${cached.toLocaleString()} tokens (${ratio.toFixed(1)}% of input)`,
    `  Cache writes: ${Number(usage.cacheCreationTokens ?? 0).toLocaleString()} tokens`,
    `  Estimated net cache savings: $${(usage.estimatedCacheSavings ?? 0).toFixed(4)} (known rates only)`,
    `  Provider-reported cost: $${(usage.reportedCost ?? 0).toFixed(4)}`,
    `  Estimated cost: $${(usage.estimatedCost ?? usage.totalCost).toFixed(4)}`,
    `  Missing token usage: ${usage.unknownUsageRequests ?? 0} requests`,
    `  Unknown cost: ${usage.unknownCostRequests ?? 0} requests`,
    '  Historical entries may use older estimates; provider billing remains authoritative.',
  ].join('\n');
}
