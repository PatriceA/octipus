import { z } from 'zod';
import { type DecisionAnswer, type DecisionAnswers, type DecisionQuestion, type DecisionRequest, validateAnswers } from './decision';
import { withTimeoutSignal } from './providers/http-retry';
import { recordProviderUsage } from './providers/instrumented';
import { normalizeUsage } from './providers/usage';

const probability = z.number().min(0).max(1);
const ROUNDING_TOLERANCE = 0.001;
const distribution = z.record(z.string(), probability);
const choice = z.object({ type: z.literal('choice').optional(), choice: z.string(), probabilities: distribution, confidence: probability });
const score = z.object({ type: z.literal('score').optional(), score: z.number(), probabilities: distribution, confidence: probability });
const noul = z.union([probability, z.object({ type: z.literal('noul').optional(), noul: probability })]);
const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).optional(),
});
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: z.string().min(1), criteria: z.object({ true: z.string(), false: z.string() }).optional() }),
  z.object({ type: z.literal('choice'), instructions: z.string().min(1), criteria: z.record(z.string(), z.string()).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 255) }),
  z.object({ type: z.literal('score'), instructions: z.string().min(1), criteria: z.array(z.string()).min(2).max(10) }),
]);

/** Normalize native SystemOne answers and reject incomplete or invalid distributions. */
export function normalizeSystemOneAnswer(q: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (q.type === 'noul') {
    const value = noul.parse(raw);
    const p = typeof value === 'number' ? value : value.noul;
    return { type: 'noul', p, confidence: Math.max(p, 1 - p) };
  }
  const parsed = q.type === 'choice' ? choice.parse(raw) : score.parse(raw);
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const probabilities = parsed.probabilities;
  if (Object.keys(probabilities).length !== keys.length || keys.some(k => !Object.hasOwn(probabilities, k))) {
    throw new Error('SystemOne probability keys do not match the question criteria');
  }
  if (Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > ROUNDING_TOLERANCE) {
    throw new Error('SystemOne probabilities do not sum to 1');
  }
  const answer: DecisionAnswer = 'choice' in parsed ? { ...parsed, type: 'choice' } : { ...parsed, type: 'score' };
  const invalid = validateAnswers({ answer: q }, { answer });
  if (invalid) throw new Error(`SystemOne ${invalid}`);
  if (answer.type === 'choice') {
    if (Math.max(...Object.values(probabilities)) - probabilities[answer.choice] > ROUNDING_TOLERANCE) {
      throw new Error('SystemOne choice does not have maximal probability');
    }
  } else if (answer.type === 'score') {
    const expected = keys.reduce((sum, key, i) => sum + i * probabilities[key], 0);
    if (Math.abs(answer.score - expected) > ROUNDING_TOLERANCE) {
      throw new Error('SystemOne score does not match its probability-weighted level');
    }
  }
  return answer;
}

/** One native request per question preserves independent-question semantics even on Clef. */
export async function systemOneDecide(url: string, headers: Record<string, string>, req: DecisionRequest, fetchImpl: typeof fetch = fetch): Promise<DecisionAnswers> {
  const questions = z.record(z.string(), questionSchema).parse(req.questions);
  const answers: DecisionAnswers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice' && Object.keys(q.criteria).length === 1) {
      // A closed choice with one allowed option is certain without inference.
      // Do not send it to servers that require at least two options.
      const [only] = Object.keys(q.criteria);
      answers[id] = { type: 'choice', choice: only, probabilities: { [only]: 1 }, confidence: 1 };
      continue;
    }
    const response = await fetchImpl(url, {
      method: 'POST', headers, redirect: 'error', signal: withTimeoutSignal(120_000),
      body: JSON.stringify({ model: req.model, state: req.state, questions: { [id]: q } }),
    });
    // Do not include the upstream body: it may echo private state or credentials.
    if (!response.ok) throw new Error(`SystemOne decide HTTP ${response.status}`);
    const body = responseSchema.parse(await response.json());
    if (!Object.hasOwn(body.answers, id)) throw new Error(`SystemOne missing answer for '${id}'`);
    answers[id] = normalizeSystemOneAnswer(q, body.answers[id]);
    await recordProviderUsage({ model: req.model, modelConfigName: req.modelConfigName, messages: [], requestType: 'decision' }, 'custom-openai', {
      model: req.model, usage: normalizeUsage(body.usage),
    });
  }
  return answers;
}
