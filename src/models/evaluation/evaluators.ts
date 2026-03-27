import { getModelRegistry } from '@/models/model-registry';
import { getLiteLLMClient } from '@/models/litellm-client';
import type { EvalDataPoint, EvalScore, Evaluator } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreStatus(score: number): 'PASS' | 'FAIL' {
  return score >= 0.7 ? 'PASS' : 'FAIL';
}

/**
 * Factory for creating evaluators with a consistent shape.
 */
export function defineEvaluator(
  name: string,
  description: string,
  fn: (dataPoint: EvalDataPoint) => Promise<EvalScore>,
): Evaluator {
  return {
    name,
    description,
    evaluate: async (dp: EvalDataPoint) => {
      // Empty or error output is an automatic 0 — don't waste judge tokens
      if (!dp.output || dp.output.startsWith('[Error')) {
        return { metric: name, score: 0, status: 'FAIL' as const, reasoning: 'No model output' };
      }
      const result = await fn(dp);
      // Ensure metric name is always set
      return { ...result, metric: result.metric || name };
    },
  };
}

/**
 * Shared LLM-as-judge helper.
 * Routes through the provider router (same path as all other completions)
 * so it works with direct providers, not just LiteLLM.
 * Uses the 'evaluation' topic model or the default model.
 */
