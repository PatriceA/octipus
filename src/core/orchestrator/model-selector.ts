import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';

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
  async selectForOrchestration(): Promise<string> {
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured. Set one in the Models page.');
    }
    let modelName = defaultModel.modelId;

    {
      const isReasoner = defaultModel.modelId.includes('reasoner') || defaultModel.modelId.includes('thinking');
      const noTools = !defaultModel.supportsTools && defaultModel.provider !== 'cli';
      if (isReasoner || noTools) {
        const allModels = await registry.getAllModels();
        const suitable = allModels.find(m =>
          m.supportsTools &&
          !m.modelId.includes('reasoner') &&
          !m.modelId.includes('thinking') &&
          m.provider !== 'cli'
        );
        if (suitable) {
          modelName = suitable.modelId;
          coreLogger.info(
            { defaultModel: defaultModel.modelId, selectedModel: modelName },
            'Default model unsuitable for orchestration, using alternative',
          );
        }
      }
    }

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
