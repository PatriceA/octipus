import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider } from './interface';
import { modelLogger } from '@/utils/logger';
import { applyProviderSettings } from '../provider-options';
import { type Pseudonyms, StreamRestorer } from '@/core/protection/pseudonymize';

export type ProviderUsageContext = Pick<CompletionOptions, 'userId' | 'sessionId' | 'agentId' | 'modelConfigName' | 'accountingMetadata' | 'workspaceId' | 'funding'>;
const usageContext = new AsyncLocalStorage<ProviderUsageContext>();
export function withProviderUsageContext<T>(context: ProviderUsageContext, run: () => T): T {
  return usageContext.run({ ...usageContext.getStore(), ...context }, run);
}

/**
 * The sponsor paying for the calls underneath (coworking spec §9.1): a
 * sponsored turn runs on the sponsor's own model rows, whose keys
 * `assertModelRowOwner` releases to it only while this says so. Kept apart
 * from the usage context, which is spread into provider options.
 */
const sponsorContext = new AsyncLocalStorage<{ userId: string; models: readonly string[] } | null>();
export function withSponsor<T>(sponsor: { userId: string; models: readonly string[] } | null, run: () => T): T {
  return sponsorContext.run(sponsor, run);
}
export function currentSponsor(): { userId: string; models: readonly string[] } | null {
  return sponsorContext.getStore() ?? null;
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
  // key. resolveModelKey throws when the owner stored none, and when the call
  // serves anyone but the row's owner — whatever key the caller brought.
  // Nor does an install row (or a raw model id on the install's env keys)
  // serve someone the install's models are not for (install-access.ts).
  await assertRowServesCall(row, options);
  // Level 3-4 content stays on local models (core/protection/routing.ts): a
  // call that would leave the house is refused here, before any provider.
  // Not inside the try above: a refusal is never "settings unavailable".
  const { assertMayLeave, PSEUDONYMIZED, pseudonymsFor } = await import('@/core/protection/routing');
  const hosted = row ?? { provider, modelId: options.model, endpoint: options.endpoint ?? null, metadata: null };
  await assertMayLeave(hosted, options.sessionId, provider, PSEUDONYMIZED);
  // Level 2-3 on a remote model: personal data leaves as placeholders (C6c),
  // translated back in accountCompletion / accountStream.
  const pseudonyms = await pseudonymsFor(hosted, options.sessionId, provider);
  if (pseudonyms) options = { ...options, messages: pseudonymizeMessages(options.messages, pseudonyms) };
  if (row?.ownerUserId) {
    const { assertModelRowOwner, resolveModelKey } = await import('../model-key');
    assertModelRowOwner(row, options.userId);
    options = {
      ...options,
      modelConfigName: row.name,
      apiKey: options.apiKey ?? await resolveModelKey(row, options.userId),
      endpoint: options.endpoint ?? row.endpoint ?? undefined,
    };
  }
  // Callers own extraBody: an omitted field may be an intentional safety override.
  const prepared = applyProviderSettings(options, provider, settings);
  if (pseudonyms) pseudonymized.set(prepared, pseudonyms);
  return prepared;
}

/** The mapping each prepared request went out with (C6c). */
const pseudonymized = new WeakMap<CompletionOptions, Pseudonyms>();

/**
 * The messages with their personal data as placeholders. A provider's raw
 * payload (`providerRaw`: Gemini parts, Anthropic content blocks) is sent back
 * verbatim by some providers in place of the fields below, and a signed
 * thinking block cannot be rewritten: it is left out, and the provider builds
 * the message from its pseudonymized fields.
 */
function pseudonymizeMessages(messages: CompletionOptions['messages'], p: Pseudonyms): CompletionOptions['messages'] {
  return messages.map(({ providerRaw: _raw, ...m }) => ({
    ...m,
    content: p.pseudonymize(m.content),
    ...(m.toolCalls ? { toolCalls: m.toolCalls.map((tc) => ({ ...tc, arguments: p.pseudonymizeDeep(tc.arguments) })) } : {}),
    ...(m.reasoningContent ? { reasoningContent: p.pseudonymize(m.reasoningContent) } : {}),
  }));
}

