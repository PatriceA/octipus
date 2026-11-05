import { getModelRegistry } from '@/models/model-registry';
import { canServeText } from '@/models/topics';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { SpaceRole } from '@/db/schema/organizations';
import { InstallModelsDeniedError, mayUseInstallModels } from '@/models/install-access';
import { personalRowAllowed, resolveModel, usableInSpace } from '@/models/resolve-model';
import { coreLogger } from '@/utils/logger';
import { selectLaneWithDecision, type LaneChoice } from './lane-intent';
import { hasRecentShim } from './model-capability';
import { getSessionModel } from './session-model-override';
import type { MessageClassification } from './types';
import { type SessionContext, sessionGeneration } from '@/db/schema/sessions';
import { isChildCliSessionKey } from '@/core/cli-session-store';

/** The model a session's conversation is warm on (`warmConversationOf`), and the lane that chose it. */
export interface WarmConversation { name?: string; modelId: string; lane?: string }

/**
 * A conversation shorter than this (chars of the saved transcript) costs
 * little to re-read on another model, so per-message routing still wins.
 */
export const STICKY_LANE_MIN_CHARS = 16_000;

/**
 * The model the session's root conversation last ran on, when that
 * conversation is still the current one (same clear generation and
 * checkpoint) and big enough to be worth keeping warm: the saved native
 * conversation of an API model, or a root vendor CLI session (whose switch is
 * a cold restart of the whole vendor history). The latest of the two wins.
 */
export function warmConversationOf(ctx: SessionContext | null | undefined): WarmConversation | undefined {
  if (!ctx) return undefined;
  const generation = sessionGeneration(ctx);
  const checkpointId = ctx.checkpoint?.generation === generation ? ctx.checkpoint.entryId : undefined;
  const candidates: Array<WarmConversation & { at: string }> = [];
  const native = ctx.nativeConversation;
  if (native && native.generation === generation && native.checkpointId === checkpointId
    && native.messages.reduce((n, m) => n + m.content.length, 0) >= STICKY_LANE_MIN_CHARS) {
    candidates.push({ name: native.modelName, modelId: native.model, lane: native.lane, at: native.messages.at(-1)?.timestamp ?? '' });
  }
  for (const [key, record] of Object.entries(ctx.cliSessions ?? {})) {
    if (isChildCliSessionKey(key) || (record.generation ?? '') !== generation || !record.modelName) continue;
    candidates.push({ name: record.modelName, modelId: record.modelName, at: record.lastUsedAt });
  }
  const latest = candidates.sort((a, b) => b.at.localeCompare(a.at))[0];
  return latest ? { name: latest.name, modelId: latest.modelId, ...(latest.lane ? { lane: latest.lane } : {}) } : undefined;
}

interface ModelRouting {
  model: string;
  /** Row identity (`model_config.name`) of `model`; '' when no row was resolved. */
  name: string;
  reason: string;
}

/** A resolved model: the provider-facing id and the registry row it came from (spec §8.1). */
export interface SelectedModel {
  modelId: string;
  name: string;
}

/** Who a selection is for — scopes personal bindings and explicit names (spec §8.2). */
export interface ModelRequester {
  userId?: string;
  /** The session runs in a shared space (D14 applies to install CLI rows). */
  inSpace?: boolean;
  /** The requester's role there: a commenter's turns use API models only (§5.6). */
  spaceRole?: SpaceRole;
  /** A sponsored turn: the sponsor's models replace the requester's own (§9.1). */
  sponsor?: import('@/core/types').AgentSponsor | null;
}

/**
 * If `modelId` can't do tool-calling, find a local model that can. Returns the
 * replacement (+reason) or null when no swap is needed or possible. Shared by
 * the worker model selector and the swarm spawner's capability gate (RC7) so
 * both reroute identically. Only falls back to local (ollama) models to avoid
 * unexpected API costs.
 */
export async function findToolCapableFallback(
  modelId: string,
  /** The row `modelId` was resolved from, when known; else the modelId lookup for `userId`. */
  row: { modelName?: string; userId?: string } = {},
  /** Whom the call serves: the replacement comes from rows they may run (`modelCandidates`). */
  requester: ModelRequester = { userId: row.userId },
): Promise<{ model: string; name: string; reason: string } | null> {
  const registry = getModelRegistry();
  const model = row.modelName ? await registry.getModel(row.modelName) : await registry.getModelByModelId(modelId, { userId: row.userId });
  if (!model || model.supportsTools || model.provider === 'cli') {
    return null; // already supports tools, or CLI (frontier) — no change
  }

  const localProviders = ['ollama'];

  const { defaultModel, rows: allModels } = await modelCandidates(requester);
  if (
    defaultModel && defaultModel.supportsTools && canServeText(defaultModel)
    && defaultModel.modelId !== modelId
    && localProviders.includes(defaultModel.provider)
  ) {
    return { model: defaultModel.modelId, name: defaultModel.name, reason: 'routed model does not support tool calling' };
  }

  const toolModel = allModels.find((m) =>
    m.supportsTools && canServeText(m)
    && m.provider !== 'cli'
    && localProviders.includes(m.provider)
    && m.modelId !== modelId,
  );
  if (toolModel) {
    return { model: toolModel.modelId, name: toolModel.name, reason: `using ${toolModel.name} for tool support` };
  }

  return null;
}

