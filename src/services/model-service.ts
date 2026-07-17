/**
 * Model service — model CRUD, validation, capability checks, discovery,
 * and usage stats.
 *
 * Extracted from `src/api/routes/models.ts`. The route handlers now parse
 * the request, call one of these functions, and return the result. Return
 * shapes match what the routes returned inline — HTTP behaviour unchanged.
 *
 * There is no user-owned table here: model config is global, gated by
 * `user.isAdmin` in the route. Where a function needs the caller (vault
 * key lookups, per-user model visibility, usage stats) it takes a plain
 * `userId`.
 */
import { getConfig } from '@/config';
import type { NewModelConfigEntry } from '@/db/schema/models';
import { getCapabilitiesForModel } from '@/models/capabilities';
import { checkModelCapabilities } from '@/models/capability-gate';
import { getCostTracker } from '@/models/cost-tracker';
import { getHealthChecker } from '@/models/health-checker';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import { getQuotaTracker } from '@/models/quota-tracker';
import { coreLogger } from '@/utils/logger';

// ── List / read ──────────────────────────────────────────────────────

/** List models visible to the user (all incl. disabled for admins). */
export async function listModels(userId: string, isAdmin: boolean) {
  const registry = getModelRegistry();
  const models = isAdmin
    ? await registry.getAllModelsIncludeDisabled()
    : await registry.getModelsForUser(userId);

  return {
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      modelId: m.modelId,
      endpoint: m.endpoint,
      apiKeyRef: m.apiKeyRef,
      maxTokens: m.maxTokens,
      contextWindow: m.contextWindow,
      supportsVision: m.supportsVision,
      supportsTools: m.supportsTools,
      supportsStreaming: m.supportsStreaming,
      topics: m.topics,
      priority: m.priority,
      costPerInputToken: m.costPerInputToken,
      costPerOutputToken: m.costPerOutputToken,
      isEnabled: m.isEnabled,
      isDefault: m.isDefault,
      metadata: m.metadata,
    })),
  };
}

/** Get one model by name, with derived capabilities. */
export async function getModelByName(name: string) {
  const registry = getModelRegistry();
  const model = await registry.getModel(name);
  if (!model) return { error: 'Model not found' as const };
  return { ...model, capabilities: getCapabilitiesForModel(model) };
}

// ── Create / update / delete ─────────────────────────────────────────

/**
 * Register a new model. Validates the OpenRouter id format and rejects
 * duplicate names. Strips topic bindings (owned by the Topics page).
 * Returns the created model, or `{ error }` on a validation/DB failure.
 */
export async function registerModel(body: Record<string, unknown>) {
  const provider = body.provider as string;
  const modelId = body.modelId as string;
  const name = body.name as string;

  // Validate OpenRouter model IDs must contain a slash (provider/model format)
  if (provider === 'openrouter' && !modelId.includes('/')) {
    return {
      error: `OpenRouter models require "provider/model" format (e.g., "minimax/minimax-01"), got "${modelId}"`,
    };
  }

  const registry = getModelRegistry();

  // Check for duplicate name before inserting
  const existing = await registry.getModel(name);
  if (existing) {
    return { error: `A model with name "${name}" already exists` };
  }

  try {
    // Strip any topic binding from creation — topic↔model assignment is owned
    // by the Topics page (PUT /topics/:topic/binding), so a model is created
    // unbound and gets its topics there. Keeps a single source of truth.
    const { topics: _topics, topicRoles: _topicRoles, ...createBody } = body;
    return await registry.registerModel(createBody as NewModelConfigEntry);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return { error: `A model with name "${name}" already exists` };
    }
    return { error: `Failed to register model: ${msg}` };
  }
}

/**
 * Update a model. Strips capability flags and topic bindings (both are
 * derived/owned elsewhere). Returns `{ ok, model }` on success, or a
 * `{ status, error }` describing the HTTP failure. Mirrors the route's
 * previous 404/400 behaviour.
 */
export async function updateModel(name: string, body: Record<string, unknown>) {
  // Strip capability flags from user updates — supportsTools, supportsVision,
  // and supportsStreaming are derived from the provider capabilities system
  // (see src/models/capabilities.ts) and must not be overridden by user input.
  // This ensures capability presets remain the single source of truth.
  // topics/topicRoles are likewise stripped: topic binding is owned by the
  // Topics page, so the model editor must never write it (single source of truth).
  const {
    supportsTools: _t,
    supportsVision: _v,
    supportsStreaming: _s,
    topics: _topics,
    topicRoles: _topicRoles,
    ...safeUpdate
  } = body;

  try {
    const registry = getModelRegistry();
    const model = await registry.updateModel(name, safeUpdate as Partial<NewModelConfigEntry>);
    if (!model) {
      return { status: 404 as const, error: 'Model not found' };
    }
    return { ok: true as const, model: { ...model, capabilities: getCapabilitiesForModel(model) } };
  } catch (err) {
    // Without this catch, any DB-side failure (constraint, type mismatch,
    // unknown column from a stale schema) bubbled up to Elysia's default
    // handler as an opaque 500 with no error body. Logging + surfacing
    // the message lets the UI show the user what actually broke.
    coreLogger.error({ err, model: name, update: safeUpdate }, 'updateModel failed');
    return { status: 400 as const, error: 'Failed to update model', details: (err as Error).message };
  }
}