async function llmJudge(prompt: string): Promise<{ score: number; reasoning: string }> {
  const registry = getModelRegistry();
  const judgeModel = await registry.getModelForTopic('evaluation')
    ?? await registry.getDefaultModel();
  if (!judgeModel) {
    return { score: 0.5, reasoning: 'No model configured for evaluation' };
  }

  // Call provider directly — bypasses circuit breaker.
  // Direct providers first, LiteLLM proxy as fallback.
  const { getProviderRouter } = await import('@/models/providers');
  const router = getProviderRouter();
  const resolvedProvider = await router.resolveProvider(judgeModel.modelId);
  const client = getLiteLLMClient();

  const callModel = async (opts: import('@/models/litellm-client').CompletionOptions) => {
    // Route based on DB-configured provider — not heuristic name matching
    if (judgeModel.provider !== 'litellm') {
      return resolvedProvider.complete(opts);
    }
    return client.completeViaProxy(opts);
  };

  const judgeMessages = [
    {
      role: 'system' as const,
      content:
        'You are an evaluation judge. Rate the following on a scale of 0-10. ' +
        'Respond with ONLY a JSON object: {"score": N, "reasoning": "brief explanation"}',
      timestamp: new Date(),
    },
    {
      role: 'user' as const,
      content: prompt,
      timestamp: new Date(),
    },
  ];

  let result;
  try {
    // First attempt with thinking enabled
    result = await callModel({
      model: judgeModel.modelId,
      temperature: 0.1,
      maxTokens: 1024,
      extraBody: { ...judgeModel.metadata?.extraBody, think: true },
      messages: judgeMessages,
    });

    // If response is empty (thinking consumed all tokens), retry without thinking
    if (!result.content?.trim()) {
      result = await callModel({
        model: judgeModel.modelId,
        temperature: 0.1,
        maxTokens: 256,
        extraBody: { ...judgeModel.metadata?.extraBody, think: false },
        messages: judgeMessages,
      });
    }
  } catch (err) {
    return { score: 0, reasoning: `Evaluator error: ${(err as Error).message?.slice(0, 200)}` };
  }

  // Strip thinking tags and markdown fences before parsing
  let text = result.content.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const jsonMatch = text.match(/\{[\s\S]*?"score"\s*:\s*(\d+(?:\.\d+)?)[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: Math.min(10, Math.max(0, Number(parsed.score))),
        reasoning: String(parsed.reasoning ?? ''),
      };
    } catch { /* fall through */ }
  }

  // Fallback: try to find a bare number
  const numMatch = text.match(/\b(\d+(?:\.\d+)?)\b/);
  if (numMatch) {
    const score = Math.min(10, Math.max(0, Number(numMatch[1])));
    return { score, reasoning: text.slice(0, 200) };
  }

  // No parseable score — return 0 with the raw output for debugging
  return { score: 0, reasoning: `Could not parse score from: ${text.slice(0, 200) || '(empty response)'}` };
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

const relevance = defineEvaluator(
  'relevance',
  'LLM-as-judge: rates how relevant the response is to the question',
  async (dp) => {
    const { score, reasoning } = await llmJudge(
      `Question: ${dp.input}\n\nResponse: ${dp.output}\n\nRate 0-10 how relevant this response is to the question.`,
    );
    const normalized = score / 10;
    return { metric: 'relevance', score: normalized, status: scoreStatus(normalized), reasoning };
  },
);

const faithfulness = defineEvaluator(
  'faithfulness',
  'LLM-as-judge: rates if the response is grounded in the provided context',
  async (dp) => {
    if (!dp.context?.length) {
      return {
        metric: 'faithfulness',
        score: -1,
        status: 'UNKNOWN' as const,
        reasoning: 'No context provided to evaluate faithfulness',
      };
    }

    const contextStr = dp.context.join('\n---\n');
    const { score, reasoning } = await llmJudge(
      `Context:\n${contextStr}\n\nQuestion: ${dp.input}\n\nResponse: ${dp.output}\n\n` +
      `Given this context, rate 0-10 if the response is grounded in the provided information.`,
    );
    const normalized = score / 10;
    return { metric: 'faithfulness', score: normalized, status: scoreStatus(normalized), reasoning };
  },
);

const coherence = defineEvaluator(
  'coherence',
  'LLM-as-judge: rates the coherence and logical structure of the response',
  async (dp) => {
    const { score, reasoning } = await llmJudge(
      `Response: ${dp.output}\n\nRate 0-10 the coherence and logical structure of this response.`,
    );
    const normalized = score / 10;
    return { metric: 'coherence', score: normalized, status: scoreStatus(normalized), reasoning };
  },
);

const formatCompliance = defineEvaluator(
  'format-compliance',
  'Programmatic check: validates output format matches expected format (JSON, bullets, etc.)',
  async (dp) => {
    if (!dp.reference) {
      return { metric: 'format-compliance', score: 1.0, status: 'PASS', reasoning: 'No format expectation defined' };
    }

    // Check if reference looks like JSON
    const refTrimmed = dp.reference.trim();
    if (
      (refTrimmed.startsWith('{') && refTrimmed.endsWith('}')) ||
      (refTrimmed.startsWith('[') && refTrimmed.endsWith(']'))
    ) {
      try {
        JSON.parse(dp.output.trim());
        return { metric: 'format-compliance', score: 1.0, status: 'PASS', reasoning: 'Output is valid JSON' };
      } catch {
        return { metric: 'format-compliance', score: 0.0, status: 'FAIL', reasoning: 'Expected JSON but output is not valid JSON' };
      }
    }

    // Check if reference starts with bullet points (-, *, or numbered)
    const bulletPattern = /^(\s*[-*•]\s|\s*\d+[.)]\s)/m;
    if (bulletPattern.test(refTrimmed)) {
      const hasBullets = bulletPattern.test(dp.output.trim());
      if (hasBullets) {
        return { metric: 'format-compliance', score: 1.0, status: 'PASS', reasoning: 'Output has bullet structure' };
      }
      return { metric: 'format-compliance', score: 0.3, status: 'FAIL', reasoning: 'Expected bullet structure but output lacks bullets' };
    }

    // No specific format expectation detected
    return { metric: 'format-compliance', score: 1.0, status: 'PASS', reasoning: 'No specific format requirement detected in reference' };
  },
);

const latency = defineEvaluator(
  'latency',
  'Programmatic check: scores based on response latency thresholds',
  async (dp) => {
    if (dp.latencyMs == null) {
      return { metric: 'latency', score: 0.5, status: 'UNKNOWN' as const, reasoning: 'No latency data available' };
    }

    const ms = dp.latencyMs;
    if (ms < 3_000) {
      return { metric: 'latency', score: 1.0, status: 'PASS', reasoning: `${ms}ms < 3s — excellent` };
    }
    if (ms <= 10_000) {
      return { metric: 'latency', score: 0.7, status: 'PASS', reasoning: `${ms}ms between 3-10s — acceptable` };
    }
    if (ms <= 30_000) {
      return { metric: 'latency', score: 0.4, status: 'FAIL', reasoning: `${ms}ms between 10-30s — slow` };
    }
    return { metric: 'latency', score: 0.0, status: 'FAIL', reasoning: `${ms}ms > 30s — too slow` };
  },
);

