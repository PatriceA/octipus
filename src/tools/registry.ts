import { BaseTool } from './base-tool';
import type { ToolHandler } from '@/core/agent-worker';
import type { ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';

export interface ToolRegistryOptions {
  autoInitialize?: boolean;
}

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();
  private initialized: Set<string> = new Set();

  /**
   * Register a tool
   */
  async register(tool: BaseTool, options?: ToolRegistryOptions): Promise<void> {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }

    this.tools.set(tool.id, tool);

    if (options?.autoInitialize !== false) {
      await this.initialize(tool.id);
    }

    toolLogger.info({ toolId: tool.id, name: tool.name, version: tool.version }, 'Tool registered');
  }

  /**
   * Initialize a tool
   */
  async initialize(toolId: string): Promise<void> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }

    if (this.initialized.has(toolId)) {
      return;
    }

    await tool.initialize();
    this.initialized.add(toolId);
  }

  /**
   * Initialize all registered tools
   */
  async initializeAll(): Promise<void> {
    for (const toolId of this.tools.keys()) {
      if (!this.initialized.has(toolId)) {
        await this.initialize(toolId);
      }
    }
  }

  /**
   * Get a tool by ID
   */
  get(toolId: string): BaseTool | undefined {
    return this.tools.get(toolId);
  }

  /**
   * Get all registered tools
   */
  getAll(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool manifests
   */
  getManifests(): ToolManifest[] {
    return this.getAll().map((tool) => tool.getManifest());
  }

  /**
   * Get all tool handlers from all tools
   */
  getAllToolHandlers(): ToolHandler[] {
    const handlers: ToolHandler[] = [];

    for (const tool of this.tools.values()) {
      if (this.initialized.has(tool.id)) {
        handlers.push(...tool.getToolHandlers());
      }
    }

    return handlers;
  }

  /**
   * Get tool handlers for specific tools
   */
  getToolHandlersForTools(toolIds: string[]): ToolHandler[] {
    const handlers: ToolHandler[] = [];

    for (const toolId of toolIds) {
      const tool = this.tools.get(toolId);
      if (tool && this.initialized.has(toolId)) {
        handlers.push(...tool.getToolHandlers());
      }
    }

    return handlers;
  }

  /**
   * Find a tool handler by full name (toolId__toolName)
   */
  findTool(fullName: string): ToolHandler | undefined {
    const [toolId, toolName] = fullName.split('__');
    const tool = this.tools.get(toolId);

    if (!tool || !this.initialized.has(toolId)) {
      return undefined;
    }

    return tool.getTool(toolName);
  }

  /**
   * Unregister a tool
   */
  async unregister(toolId: string): Promise<boolean> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return false;
    }

    if (this.initialized.has(toolId)) {
      await tool.shutdown();
      this.initialized.delete(toolId);
    }

    this.tools.delete(toolId);
    toolLogger.info({ toolId }, 'Tool unregistered');

    return true;
  }

  /**
   * Shutdown all tools
   */
  async shutdownAll(): Promise<void> {
    for (const [toolId, tool] of this.tools) {
      if (this.initialized.has(toolId)) {
        await tool.shutdown();
        this.initialized.delete(toolId);
      }
    }

    toolLogger.info('All tools shut down');
  }

  /**
   * Check if a tool is registered
   */
  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  /**
   * Check if a tool is initialized
   */
  isInitialized(toolId: string): boolean {
    return this.initialized.has(toolId);
  }

  /**
   * Get tool count
   */
  get count(): number {
    return this.tools.size;
  }

  /**
   * Get initialized tool count
   */
  get initializedCount(): number {
    return this.initialized.size;
  }
}

// Singleton instance
let registryInstance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRegistry();
  }
  return registryInstance;
}