export async function deleteModel(name: string) {
  const registry = getModelRegistry();
  const deleted = await registry.deleteModel(name);
  return { deleted };
}

export async function setDefaultModel(name: string) {
  const registry = getModelRegistry();
  const success = await registry.setDefaultModel(name);
  return { success };
}

/**
 * Run the capability gate (tool-calling + JSON conformance) against a
 * model. Returns the verdict, or `{ status, error }` on miss/failure.
 */
export async function checkCapabilities(name: string, userId: string) {
  const registry = getModelRegistry();
  const model = await registry.getModel(name);
  if (!model) {
    return { status: 404 as const, error: `Model "${name}" not found` };
  }
  try {
    const client = getLiteLLMClient();
    const providers = new Map(getProviderRouter().getAllProviders().map((p) => [p.name, p]));
    const verdict = await checkModelCapabilities(client, model, providers, { userId });
    return { ok: true as const, verdict };
  } catch (err) {
    coreLogger.error({ err, model: name }, 'capability check failed');
    return { status: 500 as const, error: `Capability check failed: ${(err as Error).message}` };
  }
}

// ── Health / CLI status / quotas ─────────────────────────────────────

export async function getSystemHealth() {
  return getHealthChecker().getSystemHealth();
}

export async function getCliStatus() {
  const router = getProviderRouter();
  const cliProvider = router.getCLIProvider();
  const quotaTracker = getQuotaTracker();

  const [tools, quotas] = await Promise.all([
    cliProvider.getAvailableTools(),
    quotaTracker.getAllStatuses(),
  ]);

  return {
    tools: tools.map(tool => {
      const quota = quotas.find(q => q.provider === tool.name.toLowerCase().replace(/\s+/g, '-'));
      return { ...tool, quota: quota || null };
    }),
  };
}

export async function getCliQuotas() {
  const statuses = await getQuotaTracker().getAllStatuses();
  return { quotas: statuses };
}

export async function getCliQuotaHistory(provider: string, days: number) {
  const history = await getQuotaTracker().getUsageHistory(provider, days);
  return { provider, history };
}

export async function clearCliQuota(provider: string) {
  await getQuotaTracker().clearExhaustion(provider);
  return { success: true };
}

// ── hwfit: recommend / install ───────────────────────────────────────

export async function recommendModels() {
  const { probeHardware } = await import('@/setup/probes');
  const { resolveSizes, scoreCatalog } = await import('@/capabilities/hwfit');
  const { describeModeForParams } = await import('@/core/orchestrator/mode-selector');
  const hardware = await probeHardware();
  const sized = await resolveSizes();
  const scored = scoreCatalog(hardware, sized);

  // Annotate each model with the orchestrator mode it would imply as the
  // default, so the UI can tell the user what the model means for how
  // Octipus runs (router/lite/full). Thresholds come from config.
  //
  // Only annotate models that could actually BE the orchestrator default —
  // i.e. text-generation models. Embedding and vision/OCR models can never
  // be the orchestrator, so a "router/lite/full" label on them is
  // meaningless and was the source of the inconsistent UI text.
  const orch = getConfig().orchestrator;
  const thresholds = {
    routerSmallModelMaxParams: orch.routerSmallModelMaxParams,
    liteModelMaxParams: orch.liteModelMaxParams,
  };
  const ORCHESTRATOR_CAPABLE_TOPICS = new Set(['chat', 'general', 'coding', 'research']);
  for (const s of scored) {
    if (!s.entry.topics.some((t) => ORCHESTRATOR_CAPABLE_TOPICS.has(t))) continue;
    const { mode, note } = describeModeForParams(s.entry.params, thresholds);
    s.orchestratorMode = mode;
    s.orchestratorModeNote = note;
  }
  return { hardware, scored };
}

/**
 * hwfit: pull a recommended catalog model into Ollama, register it, bind
 * topics, and kick off the async install job. Returns `{ status, error }`
 * for the validation failures (unknown id, already registered, no topics,
 * provider unavailable) or the started job descriptor.
 */
