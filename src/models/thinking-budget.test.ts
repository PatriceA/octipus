import { describe, test, expect } from 'bun:test';
import {
  adjustMaxTokensForThinking,
  supportsThinking,
  type ThinkingLevel,
} from './thinking-budget';

describe('Thinking Budget', () => {
  describe('adjustMaxTokensForThinking', () => {
    test('returns correct budget for each level', () => {
      const levels: { level: ThinkingLevel; expected: number }[] = [
        { level: 'minimal', expected: 1024 },
        { level: 'low', expected: 4096 },
        { level: 'medium', expected: 8192 },
        { level: 'high', expected: 16384 },
      ];

      for (const { level, expected } of levels) {
        const result = adjustMaxTokensForThinking(4096, 200000, level);
        expect(result.thinkingBudget).toBe(expected);
      }
    });

    test('maxTokens equals baseMaxTokens + thinkingBudget when within limits', () => {
      const result = adjustMaxTokensForThinking(4096, 200000, 'medium');
      expect(result.maxTokens).toBe(4096 + 8192);
      expect(result.thinkingBudget).toBe(8192);
    });

    test('proportional scaling when total exceeds model limits', () => {
      // modelMaxTokens=10000, minOutput=1024, so maxAllowed=8976
      // baseMaxTokens=8000 + thinkingBudget(high)=16384 = 24384 > 8976
      const result = adjustMaxTokensForThinking(8000, 10000, 'high');
      const totalNeeded = 8000 + 16384;
      const maxAllowed = 10000 - 1024;
      const scale = maxAllowed / totalNeeded;

      expect(result.thinkingBudget).toBe(Math.floor(16384 * scale));
      expect(result.maxTokens).toBe(
        Math.floor(8000 * scale) + Math.floor(16384 * scale),
      );
      // Verify it stays within model limits
      expect(result.maxTokens).toBeLessThanOrEqual(maxAllowed);
    });

    test('custom budgets override defaults', () => {
      const result = adjustMaxTokensForThinking(4096, 200000, 'low', {
        low: 2048,
      });
      expect(result.thinkingBudget).toBe(2048);
      expect(result.maxTokens).toBe(4096 + 2048);
    });
  });

  describe('supportsThinking', () => {
    test('identifies reasoning models', () => {
      expect(supportsThinking('o1-preview')).toBe(true);
      expect(supportsThinking('o3-mini')).toBe(true);
      expect(supportsThinking('o4-mini')).toBe(true);
      expect(supportsThinking('deepseek-r1')).toBe(true);
      expect(supportsThinking('some-reasoning-model')).toBe(true);
      expect(supportsThinking('claude-3-think')).toBe(true);
    });

    test('returns false for non-reasoning models', () => {
      expect(supportsThinking('gpt-4')).toBe(false);
      expect(supportsThinking('claude-3-sonnet')).toBe(false);
      expect(supportsThinking('gpt-3.5-turbo')).toBe(false);
      expect(supportsThinking('llama-70b')).toBe(false);
    });

    test('case insensitive matching', () => {
      expect(supportsThinking('O1-Preview')).toBe(true);
      expect(supportsThinking('DeepSeek-R1')).toBe(true);
    });
  });
});
