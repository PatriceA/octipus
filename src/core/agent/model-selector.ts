import { getModelRegistry } from '@/models/model-registry';
import type { SpaceRole } from '@/db/schema/organizations';
import { resolveModel, usableInSpace } from '@/models/resolve-model';
import { coreLogger } from '@/utils/logger';
import { selectLane } from './lane-intent';
import { hasRecentShim } from './model-capability';
import { getSessionModel } from './session-model-override';
import type { MessageClassification } from './types';

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
): Promise<{ model: string; name: string; reason: string } | null> {
  const registry = getModelRegistry();
  const model = row.modelName ? await registry.getModel(row.modelName) : await registry.getModelByModelId(modelId, { userId: row.userId });
  if (!model || model.supportsTools || model.provider === 'cli') {
    return null; // already supports tools, or CLI (frontier) — no change
  }

  const localProviders = ['ollama'];

  const defaultModel = await registry.getDefaultModel();
  if (
    defaultModel && defaultModel.supportsTools
    && defaultModel.modelId !== modelId
    && localProviders.includes(defaultModel.provider)
  ) {
    return { model: defaultModel.modelId, name: defaultModel.name, reason: 'routed model does not support tool calling' };
  }

  const allModels = await registry.getAllModels();
  const toolModel = allModels.find((m) =>
    m.supportsTools
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
    routing?: { message: string; classification?: MessageClassification },
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
        const override = await resolveModel({ userId: requester.userId, name: overrideName, inSpace: requester.inSpace, spaceRole: requester.spaceRole });
        if (override) {
          coreLogger.info(
            { sessionId, model: override.modelId },
            'Session model override active',
          );
          return this.validateRootModel(override);
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
    const routed = routing ? selectLane(routing.message, routing.classification) : null;
    if (routed) {
      const routedModel = await resolveModel({ userId: requester.userId, topic: routed.lane, inSpace: requester.inSpace, spaceRole: requester.spaceRole });
      if (routedModel) {
        coreLogger.info(
          { lane: routed.lane, reason: routed.reason, model: routedModel.modelId, turnType },
          'Request routed to a model lane',
        );
        return this.validateRootModel(routedModel);
      }
      coreLogger.info(
        { lane: routed.lane },
        'Routed lane is unbound — falling back to the default model',
      );
    }

    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured. Set one in the Models page.');
    }
    return this.validateRootModel(defaultModel);
  }

  /**
   * Reject reasoning / no-tools models in favor of a working alternative.
   * Matters when the user explicitly overrides too — see the override
   * branch above. Returns the final model id the root agent should run with.
   */
  private async validateRootModel(
    modelMeta: { modelId: string; name: string; supportsTools: boolean; provider: string },
  ): Promise<SelectedModel> {
    const chosen: SelectedModel = { modelId: modelMeta.modelId, name: modelMeta.name };
    const registry = getModelRegistry();
    const isReasoner = modelMeta.modelId.includes('reasoner') || modelMeta.modelId.includes('thinking');
    const noTools = !modelMeta.supportsTools && modelMeta.provider !== 'cli';
    // Capability floor (Phase 2.1): a model that recently needed the toolshim
    // to emit a tool call cannot be trusted to orchestrate natively. CLI
    // providers run their own harness and never route through the shim, so
    // they are exempt.
    const shimUnreliable = modelMeta.provider !== 'cli' && hasRecentShim(modelMeta.modelId);
    if (!isReasoner && !noTools && !shimUnreliable) return chosen;

    const reason = isReasoner ? 'reasoner' : noTools ? 'no-tools' : 'shim-unreliable';
    const isSuitable = (m: { modelId: string; supportsTools: boolean; provider: string }): boolean =>
      m.supportsTools &&
      !m.modelId.includes('reasoner') &&
      !m.modelId.includes('thinking') &&
      m.provider !== 'cli' &&
      m.modelId !== modelMeta.modelId &&
      !hasRecentShim(m.modelId);

    // Prefer the configured default when it clears the floor, else the first
    // tool-reliable model.
    const defaultModel = await registry.getDefaultModel();
    const allModels = await registry.getAllModels();
    const suitable = defaultModel && isSuitable(defaultModel) ? defaultModel : allModels.find(isSuitable);
    if (suitable) {
      coreLogger.warn(
        { originalModel: modelMeta.modelId, selectedModel: suitable.modelId, reason },
        'Root agent model rerouted — it cannot reliably emit native tool calls',
      );
      return { modelId: suitable.modelId, name: suitable.name };
    }
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
    const topicModel = await resolveModel({ userId: requester.userId, topic, inSpace: requester.inSpace, spaceRole: requester.spaceRole });

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
      const resolved = await this.ensureToolSupport(routing);
      if (resolved) return resolved;
    }

    return routing;
  }

  /**
   * If the routed model lacks tool support, find a local alternative.
   */
  private async ensureToolSupport(routing: ModelRouting): Promise<ModelRouting | null> {
    const registry = getModelRegistry();
    const model = await registry.getModel(routing.name);
    // Only the "can't do tools" case is interesting — a supported/CLI model
    // short-circuits with no log (findToolCapableFallback returns null too).
    if (!model || model.supportsTools || model.provider === 'cli') return null;

    const alt = await findToolCapableFallback(routing.model, { modelName: routing.name });
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
