import type { AgentContext, ToolManifest, ToolFunction, PermissionLevel } from '@/core/types';
import type { ToolHandler } from '@/core/agent-worker';
import { getPermissionManager } from '@/security/permissions';
import { injectSecrets } from '@/security/secret-injector';
import { toolLogger } from '@/utils/logger';

export interface ToolContext extends AgentContext {
  toolId: string;
}

export interface ToolExecutionOptions {
  requiresPermission?: boolean;
  permissionAction?: string;
  injectSecrets?: boolean;
}

export abstract class BaseTool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly description: string;

  protected tools: Map<string, ToolHandler> = new Map();

  /**
   * Get the tool manifest
   */
  abstract getManifest(): ToolManifest;

  /**
   * Initialize the tool
   */
  async initialize(): Promise<void> {
    toolLogger.debug({ toolId: this.id }, 'Tool initializing');
    await this.registerTools();
    toolLogger.info({ toolId: this.id, toolCount: this.tools.size }, 'Tool initialized');
  }

  /**
   * Register all tools provided by this tool
   */
  protected abstract registerTools(): Promise<void>;

  /**
   * Register a single tool
   */
  protected registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>,
    options?: ToolExecutionOptions
  ): void {
    const handler: ToolHandler = {
      name: `${this.id}__${name}`,
      description,
      parameters,
      execute: async (args, context) => {
        return this.executeWithMiddleware(name, args, context, execute, options);
      },
    };

    this.tools.set(name, handler);
  }

  /**
   * Execute tool with permission checking and secret injection
   */
  private async executeWithMiddleware(
    toolName: string,
    args: Record<string, unknown>,
    context: AgentContext,
    execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>,
    options?: ToolExecutionOptions
  ): Promise<unknown> {
    const toolContext: ToolContext = { ...context, toolId: this.id };

    // Check permissions if required
    if (options?.requiresPermission !== false) {
      const permissionManager = getPermissionManager();
      const action = options?.permissionAction || toolName;

      const check = await permissionManager.check(context.userId, this.id, action, args);

      if (!check.allowed) {
        if (check.requiresApproval) {
          // Request approval
          const requestId = await permissionManager.requestApproval(
            context.userId,
            context.id,
            this.id,
            action,
            args,
            context.sessionId
          );

          toolLogger.info(
            { toolId: this.id, tool: toolName, requestId },
            'Awaiting permission approval'
          );

          // Wait for approval (this will block until approved/denied/timeout)
          const approved = await permissionManager.waitForApproval(requestId);

          if (!approved) {
            throw new Error(`Permission denied for ${this.id}.${action}`);
          }
        } else {
          throw new Error(`Permission denied for ${this.id}.${action}: ${check.reason}`);
        }
      }
    }

    // Inject secrets if needed
    let processedArgs = args;
    if (options?.injectSecrets !== false) {
      processedArgs = await this.injectSecretsInArgs(args, context.userId);
    }

    // Execute the tool
    toolLogger.debug({ toolId: this.id, tool: toolName }, 'Executing tool');

    try {
      const result = await execute(processedArgs, toolContext);
      toolLogger.debug({ toolId: this.id, tool: toolName }, 'Tool executed successfully');
      return result;
    } catch (error) {
      toolLogger.error({ error, toolId: this.id, tool: toolName }, 'Tool execution failed');
      throw error;
    }
  }

  /**
   * Inject secrets in tool arguments
   */
  private async injectSecretsInArgs(
    args: Record<string, unknown>,
    userId: string
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        const { content } = await injectSecrets(value, { userId, toolId: this.id });
        result[key] = content;
      } else if (typeof value === 'object' && value !== null) {
        result[key] = await this.injectSecretsInArgs(value as Record<string, unknown>, userId);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Get all tool handlers
   */
  getToolHandlers(): ToolHandler[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool handler
   */
  getTool(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  /**
   * Shutdown the tool
   */
  async shutdown(): Promise<void> {
    toolLogger.debug({ toolId: this.id }, 'Tool shutting down');
  }
}

/**
 * Helper to create JSON schema for tool parameters
 */
export function createParameterSchema(params: Record<string, {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, config] of Object.entries(params)) {
    properties[name] = {
      type: config.type,
      description: config.description,
      ...(config.default !== undefined && { default: config.default }),
      ...(config.enum && { enum: config.enum }),
    };

    if (config.required) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}