export async function installRecommendedModel(
  id: string,
  bindTopicsRequested: string[] | undefined,
  userId: string,
) {
  const { getCatalogEntry } = await import('@/capabilities/hwfit');
  const { startInstall } = await import('@/capabilities/hwfit/install');
  const { emitInstallProgress } = await import('@/capabilities/hwfit/install-events');
  const { OllamaProvider } = await import('@/models/providers/ollama-provider');

  const entry = getCatalogEntry(id);
  if (!entry) {
    return { status: 400 as const, error: `Unknown catalog model "${id}"` };
  }

  const registry = getModelRegistry();
  if (await registry.getModel(entry.id)) {
    return { status: 409 as const, error: `Model "${entry.id}" is already registered` };
  }

  const provider = getProviderRouter().getProviderByName('ollama');
  if (!(provider instanceof OllamaProvider)) {
    return { status: 500 as const, error: 'Ollama provider unavailable' };
  }

  // Bind only to topics the model actually serves; default to all of them.
  const requested = bindTopicsRequested ?? [];
  const bindTopics = (requested.length ? entry.topics.filter((t) => requested.includes(t)) : entry.topics);
  if (bindTopics.length === 0) {
    return { status: 400 as const, error: `None of the requested topics are served by "${entry.id}"` };
  }

  const job = startInstall(entry, bindTopics, userId, {
    pull: (pid, onProgress) => provider.pull(pid, onProgress),
    register: async (e) => {
      await registry.registerModel(e);
    },
    isFirstModel: async () => (await registry.getDefaultModel()) === null,
    // Push progress to the owner's WebSocket (the panel listens instead of
    // polling). Polling stays available as a fallback via GET /install/:id.
    onUpdate: (j) => emitInstallProgress(j),
  });
  return { ok: true as const, jobId: job.id, status: job.status, bindTopics };
}

/** Poll an install job, scoped to the owner (or admin). Null → not found. */
export async function getInstallJobScoped(jobId: string, userId: string, isAdmin: boolean) {
  const { getInstallJob } = await import('@/capabilities/hwfit/install');
  const job = getInstallJob(jobId);
  // Scope to the owner (or an admin) — cross-tenant ids look like "not found".
  if (!job || (job.ownerId !== userId && !isAdmin)) return null;
  return job;
}

// ── Provider discovery / catalog ─────────────────────────────────────

/** Known model ids for a provider (shortlist string[] from discovery cache). */
export async function getKnownProviderModels(provider: string, userId: string) {
  const { discover, getDiscoverableProviders } = await import('@/models/providers/discovery');
  if (!getDiscoverableProviders().includes(provider)) {
    return { models: [] };
  }
  const result = await discover(provider, { userId });
  return { models: result.shortlist.map(m => m.id) };
}

export interface AvailableProviderModelsQuery {
  endpoint?: string;
  preview?: string;
  embeddings?: string;
  refresh?: string;
}

/** Available models for a provider (live discovery + curation). */
export async function getAvailableProviderModels(
  provider: string,
  query: AvailableProviderModelsQuery,
  userId: string,
) {
  // Vertex has no simple model-list endpoint (Model Garden isn't a `/models`
  // call), so there is no discovery: "configured" means a service account is
  // present and the user types the model id manually (e.g. gemini-2.0-flash).
  if (provider === 'vertex') {
    const { isVertexConfigured } = await import('@/models/providers/vertex-provider');
    return (await isVertexConfigured())
      ? { configured: true, models: [], source: 'manual' }
      : { configured: false, error: 'Vertex service account not configured. Add it on the Secrets page.', models: [] };
  }

  const { discover, getDiscoverableProviders } = await import('@/models/providers/discovery');

  if (!getDiscoverableProviders().includes(provider)) {
    return { configured: false, error: `Discovery not supported for provider: ${provider}` };
  }

  const credsOverride = provider === 'ollama' && query.endpoint
    ? { endpoint: query.endpoint }
    : undefined;

  const result = await discover(
    provider,
    {
      includePreview: query.preview === 'true',
      includeNonChat: query.embeddings === 'true',
      bypassCache: query.refresh === 'true',
      userId,
    },
    credsOverride,
  );

  if (result.source === 'unconfigured') {
    return { configured: false, error: result.error };
  }

  return {
    configured: true,
    models: result.shortlist,
    hiddenCount: result.hiddenCount,
    lastFetched: result.lastFetched,
    source: result.source,
    error: result.error,
  };
}

/** Persist a custom model catalog for a provider (settings service). */
export async function updateProviderCatalog(provider: string, models: unknown[], userId: string) {
  const { getSettingsService } = await import('@/config/settings-service');
  const svc = getSettingsService();
  await svc.set('models.catalog.' + provider, models, userId);
  return { success: true };
}

// ── Usage stats ──────────────────────────────────────────────────────

export async function getUsage(userId: string, since?: Date) {
  const costTracker = getCostTracker();
  const stats = await costTracker.getUserStats(userId, since);
  const byModel = await costTracker.getUserStatsByModel(userId, since);
  return { stats, byModel };
}

export async function getDailyUsage(userId: string, days: number) {
  const daily = await getCostTracker().getDailyUsage(userId, days);
  return { daily };
}

export async function getGlobalUsage(since?: Date) {
  return getCostTracker().getGlobalStats(since);
}
