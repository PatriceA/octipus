import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { hasRecentShim } from './model-capability';
import { getSessionModel } from './session-model-override';

interface ModelRouting {
  model: string;
  reason: string;
}

/**
 * Encapsulates model selection logic for the orchestrator and worker agents.
 */
export class ModelSelector {
  /**
   * Select a model suitable for orchestration (must support tools, no reasoning models).
   */
  async selectForOrchestration(sessionId?: string): Promise<string> {
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
          return this.validateOrchestratorModel(override.modelId, override);
        }
        coreLogger.warn(
          { sessionId, overrideId },
          'Session model override points to an unregistered model — falling back to default',
        );
      }
    }

    // The 'chat' lane binding, when set, is the explicit home for the
    // orchestrator/conversation model (topic consolidation made this real —
    // 'chat' previously had no consumer). Unbound ⇒ default model, as before.
    const chatModel = await registry.getModelForTopic('chat');
    if (chatModel) {
      return this.validateOrchestratorModel(chatModel.modelId, chatModel);
    }

    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured. Set one in the Models page.');
    }
    return this.validateOrchestratorModel(defaultModel.modelId, defaultModel);
  }

  /**
   * Reject reasoning / no-tools models in favor of a working alternative.
   * Matters when the user explicitly overrides too — see the override
   * branch above. Returns the final model id the orchestrator should run with.
   */
  private async validateOrchestratorModel(
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
        'Orchestrator model rerouted — it cannot reliably emit native tool calls',
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

    if (!model || model.supportsTools || model.provider === 'cli') {
      return null; // Already supports tools or is CLI — no change needed
    }

    coreLogger.info(
      { model: routing.model },
      'Routed model does not support tools, finding alternative',
    );

    // Only fall back to local models (ollama) to avoid unexpected API costs
    const localProviders = ['ollama'];

    // Try default model first
    const defaultModel = await registry.getDefaultModel();
    if (defaultModel && defaultModel.supportsTools
        && defaultModel.modelId !== routing.model
        && localProviders.includes(defaultModel.provider)) {
      return {
        model: defaultModel.modelId,
        reason: 'Fallback: routed model does not support tool calling',
      };
    }

    // Find any local model with tool support
    const allModels = await registry.getAllModels();
    const toolModel = allModels.find(m =>
      m.supportsTools
      && m.provider !== 'cli'
      && localProviders.includes(m.provider)
      && m.modelId !== routing.model
    );

    if (toolModel) {
      coreLogger.info(
        { fallbackModel: toolModel.modelId },
        'Found alternative local model with tool support',
      );
      return {
        model: toolModel.modelId,
        reason: `Fallback: using ${toolModel.name} for tool support`,
      };
    }

    coreLogger.warn(
      { model: routing.model },
      'No local model with tool support found — proceeding without tools',
    );
    return null;
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