/**
 * The rows a reroute may pick from for `requester`: the install's default and
 * rows, or — for a payer the install's models are not for (install-access.ts;
 * the sponsor in a sponsored turn) — only rows the requester may run of the
 * payer's own, and no install default.
 */
export async function modelCandidates(requester: ModelRequester): Promise<{ defaultModel: ModelConfigEntry | null; rows: ModelConfigEntry[] }> {
  const registry = getModelRegistry();
  const payer = requester.sponsor ? requester.sponsor.userId : requester.userId;
  if (await mayUseInstallModels(payer)) {
    return { defaultModel: await registry.getDefaultModel(), rows: await registry.getAllModels() };
  }
  const own = payer ? await registry.getPersonalModels(payer) : [];
  return { defaultModel: null, rows: own.filter((m) => m.isEnabled && personalRowAllowed(m, requester.userId, requester.sponsor)) };
}

/**
 * Encapsulates model selection logic for the root agent and worker agents.
 */
export class ModelSelector {
  constructor(
  ) {}

  /**
   * Select a model suitable for the root agent (must support tools, no reasoning models).
   *
   * Order, and the order is the design:
   *   1. the session's model override — the user said which model, explicitly
   *   2. the lane this REQUEST routes to (see lane-intent.ts): the requester's
   *      personal binding for it, else the install binding (spec §8.2)
   *   3. the default model
   *
   * An explicit choice always beats a classification; everything below it is
   * routed per message rather than per install. There used to be a step
   * between: the General expert's pinned model, then its assigned lane. That
   * row answered "which model runs a task turn" for every task turn alike,
   * which is the indirection the lane split exists to remove.
   */
  async selectForRootAgent(
    sessionId?: string,
    turnType: MessageClassification['type'] = 'casual',
    /** The request being routed, and its classification. Absent ⇒ no routing. */
    routing?: { message: string; classification?: MessageClassification; laneChoice?: LaneChoice; conversation?: WarmConversation },
    requester: ModelRequester = {},
  ): Promise<SelectedModel> {
    const registry = getModelRegistry();

    // Per-session override (Phase 6) wins over the registry default,
    // but it must pass the same reasoner/no-tools rejection the default
    // model goes through. Earlier this bypassed the reasoner check,
    // letting `/model <thinking-model>` succeed at the command then fail
    // mid-turn. The override is the requester's own — keyed by
    // (session, user) — and is re-resolved with their visibility, so a
    // row they lost access to stops applying.
    if (sessionId && requester.userId) {
      const overrideName = getSessionModel(sessionId, requester.userId);
      if (overrideName) {
        const override = await resolveModel({ userId: requester.userId, name: overrideName, inSpace: requester.inSpace, spaceRole: requester.spaceRole, sponsor: requester.sponsor });
        if (override) {
          coreLogger.info(
            { sessionId, model: override.modelId },
            'Session model override active',
          );
          return this.validateRootModel(override, requester);
        }
        coreLogger.warn(
          { sessionId, overrideName },
          'Session model override points to an unregistered model — falling back to configured routing',
        );
      }
    }

    // Where the model comes from now: the request. The General expert row used
    // to answer this — its `modelPreference`, else its assigned lane — which
    // meant one binding served a coding brief and "what's the weather" alike.
    // A lane is the same answer without the indirection, and it is chosen per
    // message rather than per install.
    const routed = routing ? routing.laneChoice ?? await selectLaneWithDecision(routing.message, routing.classification) : null;
    if (routed) {
      const routedModel = await resolveModel({ userId: requester.userId, topic: routed.lane, inSpace: requester.inSpace, spaceRole: requester.spaceRole, sponsor: requester.sponsor });
      const kept = routedModel ? await this.keepWarmModel(routing?.conversation, routedModel, requester) : null;
      if (kept) {
        coreLogger.info(
          { lane: routed.lane, routedModel: routedModel!.modelId, model: kept.modelId, turnType },
          'Request routed to a cheaper or equal lane — staying on the conversation\'s model, whose prompt cache is warm',
        );
        return this.validateRootModel(kept, requester);
      }
      if (routedModel) {
        coreLogger.info(
          { lane: routed.lane, reason: routed.reason, model: routedModel.modelId, turnType },
          'Request routed to a model lane',
        );
        return this.validateRootModel(routedModel, requester);
      }
      coreLogger.info(
        { lane: routed.lane },
        'Routed lane is unbound — falling back to the default model',
      );
    }

    const own = await this.ownModelInsteadOfInstall(requester);
    if (own) return this.validateRootModel(own, requester);
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured. Set one in the Models page.');
    }
    return this.validateRootModel(defaultModel, requester);
  }

  /**
   * The model to keep instead of the routed one, or null to follow the route.
   *
   * Lanes are chosen per message, and every switch of model is a cold prompt
   * cache for the whole conversation — re-read at full price on the new model
   * (and for a CLI model, a cold restart of the vendor session). Within a warm
   * conversation the route is followed only when it is a step UP (a pricier
   * model: the message asks for more than the current one gives); a cheaper or
   * equal lane would save less than the re-read costs, so the conversation
   * stays where it is. The session override (`/model`) is decided before this.
   *
   * A configuration change still wins: when the lane that chose the
   * conversation's model no longer resolves to it (the lane was rebound, or
   * the model came from an override since removed), the route is followed.
   */
  private async keepWarmModel(conversation: WarmConversation | undefined, routed: ModelConfigEntry, requester: ModelRequester): Promise<ModelConfigEntry | null> {
    if (!conversation || !requester.userId) return null;
    if (conversation.name ? conversation.name === routed.name : conversation.modelId === routed.modelId) return null;
    const scope = { userId: requester.userId, inSpace: requester.inSpace, spaceRole: requester.spaceRole, sponsor: requester.sponsor };
    const current = await resolveModel({ ...scope, name: conversation.name ?? conversation.modelId });
    if (!current || current.name === routed.name) return null;
    if (conversation.lane && (await resolveModel({ ...scope, topic: conversation.lane }))?.name !== current.name) return null;
    const price = (m: Pick<ModelConfigEntry, 'costPerInputToken' | 'costPerOutputToken'>) => (m.costPerInputToken ?? 0) + (m.costPerOutputToken ?? 0);
    return price(routed) > price(current) ? null : current;
  }

  /**
   * For a requester the install's models are not for (install-access.ts —
   * the payer: the sponsor in a sponsored turn): their own first usable model
   * in place of the install default; `InstallModelsDeniedError` when they
   * have none. Null for everyone else.
   */
  private async ownModelInsteadOfInstall(requester: ModelRequester) {
    if (!requester.userId) return null;
    const payer = requester.sponsor ? requester.sponsor.userId : requester.userId;
    if (await mayUseInstallModels(payer)) return null;
    const own = await resolveModel({ userId: requester.userId, topic: 'everyday', inSpace: requester.inSpace, spaceRole: requester.spaceRole, sponsor: requester.sponsor });
    if (!own) throw new InstallModelsDeniedError();
    return own;
  }

  /**
   * Reject reasoning / no-tools models in favor of a working alternative.
   * Matters when the user explicitly overrides too — see the override
   * branch above. Returns the final model id the root agent should run with.
   */
  private async validateRootModel(
    modelMeta: Pick<ModelConfigEntry, 'modelId' | 'name' | 'supportsTools' | 'provider'> & Partial<Pick<ModelConfigEntry, 'topics' | 'topicRoles'>>,
    requester: ModelRequester,
  ): Promise<SelectedModel> {
    const chosen: SelectedModel = { modelId: modelMeta.modelId, name: modelMeta.name };
    const isReasoner = modelMeta.modelId.includes('reasoner') || modelMeta.modelId.includes('thinking');
    const noTools = !modelMeta.supportsTools && modelMeta.provider !== 'cli';
    // Capability floor (Phase 2.1): a model that recently needed the toolshim
    // to emit a tool call cannot be trusted to orchestrate natively. CLI
    // providers run their own harness and never route through the shim, so
    // they are exempt.
    const shimUnreliable = modelMeta.provider !== 'cli' && hasRecentShim(modelMeta.modelId);
    const specialist = !canServeText(modelMeta);
    if (!isReasoner && !noTools && !shimUnreliable && !specialist) return chosen;

    const reason = specialist ? 'specialist-only' : isReasoner ? 'reasoner' : noTools ? 'no-tools' : 'shim-unreliable';
    const isSuitable = (m: ModelConfigEntry): boolean =>
      canServeText(m) && m.supportsTools &&
      !m.modelId.includes('reasoner') &&
      !m.modelId.includes('thinking') &&
      m.provider !== 'cli' &&
      m.modelId !== modelMeta.modelId &&
      !hasRecentShim(m.modelId);

    // Prefer the configured default when it clears the floor, else the first
    // tool-reliable model.
    const { defaultModel, rows: allModels } = await modelCandidates(requester);
    const suitable = defaultModel && isSuitable(defaultModel) ? defaultModel : allModels.find(isSuitable);
    if (suitable) {
      coreLogger.warn(
        { originalModel: modelMeta.modelId, selectedModel: suitable.modelId, reason },
        'Root agent model rerouted — it cannot reliably emit native tool calls',
      );
      return { modelId: suitable.modelId, name: suitable.name };
    }
    if (specialist) throw new Error('No conversational model configured. Bind a chat model to a text topic in the Models page.');
    coreLogger.warn(
      { candidateModel: modelMeta.modelId, reason },
      'Candidate model unsuitable for orchestration and no alternative configured — attempting anyway',
    );
    return chosen;
  }

  /**
   * Select the best model for a worker role's topic, with fallback for tool support.
   */
  async selectForWorker(topic: string, needsTools: boolean, requester: ModelRequester = {}): Promise<ModelRouting> {
    const topicModel = await resolveModel({ userId: requester.userId, topic, inSpace: requester.inSpace, spaceRole: requester.spaceRole, sponsor: requester.sponsor });

    if (!topicModel) {
      coreLogger.warn(
        { topic },
        'No model mapped for topic — refusing to fall back to default. Map a model to this topic in the Models page.',
      );
      return { model: '', name: '', reason: `No model mapped for topic "${topic}"` };
    }

    const routing: ModelRouting = {
      model: topicModel.modelId,
      name: topicModel.name,
      reason: `Best model for topic: ${topic}`,
    };

    // If the worker needs tools, verify the routed model supports them
    if (needsTools) {
      const resolved = await this.ensureToolSupport(routing, requester);
      if (resolved) return resolved;
    }

    return routing;
  }

  /**
   * If the routed model lacks tool support, find a local alternative.
   */
  private async ensureToolSupport(routing: ModelRouting, requester: ModelRequester): Promise<ModelRouting | null> {
    const registry = getModelRegistry();
    const model = await registry.getModel(routing.name);
    // Only the "can't do tools" case is interesting — a supported/CLI model
    // short-circuits with no log (findToolCapableFallback returns null too).
    if (!model || model.supportsTools || model.provider === 'cli') return null;

    const alt = await findToolCapableFallback(routing.model, { modelName: routing.name }, requester);
    if (!alt) {
      coreLogger.warn(
        { model: routing.model },
        'No local model with tool support found — proceeding without tools',
      );
      return null;
    }
    coreLogger.info(
      { from: routing.model, to: alt.model },
      'Routed model does not support tools — rerouting to a tool-capable local model',
    );
    return { model: alt.model, name: alt.name, reason: `Fallback: ${alt.reason}` };
  }

  /**
   * Select a model based on message complexity.
   * Simple messages use a cheaper/faster model if available. A requester who
   * bound a personal model to the `everyday` lane — the casual-chat lane —
   * gets that row instead (spec §8.2). In a space session the space rules
   * hold here too (side questions, the voice plan gate): a CLI row only when
   * `usableInSpace` allows it for the requester's role.
   */
  async selectByComplexity(complexity: 'simple' | 'moderate' | 'complex' = 'moderate', requester: ModelRequester = {}): Promise<SelectedModel> {
    const registry = getModelRegistry();
    const usable = (row: Parameters<typeof usableInSpace>[0]) => !requester.inSpace || usableInSpace(row, requester.spaceRole);
    if (requester.userId) {
      const personal = await registry.getUserBinding(requester.userId, 'everyday');
      if (personal && usable(personal)) return { modelId: personal.modelId, name: personal.name };
    }
    const own = await this.ownModelInsteadOfInstall(requester);
    if (own) return { modelId: own.modelId, name: own.name };
    const configuredDefault = await registry.getDefaultModel();
    if (!configuredDefault) {
      throw new Error('No default model configured. Set one in the Models page.');
    }
    const defaultModel = usable(configuredDefault)
      ? configuredDefault
      : (await registry.getAllModels()).find((m) => m.provider !== 'cli');
    if (!defaultModel) {
      throw new Error(`The default model ${configuredDefault.name} cannot run in this space and no API model is configured.`);
    }
    const defaultModelId = defaultModel.modelId;

    if (complexity === 'simple') {
      // Try to find a smaller/cheaper model
      const allModels = await registry.getAllModels();
      const cheapModel = allModels.find(m =>
        m.isEnabled &&
        canServeText(m) &&
        m.provider !== 'cli' &&
        m.priority < (defaultModel?.priority || 100) &&
        m.modelId !== defaultModelId
      );
      if (cheapModel) {
        coreLogger.debug(
          { complexity, model: cheapModel.modelId },
          'Routing simple message to cheaper model',
        );
        return { modelId: cheapModel.modelId, name: cheapModel.name };
      }
    }

    return { modelId: defaultModelId, name: defaultModel.name };
  }
}