function restoreResult(result: CompletionResult, p: Pseudonyms): CompletionResult {
  return {
    ...result,
    content: p.restore(result.content),
    ...(result.toolCalls ? { toolCalls: result.toolCalls.map((tc) => ({ ...tc, arguments: p.restoreDeep(tc.arguments) })) } : {}),
    ...(result.reasoningContent ? { reasoningContent: p.restore(result.reasoningContent) } : {}),
    // Stored with the message: real values, like everything else stored.
    ...(result.providerRaw ? { providerRaw: p.restoreDeep(result.providerRaw) } : {}),
  };
}

/**
 * The funding a call's cost row carries. An install-topic request type is
 * `install` (D13) — unless it ran on a personal row: a compaction (or any
 * install-type call) on the user's own model is paid with their own key, so
 * it is `own` — or `sponsor` when it is a sponsor model inside a
 * sponsored turn, the sponsor's own included (coworking spec §9.1). Personal-key spend still lands
 * in `cost_log` and counts against the payer's budgets. Calls made inside
 * `withInstallUsage` are install work too, whatever their request type.
 */
async function fundingOf(options: CompletionOptions): Promise<NonNullable<CompletionOptions['funding']>> {
  // Install work is an install request type, or a call made inside
  // `withInstallUsage` (learning, link resolver, document processing, …).
  const install = options.funding === 'install' || (!!options.requestType && INSTALL_REQUEST_TYPES.has(options.requestType));
  if (!install) return options.funding ?? 'own';
  if (options.modelConfigName) {
    const { getModelRegistry } = await import('../model-registry');
    const owner = (await getModelRegistry().getModel(options.modelConfigName))?.ownerUserId;
    // A sponsor model inside a sponsored turn is the sponsor's money (§9.1),
    // whoever the turn serves — the sponsor's own sponsored turn included:
    // its compaction counts against the space's budget like the turn, never
    // the sponsor's personal one. Outside one, the owner's own key is `own`.
    if (owner) {
      if (currentSponsor()?.userId === owner) return 'sponsor';
      return owner === options.userId ? 'own' : 'sponsor';
    }
  }
  return 'install';
}

/**
 * Throws unless the call `options` describes (merged with the turn's usage
 * context) may run on `row` (`null`: a raw model id on the install's env
 * keys): an install row only for someone the install's models are for, or as
 * install work, or in a turn whose sponsor may use them (install-access.ts).
 * The API providers check here (`prepare`), the CLI spawn sites before they
 * pick a login.
 */
