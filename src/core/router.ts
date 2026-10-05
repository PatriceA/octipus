import type { ModelConfigEntry } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { resolveModel } from '@/models/resolve-model';
import { coreLogger } from '@/utils/logger';

/** No requester (system work): install rows only, by name then modelId. */
async function installModelByNameOrId(nameOrId: string): Promise<ModelConfigEntry | null> {
  const registry = getModelRegistry();
  const byName = await registry.getModel(nameOrId);
  if (byName && !byName.ownerUserId) return byName;
  return registry.getModelByModelId(nameOrId);
}

export interface RoutingDecision {
  model: string;
  /** Registry row identity (`model_config.name`); absent for a pass-through model id. */
  modelName?: string;
  topic: string;
  confidence: number;
  reason?: string;
}

const TOPIC_KEYWORDS: Record<string, string[]> = {
  coding: [
    'code', 'function', 'bug', 'error', 'implement', 'debug', 'fix', 'refactor',
    'typescript', 'javascript', 'python', 'rust', 'go', 'java',
    'api', 'backend', 'frontend', 'compile', 'build', 'package',
  ],
  research: [
    'analyze', 'review', 'explain', 'understand', 'compare', 'evaluate',
    'pros', 'cons', 'pattern', 'best practice',
  ],
  architecture: [
    'architecture', 'system design', 'design the system', 'technical specification',
    'component diagram', 'data flow', 'api contract', 'adr', 'architecture decision',
    'microservices', 'monolith', 'event-driven', 'design document',
  ],
  chat: [
    'hello', 'hi', 'hey', 'thanks', 'help', 'how are', 'what is',
    'tell me', 'simple', 'quick',
  ],
  embedding: [
    'embed', 'vector', 'similarity', 'semantic',
  ],
  design: [
    'ui', 'ux', 'layout', 'color', 'font', 'responsive', 'accessibility',
    'wireframe', 'mockup', 'figma', 'css', 'tailwind', 'style',
  ],
  devops: [
    'docker', 'container', 'kubernetes', 'k8s', 'ci/cd', 'pipeline', 'deploy',
    'nginx', 'infrastructure', 'terraform', 'ansible', 'helm', 'compose',
  ],
  security: [
    'security', 'vulnerability', 'owasp', 'xss', 'injection', 'auth',
    'encryption', 'certificate', 'firewall', 'pentest', 'threat',
  ],
  data: [
    'database', 'sql', 'postgres', 'mysql', 'redis', 'migration',
    'schema', 'query', 'etl', 'data pipeline', 'warehouse',
  ],
  ai: [
    'machine learning', 'ml', 'model', 'training', 'inference', 'rag',
    'llm', 'prompt', 'fine-tune', 'embedding', 'neural', 'transformer',
  ],
  qa: [
    'test', 'testing', 'playwright', 'selenium', 'e2e', 'unit test',
    'integration test', 'coverage', 'regression', 'bug report',
  ],
  finance: [
    'finance', 'stock', 'market', 'investment', 'revenue', 'budget',
    'forecast', 'accounting', 'portfolio', 'trading',
  ],
  automation: [
    'workflow', 'automate', 'cron', 'schedule', 'n8n', 'webhook',
    'trigger', 'bpmn', 'orchestrate', 'batch',
  ],
  pm: [
    'project', 'milestone', 'sprint', 'kanban', 'roadmap', 'timeline',
    'estimate', 'stakeholder', 'backlog', 'requirement',
  ],
  writing: [
    'document', 'documentation', 'readme', 'guide', 'tutorial',
    'blog', 'article', 'report', 'specification', 'changelog',
  ],
};

export class Router {
  /**
   * Classify the topic of a message
   */
  classifyTopic(message: string): { topic: string; confidence: number } {
    const lowerMessage = message.toLowerCase();
    const scores: Record<string, number> = {};

    // Score each topic based on keyword matches
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      let score = 0;
      for (const keyword of keywords) {
        if (lowerMessage.includes(keyword)) {
          score++;
        }
      }
      scores[topic] = score;
    }

