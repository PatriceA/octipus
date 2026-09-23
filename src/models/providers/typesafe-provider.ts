import { recordProviderUsage } from './instrumented';
import { normalizeUsage } from './usage';
import { classifyError, ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import { coreLogger, modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';
import { fetchWithRetryAfter, withTimeoutSignal } from './http-retry';
import { isGatewayModelId, type DecisionAnswer, type DecisionAnswers, type DecisionQuestion, type DecisionRequest } from '../decision';

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';

/**
 * TypeSafe Jev, a decision ("System One") model — decide() only, no chat.
 *
 * Two routes, picked by the model id:
 *   - `jev-1.13.0`, `jev-latest`, …  → TypeSafe direct (`typesafe_api_key`).
 *     Input is retained per TypeSafe's policy; ZDR needs an enterprise contract.
 *   - `typesafe-ai/jev`              → Vercel AI Gateway `/v1/evaluate`
 *     (`ai_gateway_api_key`), which can enforce zero data retention per request.
 * The gateway speaks `boolean`/`probability` where TypeSafe speaks `noul`/`noul`;
 * both are normalized to DecisionAnswer here.
 */
export class TypeSafeProvider implements ModelProvider {
  readonly name = 'typesafe';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    return modelName.startsWith('jev-') || modelName.startsWith('typesafe-ai/');
  }

  private async getKey(gateway: boolean): Promise<string | null> {
    const [env, vaultName] = gateway ? ['AI_GATEWAY_API_KEY', 'ai_gateway_api_key'] : ['TYPESAFE_API_KEY', 'typesafe_api_key'];
    if (process.env[env]) return process.env[env]!;
    try {
      const { getVault } = await import('@/security/vault');
      return (await getVault().getByName('system', vaultName)) || null;
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, provider: this.name }, 'TypeSafe vault lookup failed');
      return null;
    }
  }

  async decide(req: DecisionRequest): Promise<DecisionAnswers> {
    const gateway = isGatewayModelId(req.model);
    if (req.zeroDataRetention && !gateway) {
      // Fail loud: the gate asked for ZDR on a route that cannot enforce it.
      throw new Error('zeroDataRetention requested on the direct TypeSafe route, which cannot enforce it');
    }
    const apiKey = await this.getKey(gateway);
    if (!apiKey) {
      throw new ClassifiedError({
        reason: FailoverReason.AUTH_FAILED,
        recovery: RecoveryAction.ROTATE_CREDENTIAL,
        message: gateway ? 'AI Gateway key not configured. Add ai_gateway_api_key in Secrets.' : 'TypeSafe key not configured. Add typesafe_api_key in Secrets.',
        providerHint: this.name,
      });
    }

    const questions = gateway ? toGatewayQuestions(req.questions) : req.questions;
    const body = {
      model: req.model,
      state: req.state,
      questions,
      ...(gateway && req.zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } } } : {}),
    };

    const response = await fetchWithRetryAfter(gateway ? GATEWAY_URL : TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeoutSignal(10_000),
    }, this.name);
    if (!response.ok) {
      throw classifyError({ status: response.status, message: await response.text() }, this.name);
    }

    const raw = await response.json() as { model?: string; answers?: Record<string, any>; usage?: Record<string, number>; providerMetadata?: { gateway?: { cost?: string } } };
    if (!raw?.answers || typeof raw.answers !== 'object') throw classifyError(new Error('TypeSafe returned no answers'), this.name);

    const u = raw.usage ?? {};
    const cost = Number(raw.providerMetadata?.gateway?.cost);
    await recordProviderUsage({ model: req.model, messages: [], requestType: 'decision' }, this.name, {
      model: raw.model || req.model,
      usage: normalizeUsage({ input_tokens: u.input_tokens ?? u.inputTokens, output_tokens: u.output_tokens ?? u.outputTokens, ...(Number.isFinite(cost) ? { cost } : {}) }),
    });
    modelLogger.debug({ model: req.model, gateway, zdr: req.zeroDataRetention }, 'TypeSafe decision');

    return Object.fromEntries(Object.entries(raw.answers).map(([k, a]) => [k, normalizeAnswer(a)]));
  }

  complete(_options: CompletionOptions): Promise<CompletionResult> {
    return Promise.reject(notChat(this.name));
  }

  // eslint-disable-next-line require-yield
  async *stream(_options: CompletionOptions): AsyncGenerator<StreamChunk> {
    throw notChat(this.name);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    // ponytail: key presence only — a live probe costs a request; add one if keys go stale unnoticed.
    const [direct, gateway] = await Promise.all([this.getKey(false), this.getKey(true)]);
    return direct || gateway ? { healthy: true } : { healthy: false, error: 'API key not configured' };
  }
}

function notChat(provider: string): ClassifiedError {
  return new ClassifiedError({
    reason: FailoverReason.ABORT_FATAL,
    recovery: RecoveryAction.ABORT,
    message: 'TypeSafe Jev is a decision model; it has no chat completions',
    providerHint: provider,
  });
}

/** The gateway's evaluate API names `noul` as `boolean`; everything else is shared. */
function toGatewayQuestions(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'noul' ? { ...q, type: 'boolean' } : q]));
}

const top = (probs: Record<string, number>) => Math.max(0, ...Object.values(probs));

/** Normalize either wire shape into a DecisionAnswer; validation happens in decide(). */
export function normalizeAnswer(a: any): DecisionAnswer {
  if (a?.type === 'noul' || a?.type === 'boolean') {
    const p = a.type === 'noul' ? a.noul : a.probability;
    return { type: 'noul', p, confidence: Math.max(p, 1 - p) };
  }
  const probabilities: Record<string, number> = a?.probabilities ?? {};
  const confidence = typeof a?.confidence === 'number' ? a.confidence : top(probabilities);
  if (a?.type === 'choice') return { type: 'choice', choice: a.choice, probabilities, confidence };
  return { type: 'score', score: a?.score, probabilities, confidence };
}

/** True if either route has a key (env var or vault). */
export async function isTypeSafeConfigured(): Promise<boolean> {
  return (await new TypeSafeProvider().checkHealth()).healthy;
}

/** Static list for the add-model picker — neither route has a discovery endpoint we need. */
export const TYPESAFE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'typesafe-ai/jev', label: 'Jev via Vercel AI Gateway (zero data retention possible)' },
  { id: 'jev-1.13.0', label: 'Jev 1.13.0, TypeSafe direct (input retained)' },
  { id: 'jev-latest', label: 'Jev latest, TypeSafe direct (input retained)' },
];