export async function assertRowServesCall(
  row: Pick<import('@/db/schema/models').ModelConfigEntry, 'ownerUserId'> | null,
  options: Pick<CompletionOptions, 'userId' | 'funding' | 'requestType' | 'modelConfigName'>,
  /** The turn's sponsor when the caller holds it (the CLI agent worker); else the ambient one. */
  sponsorUserId?: string | null,
): Promise<void> {
  const merged = { ...usageContext.getStore(), ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as CompletionOptions;
  const { assertInstallModelAccess } = await import('../install-access');
  await assertInstallModelAccess(row, merged.userId, await fundingOf(merged), sponsorUserId ?? currentSponsor()?.userId);
}

/** The user a provider call serves: the request's own, else the turn's usage context. */
export function providerUsageUserId(options: Pick<CompletionOptions, 'userId'>): string | undefined {
  return options.userId ?? usageContext.getStore()?.userId;
}

export async function recordProviderUsage(options: CompletionOptions, provider: string, result: Pick<CompletionResult, 'usage' | 'model' | 'requestId'>, incomplete = false) {
  options = { ...usageContext.getStore(), ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as CompletionOptions;
  try {
    const { getCostTracker } = await import('../cost-tracker');
    const funding = await fundingOf(options);
    const attributed = !!options.userId && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(options.userId);
    await getCostTracker().logUsageWithCost(
      attributed ? options.userId! : SYSTEM_USAGE_USER,
      options.modelConfigName ?? options.model, result.usage.inputTokens, result.usage.outputTokens,
      { sessionId: options.sessionId, agentId: options.agentId, requestType: options.requestType ?? 'chat',
        workspaceId: options.workspaceId ?? null,
        funding,
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


/** A CLI agent is a vendor's harness: never local (core/protection/routing.ts). */
async function assertCliMayRun(options: CompletionOptions): Promise<void> {
  const { assertMayLeave } = await import('@/core/protection/routing');
  await assertMayLeave({ provider: 'cli', modelId: options.model, endpoint: null, metadata: null }, options.sessionId ?? usageContext.getStore()?.sessionId, 'cli');
}

/** The session the current calls serve, from the turn's usage context. */
export function currentUsageSessionId(): string | undefined {
  return usageContext.getStore()?.sessionId;
}

export async function accountCompletion(options: CompletionOptions, provider: string, run: (o: CompletionOptions) => Promise<CompletionResult>): Promise<CompletionResult> {
  if (options.accountingOwner) return run(options);
  if (provider === 'cli') await assertCliMayRun(options);
  const prepared = provider === 'cli' ? options : await prepare(options, provider);
  let observed: Pick<CompletionResult, 'usage' | 'model' | 'requestId'> | undefined;
  try {
    const result = await run({ ...prepared, accountingOwner: true, accountingResponse: value => { observed = value; } });
    await recordProviderUsage(prepared, provider, result);
    const p = pseudonymized.get(prepared);
    return p ? restoreResult(result, p) : result;
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
  const restorer = streamRestorerFor(pseudonymized.get(prepared));
  try {
    for await (const chunk of run({ ...prepared, accountingOwner: true })) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) model = chunk.model;
      if (chunk.requestId) requestId = chunk.requestId;
      if (!restorer) { yield chunk; continue; }
      // The chunk that ends the stream carries the held-back text with it
      // (usage alone does not end it: some providers send it on every chunk).
      yield* restorer.chunk(chunk, !!chunk.finishReason);
    }
    if (restorer) yield* restorer.end();
    completed = true;
  } finally {
    await recordProviderUsage(prepared, provider, { usage, model, requestId }, !completed);
  }
}

/**
 * Translates a pseudonymized stream back (C6c): its text and each tool
 * call's arguments, a placeholder split across chunks included.
 */
function streamRestorerFor(p: Pseudonyms | undefined) {
  if (!p) return null;
  const text = new StreamRestorer(p);
  const args = new Map<string, InstanceType<typeof StreamRestorer>>();
  return {
    *chunk(chunk: StreamChunk, last: boolean): Generator<StreamChunk> {
      const out: StreamChunk = { ...chunk };
      if (chunk.content) out.content = text.push(chunk.content);
      if (chunk.reasoningContent) out.reasoningContent = p.restore(chunk.reasoningContent);
      if (chunk.providerRaw) out.providerRaw = p.restoreDeep(chunk.providerRaw);
      if (chunk.toolCallDelta?.arguments) {
        const id = chunk.toolCallDelta.id;
        const restorer = args.get(id) ?? new StreamRestorer(p);
        args.set(id, restorer);
        out.toolCallDelta = { ...chunk.toolCallDelta, arguments: restorer.push(chunk.toolCallDelta.arguments) };
      }
      if (!last) { yield out; return; }
      // Tool argument tails before the end; the text tail rides on it.
      yield* this.toolTails();
      const rest = text.flush();
      if (rest) out.content = (out.content ?? '') + rest;
      yield out;
    },
    *toolTails(): Generator<StreamChunk> {
      for (const [id, restorer] of args) {
        const tail = restorer.flush();
        if (tail) yield { toolCallDelta: { id, arguments: tail } };
      }
    },
    *end(): Generator<StreamChunk> {
      yield* this.toolTails();
      const rest = text.flush();
      if (rest) yield { content: rest };
    },
  };
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