    // Find the topic with the highest score
    let bestTopic = 'general';
    let bestScore = 0;

    for (const [topic, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestTopic = topic;
      }
    }

    // Calculate confidence (normalized)
    const _totalKeywords = Math.max(...Object.values(TOPIC_KEYWORDS).map((k) => k.length));
    const confidence = bestScore > 0 ? Math.min(bestScore / 5, 1) : 0.3;

    return { topic: bestTopic, confidence };
  }

  /**
   * Route a message to the appropriate model. `requester.userId` scopes both
   * the explicit choice (only rows that user may see) and the topic route (the
   * user's personal binding first) — coworking spec §8.2.
   */
  async route(message: string, preferredModel?: string, requester: { userId?: string; inSpace?: boolean; sponsor?: import('@/core/types').AgentSponsor | null } = {}): Promise<RoutingDecision> {
    // If a specific model is requested, use it
    if (preferredModel) {
      // By name first, then by modelId — only rows the requester may see.
      const model = requester.userId
        ? await resolveModel({ userId: requester.userId, name: preferredModel, inSpace: requester.inSpace, sponsor: requester.sponsor })
        : await installModelByNameOrId(preferredModel);

      if (model) {
        return {
          model: model.modelId,
          modelName: model.name,
          topic: 'specified',
          confidence: 1,
          reason: 'User-specified model',
        };
      }
      // Unknown `/`-names would pass through as OpenRouter ids. A name that is a
      // registered row the requester may not see (another user's personal
      // model, `u/<id>/<slug>`) must not: check ownership before passing through.
      if (await getModelRegistry().isPersonalModelName(preferredModel)) {
        throw new Error(`Model '${preferredModel}' is not available to you`);
      }
      // If not in DB, pass through directly (user may specify a LiteLLM model name)
      return {
        model: preferredModel,
        topic: 'specified',
        confidence: 0.8,
        reason: 'Model not in registry, passing through directly',
      };
    }

    // Classify the topic
    const { topic, confidence } = this.classifyTopic(message);

    // Get the best model for this topic: the requester's personal binding
    // first, then the install binding (§8.2).
    const registry = getModelRegistry();
    const model = await resolveModel({ userId: requester.userId, topic, inSpace: requester.inSpace, sponsor: requester.sponsor });

    if (!model) {
      // Fall back to default
      const defaultModel = await registry.getDefaultModel();

      if (!defaultModel) {
        return {
          model: null as any,
          topic,
          confidence,
          reason: 'No model configured. Please add one in the Models page.',
        };
      }

      return {
        model: defaultModel.modelId,
        modelName: defaultModel.name,
        topic,
        confidence,
        reason: 'Default model (no topic-specific model available)',
      };
    }

    coreLogger.debug(
      { topic, model: model.modelId, confidence },
      'Routed message to model'
    );

    return {
      model: model.modelId,
      modelName: model.name,
      topic,
      confidence,
      reason: `Best model for topic: ${topic}`,
    };
  }

  /**
   * Get available models for a topic
   */
  async getModelsForTopic(topic: string): Promise<string[]> {
    const registry = getModelRegistry();
    const allModels = await registry.getAllModels();

    return allModels
      .filter((m) => m.topics?.includes(topic) || m.topics?.length === 0)
      .map((m) => m.name);
  }

  /**
   * Check if a model supports vision
   */
  async supportsVision(modelName: string): Promise<boolean> {
    const registry = getModelRegistry();
    const model = await registry.getModel(modelName);
    return model?.supportsVision || false;
  }

  /**
   * Check if a model supports tools/function calling
   */
  async supportsTools(modelName: string): Promise<boolean> {
    const registry = getModelRegistry();
    const model = await registry.getModel(modelName);
    return model?.supportsTools || false;
  }
}

// Singleton instance
let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (!routerInstance) {
    routerInstance = new Router();
  }
  return routerInstance;
}
