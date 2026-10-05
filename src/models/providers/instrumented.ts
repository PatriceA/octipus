import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider } from './interface';
import { modelLogger } from '@/utils/logger';
import { applyProviderSettings } from '../provider-options';

export type ProviderUsageContext = Pick<CompletionOptions, 'userId' | 'sessionId' | 'agentId' | 'modelConfigName' | 'accountingMetadata' | 'workspaceId' | 'funding'>;
const usageContext = new AsyncLocalStorage<ProviderUsageContext>();
export function withProviderUsageContext<T>(context: ProviderUsageContext, run: () => T): T {
  return usageContext.run({ ...usageContext.getStore(), ...context }, run);
}

/**
 * Run an install-topic call (memory extraction and judging, learning,
 * toolshim, link resolver, weekly review, chunk summaries, evaluators,
 * embeddings, document processing, decision models, compaction, the listen
 * gate probe): its `cost_log` rows say `install` whatever turn it runs in —
 * a sponsored turn's helpers included (coworking spec §9.1, D13). The rest
 * of the ambient context (user, session, workspace) is kept.
 */
export function withInstallUsage<T>(run: () => T): T {
  return withProviderUsageContext({ funding: 'install' }, run);
}

/**
 * Fill in the current usage context once a turn has resolved its scope
 * (`AgentService.handleMessage` opens the context before it knows the
 * session's workspace). Only this turn's context object changes: each
 * `withProviderUsageContext` run holds its own copy. Throws outside one.
 */
export function bindProviderUsageContext(fields: ProviderUsageContext): void {
  const store = usageContext.getStore();
  if (!store) throw new Error('No usage context to bind: run the turn inside withProviderUsageContext');
  Object.assign(store, fields);
}

/**
 * Request types of install-topic calls (compaction, embeddings, memory
 * extraction, toolshim, decision, vision, ocr): stamped `funding: 'install'`
 * whatever turn they run in, so their `cost_log` rows are told apart from
 * the agent's own (D13). The rest of the ambient context (user, session,
 * workspace) is kept.
 */
const INSTALL_REQUEST_TYPES = new Set(['embedding', 'ocr', 'decision', 'vision', 'toolshim', 'compaction', 'memory_extraction']);

export const SYSTEM_USAGE_USER = '00000000-0000-0000-0000-000000000000';

async function prepare(options: CompletionOptions, provider: string): Promise<CompletionOptions> {
  options = { ...usageContext.getStore(), ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as CompletionOptions;
  let settings: import('@/shared/provider-settings').ProviderSettings | undefined;
  let row: import('@/db/schema/models').ModelConfigEntry | null = null;
  try {
    const { getModelRegistry } = await import('../model-registry');
    const registry = getModelRegistry();
    row = options.modelConfigName ? await registry.getModel(options.modelConfigName) : await registry.getModelByModelId(options.model, { userId: options.userId });
    settings = row?.metadata?.providerSettings;
  } catch (err) {
    modelLogger.warn({ err, provider }, 'Provider settings unavailable; using request options');
  }
  // A personal row (coworking spec §8.3) never reaches a provider without its
  // owner's key and endpoint: every direct provider is instrumented through
  // here, and one that found no `apiKey` would fall back to the install's env
  // key. resolveModelKey throws when the owner stored none.
  if (row?.ownerUserId) {
    const { resolveModelKey } = await import('../model-key');
    options = {
      ...options,
      modelConfigName: row.name,
      apiKey: options.apiKey ?? await resolveModelKey(row),
      endpoint: options.endpoint ?? row.endpoint ?? undefined,
    };
  }
  // Callers own extraBody: an omitted field may be an intentional safety override.
  return applyProviderSettings(options, provider, settings);
}

export async function recordProviderUsage(options: CompletionOptions, provider: string, result: Pick<CompletionResult, 'usage' | 'model' | 'requestId'>, incomplete = false) {
  options = { ...usageContext.getStore(), ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as CompletionOptions;
  try {
    const { getCostTracker } = await import('../cost-tracker');
    const attributed = !!options.userId && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(options.userId);
    await getCostTracker().logUsageWithCost(
      attributed ? options.userId! : SYSTEM_USAGE_USER,
      options.modelConfigName ?? options.model, result.usage.inputTokens, result.usage.outputTokens,
      { sessionId: options.sessionId, agentId: options.agentId, requestType: options.requestType ?? 'chat',
        workspaceId: options.workspaceId ?? null,
        funding: options.requestType && INSTALL_REQUEST_TYPES.has(options.requestType) ? 'install' : options.funding ?? 'own',
        cachedInputTokens: result.usage.cacheReadTokens, cacheCreationTokens: result.usage.cacheCreationTokens,
        reportedCost: result.usage.reportedCost, usageAvailable: result.usage.available !== false,
        provider, lookupByModelId: !options.modelConfigName, metadata: { ...options.accountingMetadata, provider, actualModel: result.model, requestId: result.requestId,
          reasoningTokens: result.usage.reasoningTokens, incomplete, unattributed: !attributed } },
    );
  } catch (err) {
    // A database outage must not replay a billable request or lose its answer.
    modelLogger.error({ err, provider, model: result.model }, 'Usage persistence failed');
  }
}


export async function accountCompletion(options: CompletionOptions, provider: string, run: (o: CompletionOptions) => Promise<CompletionResult>): Promise<CompletionResult> {
  if (options.accountingOwner) return run(options);
  const prepared = provider === 'cli' ? options : await prepare(options, provider);
  let observed: Pick<CompletionResult, 'usage' | 'model' | 'requestId'> | undefined;
  try {
    const result = await run({ ...prepared, accountingOwner: true, accountingResponse: value => { observed = value; } });
    await recordProviderUsage(prepared, provider, result);
    return result;
  } catch (err) {
    // Preserve a received/billable response even if decoding tool arguments fails.
    if (observed) await recordProviderUsage(prepared, provider, observed, true);
    throw err;
  }
}

export async function* accountStream(options: CompletionOptions, provider: string, run: (o: CompletionOptions) => AsyncGenerator<StreamChunk>): AsyncGenerator<StreamChunk> {
  const prepared = await prepare(options, provider);
  let usage: CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
  let model = options.model;
  let requestId: string | undefined;
  let completed = false;
  try {
    for await (const chunk of run({ ...prepared, accountingOwner: true })) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) model = chunk.model;
      if (chunk.requestId) requestId = chunk.requestId;
      yield chunk;
    }
    completed = true;
  } finally {
    await recordProviderUsage(prepared, provider, { usage, model, requestId }, !completed);
  }
}

/** Instrument registered direct instances. LiteLLM instruments its wire methods
 * because evaluation callers intentionally bypass the provider router. */
export function instrumentProvider(provider: ModelProvider): ModelProvider {
  if (provider.type === 'litellm') return provider;
  const complete = provider.complete.bind(provider);
  const stream = provider.stream.bind(provider);
  provider.complete = options => accountCompletion(options, provider.name, complete);
  // CLI stream delegates to this.complete; let that one boundary own the row.
  if (provider.type !== 'cli') provider.stream = options => accountStream(options, provider.name, stream);
  return provider;
}
