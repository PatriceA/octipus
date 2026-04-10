export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

const DEFAULT_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
};

export interface ThinkingBudgetResult {
  maxTokens: number;
  thinkingBudget: number;
}

/**
 * Adjusts max_tokens to accommodate a thinking/reasoning budget.
 * Ensures minimum output tokens (1024) are always available.
 */
export function adjustMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  level: ThinkingLevel,
  customBudgets?: Partial<Record<ThinkingLevel, number>>,
): ThinkingBudgetResult {
  const budgets = { ...DEFAULT_BUDGETS, ...customBudgets };
  const thinkingBudget = budgets[level];
  const minOutputTokens = 1024;

  // Ensure we don't exceed model limits
  const totalNeeded = baseMaxTokens + thinkingBudget;
  const maxAllowed = modelMaxTokens - minOutputTokens;

  if (totalNeeded > maxAllowed) {
    // Scale down proportionally
    const scale = maxAllowed / totalNeeded;
    return {
      maxTokens: Math.floor(baseMaxTokens * scale) + Math.floor(thinkingBudget * scale),
      thinkingBudget: Math.floor(thinkingBudget * scale),
    };
  }

  return {
    maxTokens: totalNeeded,
    thinkingBudget,
  };
}

/** Check if a model supports extended thinking/reasoning. */
export function supportsThinking(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return lower.includes('o1') || lower.includes('o3') || lower.includes('o4') ||
    lower.includes('deepseek-r1') || lower.includes('reasoning') ||
    lower.includes('think');
}
