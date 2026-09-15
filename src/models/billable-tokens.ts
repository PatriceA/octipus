import type { CompletionResult } from './litellm-client';

/**
 * Tokens that actually cost near full price: fresh input plus output.
 *
 * `inputTokens` is the grand total and includes cache reads, which bill at
 * roughly a tenth of the fresh rate. Budget gates and quotas are spend
 * proxies, so they compare this; context-fill meters are not, so they keep
 * using the grand total. Cache creation is excluded too — it is re-read
 * context, and counting it would make a well-cached session look expensive
 * exactly once per prefix.
 */
export function billableTokens(usage: CompletionResult['usage']): number {
  const fresh = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0));
  return fresh + usage.outputTokens;
}
