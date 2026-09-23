/**
 * Decision models ("System One" models, e.g. TypeSafe Jev): typed questions
 * against a state, calibrated probabilities back, no generated text.
 *
 * Call sites are hard-wired code, never an LLM tool: build state + questions,
 * call `decide()`, branch on the answer. `null` means "no usable decision" —
 * the caller runs its existing LLM path. See docs/plans/decision-models.md.
 */
import type { ModelConfigEntry } from '@/db/schema/models';
import { modelLogger } from '@/utils/logger';

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  /** option name → description; ≤255 options, include an 'other'/'none' escape. */
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  /** ordered lowest → highest, 2–10 levels, written as concrete situations. */
  | { type: 'score'; instructions: string; criteria: string[] };

/** `confidence` is always set: the provider's own value, else the top probability. */
export type DecisionAnswer =
  | { type: 'noul'; p: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

export type DecisionAnswers = Record<string, DecisionAnswer>;

export interface DecisionRequest {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  /** Ask the route for zero data retention (only meaningful on a gateway that supports it). */
  zeroDataRetention: boolean;
}

export type Sensitivity = 'public' | 'personal' | 'secret';

export interface DecisionSite {
  /** Stable id for logs and evals, e.g. 'email.triage'. */
  id: string;
  sensitivity: Sensitivity;
  /** Every answer must reach this confidence, else the site falls back. */
  minConfidence: number;
}

export interface DataPolicy {
  hosting: 'local' | 'remote';
  retention: 'none' | 'provider';
  trainsOnInput: boolean;
}

/** Unknown remote = worst case. */
const WORST_CASE: DataPolicy = { hosting: 'remote', retention: 'provider', trainsOnInput: true };

/**
 * Effective data policy of a model row. An explicit `metadata.dataPolicy`
 * wins; ollama is local; anything else is treated as the worst case.
 * `zdrRoute` = the route can enforce ZDR per request (Vercel AI Gateway).
 */
export function resolveDataPolicy(model: Pick<ModelConfigEntry, 'provider' | 'modelId' | 'metadata'>): DataPolicy & { zdrRoute: boolean } {
  const zdrRoute = model.provider === 'typesafe' && isGatewayModelId(model.modelId);
  const explicit = model.metadata?.dataPolicy;
  if (explicit) return { ...explicit, zdrRoute };
  if (model.provider === 'ollama') return { hosting: 'local', retention: 'none', trainsOnInput: false, zdrRoute };
  // TypeSafe's privacy policy: no training on input, retention "as long as reasonably necessary".
  if (model.provider === 'typesafe') return { hosting: 'remote', retention: 'provider', trainsOnInput: false, zdrRoute };
  return { ...WORST_CASE, zdrRoute };
}

/** Gateway model ids are namespaced (`typesafe-ai/jev`); direct TypeSafe ids are not (`jev-1.13.0`). */
export function isGatewayModelId(modelId: string): boolean {
  return modelId.includes('/');
}

export type GateVerdict =
  | { allowed: false; reason: string }
  | { allowed: true; zeroDataRetention: boolean; redactPII: boolean };

/**
 * The privacy gate. Pure; every decision call routes through it.
 *   public   → anywhere
 *   personal → local; remote only with ZDR (enforced or per-request) or the
 *              owner's explicit opt-in; never to a model that trains on input;
 *              PII-filtered whenever it leaves the machine
 *   secret   → local only
 */
export function gateDecision(sensitivity: Sensitivity, policy: DataPolicy & { zdrRoute: boolean }, allowRetainedPersonalData = false): GateVerdict {
  if (policy.hosting === 'local') return { allowed: true, zeroDataRetention: false, redactPII: false };
  if (sensitivity === 'public') return { allowed: true, zeroDataRetention: false, redactPII: false };
  if (sensitivity === 'secret') return { allowed: false, reason: 'secret data never leaves the machine' };
  if (policy.trainsOnInput) return { allowed: false, reason: 'model provider may train on input' };
  if (policy.retention === 'none') return { allowed: true, zeroDataRetention: false, redactPII: true };
  if (policy.zdrRoute) return { allowed: true, zeroDataRetention: true, redactPII: true };
  if (allowRetainedPersonalData) return { allowed: true, zeroDataRetention: false, redactPII: true };
  return { allowed: false, reason: 'provider retains input and allowRetainedPersonalData is off' };
}

const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Check a provider's normalized answers against the questions asked. Returns
 * the first violation, or null when every question got a well-formed answer.
 */
export function validateAnswers(questions: Record<string, DecisionQuestion>, answers: DecisionAnswers): string | null {
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key];
    if (!a) return `missing answer for '${key}'`;
    if (a.type !== q.type) return `'${key}': expected ${q.type}, got ${a.type}`;
    if (!isProb(a.confidence)) return `'${key}': confidence out of range`;
    if (a.type === 'noul' && !isProb(a.p)) return `'${key}': probability out of range`;
    if (a.type === 'choice' && q.type === 'choice' && !Object.hasOwn(q.criteria, a.choice)) return `'${key}': choice '${a.choice}' is not an option`;
    if (a.type === 'score' && q.type === 'score' && !(Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1)) return `'${key}': score out of range`;
  }
  return null;
}

