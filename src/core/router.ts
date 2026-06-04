import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';

export interface RoutingDecision {
  model: string;
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
   * Route a message to the appropriate model
   */
  async route(message: string, preferredModel?: string): Promise<RoutingDecision> {
    // If a specific model is requested, use it
    if (preferredModel) {
      const registry = getModelRegistry();
      // Try by name first, then by modelId
      const model = await registry.getModel(preferredModel) || await registry.getModelByModelId(preferredModel);

      if (model) {
        return {
          model: model.modelId,
          topic: 'specified',
          confidence: 1,
          reason: 'User-specified model',
        };
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

    // Get the best model for this topic
    const registry = getModelRegistry();
    const model = await registry.getModelForTopic(topic);

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
      topic,
      confidence,
      reason: `Best model for topic: ${topic}`,
    };
  }

  /**
   * Use LLM to classify complex messages
   */
  async classifyWithLLM(message: string): Promise<RoutingDecision> {
    const client = getLiteLLMClient();
    const registry = getModelRegistry();

    // Use default model for classification
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      return this.route(message);
    }

    try {
      const result = await client.complete({
        model: defaultModel.modelId,
        messages: [
          {
            role: 'system',
            content: `You are a message classifier. Classify the user's message into one of these topics:
- coding: Programming, debugging, implementation
- research: Code review, comparisons, analysis
- architecture: System design, technical specs, architecture decisions
- chat: General conversation, simple questions
- embedding: Vector/semantic search
- design: UI/UX, layout, styling
- devops: Docker, CI/CD, infrastructure, deployment
- security: Security analysis, vulnerabilities
- data: Databases, SQL, data pipelines
- ai: Machine learning, LLMs, RAG
- qa: Testing, QA, bug reports
- finance: Financial analysis, markets
- automation: Workflows, scheduling
- pm: Project management, planning
- writing: Documentation, technical writing

Respond with ONLY the topic name, nothing else.`,
            timestamp: new Date(),
          },
          {
            role: 'user',
            content: message,
            timestamp: new Date(),
          },
        ],
        maxTokens: 10,
        temperature: 0,
      });

      const topic = result.content.trim().toLowerCase();
      const validTopics = ['coding', 'research', 'architecture', 'chat', 'embedding', 'design', 'devops', 'security', 'data', 'ai', 'qa', 'finance', 'automation', 'pm', 'writing'];

      if (validTopics.includes(topic)) {
        const model = await registry.getModelForTopic(topic);

        return {
          model: model?.modelId || defaultModel.modelId,
          topic,
          confidence: 0.9,
          reason: 'LLM-classified topic',
        };
      }
    } catch (error) {
      coreLogger.warn({ error }, 'LLM classification failed, falling back to keyword matching');
    }

    // Fall back to keyword-based classification
    return this.route(message);
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
