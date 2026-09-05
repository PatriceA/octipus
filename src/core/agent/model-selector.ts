import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { hasRecentShim } from './model-capability';
import { getSessionModel } from './session-model-override';

interface ModelRouting {
  model: string;
  reason: string;
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
): Promise<{ model: string; reason: string } | null> {
  const registry = getModelRegistry();
  const model = await registry.getModelByModelId(modelId);
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
    return { model: defaultModel.modelId, reason: 'routed model does not support tool calling' };
  }

  const allModels = await registry.getAllModels();
  const toolModel = allModels.find((m) =>
    m.supportsTools
    && m.provider !== 'cli'
    && localProviders.includes(m.provider)
    && m.modelId !== modelId,
  );
  if (toolModel) {
    return { model: toolModel.modelId, reason: `using ${toolModel.name} for tool support` };
  }

  return null;
}

/**
 * Encapsulates model selection logic for the root agent and worker agents.
 */
export class ModelSelector {
  /**
   * Select a model suitable for orchestration (must support tools, no reasoning models).
   */
  async selectForRootAgent(sessionId?: string): Promise<string> {
    const registry = getModelRegistry();

    // Per-session override (Phase 6) wins over the registry default,
    // but it must pass the same reasoner/no-tools rejection the default
    // model goes through. Earlier this bypassed the reasoner check,
    // letting `/model <thinking-model>` succeed at the command then fail
    // mid-turn.
    if (sessionId) {
      const overrideId = getSessionModel(sessionId);
      if (overrideId) {
        const override = await registry.getModelByModelId(overrideId);
        if (override) {
          coreLogger.info(
            { sessionId, model: override.modelId },
            'Session model override active',
          );
          return this.validateRootModel(override.modelId, override);
        }
        coreLogger.warn(
          { sessionId, overrideId },
          'Session model override points to an unregistered model — falling back to default',
        );
      }
    }

    // The 'chat' lane binding, when set, is the explicit home for the
    // root agent/conversation model (topic consolidation made this real —
    // 'chat' previously had no consumer). Unbound ⇒ default model, as before.
    const chatModel = await registry.getModelForTopic('chat');
    if (chatModel) {
      return this.validateRootModel(chatModel.modelId, chatModel);
    }

    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured. Set one in the Models page.');
    }
    return this.validateRootModel(defaultModel.modelId, defaultModel);
  }

  /**
   * Reject reasoning / no-tools models in favor of a working alternative.
   * Matters when the user explicitly overrides too — see the override
   * branch above. Returns the final model id the root agent should run with.
   */
  private async validateRootModel(
    modelName: string,
    modelMeta: { modelId: string; supportsTools: boolean; provider: string },
  ): Promise<string> {
    const registry = getModelRegistry();
    const isReasoner = modelMeta.modelId.includes('reasoner') || modelMeta.modelId.includes('thinking');
    const noTools = !modelMeta.supportsTools && modelMeta.provider !== 'cli';
    // Capability floor (Phase 2.1): a model that recently needed the toolshim
    // to emit a tool call cannot be trusted to orchestrate natively. CLI
    // providers run their own harness and never route through the shim, so
    // they are exempt.
    const shimUnreliable = modelMeta.provider !== 'cli' && hasRecentShim(modelMeta.modelId);
    if (!isReasoner && !noTools && !shimUnreliable) return modelName;

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
      return suitable.modelId;
    }
    coreLogger.warn(
      { candidateModel: modelMeta.modelId, reason },
      'Candidate model unsuitable for orchestration and no alternative configured — attempting anyway',
    );
    return modelName;
  }

  /**
   * Select the best model for a worker role's topic, with fallback for tool support.
   */
  async selectForWorker(topic: string, needsTools: boolean): Promise<ModelRouting> {
    const registry = getModelRegistry();
    const topicModel = await registry.getModelForTopic(topic);

    if (!topicModel) {
      coreLogger.warn(
        { topic },
        'No model mapped for topic — refusing to fall back to default. Map a model to this topic in the Models page.',
      );
      return { model: '', reason: `No model mapped for topic "${topic}"` };
    }

    const routing: ModelRouting = {
      model: topicModel.modelId,
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
    const model = await registry.getModelByModelId(routing.model);
    // Only the "can't do tools" case is interesting — a supported/CLI model
    // short-circuits with no log (findToolCapableFallback returns null too).
    if (!model || model.supportsTools || model.provider === 'cli') return null;

    const alt = await findToolCapableFallback(routing.model);
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
    return { model: alt.model, reason: `Fallback: ${alt.reason}` };
  }

  /**
   * Select a model based on message complexity.
   * Simple messages use a cheaper/faster model if available.
   */
  async selectByComplexity(complexity: 'simple' | 'moderate' | 'complex' = 'moderate'): Promise<string> {
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured. Set one in the Models page.');
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
        return cheapModel.modelId;
      }
    }

    return defaultModelId;
  }
}