/** Apply `fn` to every string inside a JSON-like value, keeping its shape. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/**
 * Ask the model bound to the `decision` topic. Returns null — and the caller
 * falls back to its LLM path — when nothing is bound, the privacy gate
 * refuses, the call fails, the answer is malformed, or any answer is below
 * `site.minConfidence`. Every non-trivial null is logged with its reason.
 */
export async function decide(site: DecisionSite, state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecisionAnswers | null> {
  const { getModelRegistry } = await import('@/models/model-registry');
  const model = await getModelRegistry().getModelForTopic('decision');
  if (!model) return null; // optional feature: unbound is the normal case

  const { getProviderRouter } = await import('@/models/providers');
  const provider = getProviderRouter().getProviderByName(model.provider);
  if (!provider?.decide) {
    modelLogger.warn({ site: site.id, model: model.name, provider: model.provider }, 'Decision topic bound to a provider without decide(); falling back');
    return null;
  }

  const verdict = gateDecision(site.sensitivity, resolveDataPolicy(model), model.metadata?.allowRetainedPersonalData);
  if (!verdict.allowed) {
    modelLogger.info({ site: site.id, model: model.name, reason: verdict.reason }, 'Decision blocked by privacy gate; falling back');
    return null;
  }
  if (verdict.redactPII) {
    const { filterPII } = await import('@/core/agent/pii-filter');
    state = mapStrings(state, (s) => filterPII(s).filtered);
  }

  const start = Date.now();
  let answers: DecisionAnswers;
  try {
    const { withProviderUsageContext } = await import('@/models/providers/instrumented');
    answers = await withProviderUsageContext({ modelConfigName: model.name, accountingMetadata: { decisionSite: site.id } }, () =>
      provider.decide!({ model: model.modelId, state, questions, zeroDataRetention: verdict.zeroDataRetention }));
  } catch (err) {
    modelLogger.warn({ err, site: site.id, model: model.name }, 'Decision call failed; falling back');
    return null;
  }

  const invalid = validateAnswers(questions, answers);
  if (invalid) {
    modelLogger.error({ site: site.id, model: model.name, invalid }, 'Decision answer violates the question schema; falling back');
    return null;
  }

  const minConfidence = Math.min(...Object.values(answers).map((a) => a.confidence));
  const confident = minConfidence >= site.minConfidence;
  modelLogger.info({ site: site.id, model: model.name, latencyMs: Date.now() - start, minConfidence, confident, zdr: verdict.zeroDataRetention }, 'Decision');
  return confident ? answers : null;
}