const toolAccuracy = defineEvaluator(
  'tool-accuracy',
  'Programmatic check: compares expected vs actual tool calls (name, arg keys, arg values)',
  async (dp) => {
    if (!dp.expectedToolCall) {
      return { metric: 'tool-accuracy', score: 0.5, status: 'UNKNOWN' as const, reasoning: 'No expected tool call defined' };
    }

    if (!dp.actualToolCall) {
      return { metric: 'tool-accuracy', score: 0.0, status: 'FAIL', reasoning: 'Expected a tool call but none was made' };
    }

    let score = 0;
    const reasons: string[] = [];

    // Correct tool name: 0.3
    if (dp.actualToolCall.name === dp.expectedToolCall.name) {
      score += 0.3;
      reasons.push('correct tool name');
    } else {
      reasons.push(`wrong tool: expected "${dp.expectedToolCall.name}", got "${dp.actualToolCall.name}"`);
    }

    // Correct argument keys: 0.3
    const expectedKeys = Object.keys(dp.expectedToolCall.args).sort();
    const actualKeys = Object.keys(dp.actualToolCall.args).sort();
    if (expectedKeys.length > 0) {
      const matchingKeys = expectedKeys.filter((k) => actualKeys.includes(k));
      const keyScore = matchingKeys.length / expectedKeys.length;
      score += 0.3 * keyScore;
      if (keyScore === 1) {
        reasons.push('all argument keys present');
      } else {
        reasons.push(`${matchingKeys.length}/${expectedKeys.length} argument keys match`);
      }
    } else {
      score += 0.3;
      reasons.push('no expected args to check');
    }

    // Correct argument values: 0.4
    if (expectedKeys.length > 0) {
      let matchingValues = 0;
      for (const key of expectedKeys) {
        if (
          key in dp.actualToolCall.args &&
          JSON.stringify(dp.actualToolCall.args[key]) === JSON.stringify(dp.expectedToolCall.args[key])
        ) {
          matchingValues++;
        }
      }
      const valScore = matchingValues / expectedKeys.length;
      score += 0.4 * valScore;
      if (valScore === 1) {
        reasons.push('all argument values correct');
      } else {
        reasons.push(`${matchingValues}/${expectedKeys.length} argument values correct`);
      }
    } else {
      score += 0.4;
      reasons.push('no expected arg values to check');
    }

    return { metric: 'tool-accuracy', score, status: scoreStatus(score), reasoning: reasons.join('; ') };
  },
);

const instructionFollowing = defineEvaluator(
  'instruction-following',
  'LLM-as-judge: rates how well the response follows system prompt and constraints',
  async (dp) => {
    if (!dp.systemPrompt && (!dp.constraints || dp.constraints.length === 0)) {
      return {
        metric: 'instruction-following',
        score: -1,
        status: 'UNKNOWN' as const,
        reasoning: 'No system prompt or constraints to evaluate against',
      };
    }

    const parts: string[] = [];
    if (dp.systemPrompt) parts.push(`The system prompt said: ${dp.systemPrompt}`);
    if (dp.constraints?.length) parts.push(`The constraints were: ${dp.constraints.join(', ')}`);

    const { score, reasoning } = await llmJudge(
      `${parts.join('\n')}\n\nUser question: ${dp.input}\n\nResponse: ${dp.output}\n\n` +
      `Rate 0-10 how well the response follows these instructions.`,
    );
    const normalized = score / 10;
    return { metric: 'instruction-following', score: normalized, status: scoreStatus(normalized), reasoning };
  },
);

const completeness = defineEvaluator(
  'completeness',
  'LLM-as-judge: rates how completely the response addresses all parts of the question',
  async (dp) => {
    const { score, reasoning } = await llmJudge(
      `Question: ${dp.input}\n\nResponse: ${dp.output}\n\n` +
      `Rate 0-10 how completely this response addresses all parts of the question. Does it answer everything asked, or is it partial/lazy?`,
    );
    const normalized = score / 10;
    return { metric: 'completeness', score: normalized, status: scoreStatus(normalized), reasoning };
  },
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ALL_EVALUATORS: Evaluator[] = [
  relevance,
  faithfulness,
  coherence,
  formatCompliance,
  latency,
  toolAccuracy,
  instructionFollowing,
  completeness,
];
