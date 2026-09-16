import type { CompletionResult } from './litellm-client';

/** Token budget proxy: uncached input + cache writes + output.
 * Cache writes are paid input, never free. Reads are separately reported and
 * priced by the cost tracker; this token cap is not a monetary spend limit. */
export function billableTokens(usage: CompletionResult['usage']): number {
  return Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0)) + usage.outputTokens;
}
