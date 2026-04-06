import { BaseTool, type ToolAvailability } from './base-tool';
import type { ToolHandler } from '@/core/agent-worker';
import type { ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';

export interface ToolRegistryOptions {
  autoInitialize?: boolean;
}

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();
  private initialized: Set<string> = new Set();
  private availabilityCache: Map<string, { result: ToolAvailability; checkedAt: number }> = new Map();
  private static AVAILABILITY_TTL = 60_000; // Cache for 60s

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
   * Check availability of a single tool (cached).
   */
  async checkAvailability(toolId: string): Promise<ToolAvailability> {
    const cached = this.availabilityCache.get(toolId);
    if (cached && Date.now() - cached.checkedAt < ToolRegistry.AVAILABILITY_TTL) {
      return cached.result;
    }

    const tool = this.tools.get(toolId);
    if (!tool) return { available: false, reason: 'Tool not found' };

    try {
      const result = await tool.checkAvailability();
      this.availabilityCache.set(toolId, { result, checkedAt: Date.now() });
      return result;
    } catch (error) {
      const result: ToolAvailability = { available: false, reason: (error as Error).message };
      this.availabilityCache.set(toolId, { result, checkedAt: Date.now() });
      return result;
    }
  }

  /**
   * Check availability of all tools.
   */
  async checkAllAvailability(): Promise<Map<string, ToolAvailability>> {
    const results = new Map<string, ToolAvailability>();
    await Promise.all(
      Array.from(this.tools.keys()).map(async (id) => {
        results.set(id, await this.checkAvailability(id));
      }),
    );
    return results;
  }

  /**
   * Invalidate availability cache (e.g., after settings change).
   */
  invalidateAvailabilityCache(): void {
    this.availabilityCache.clear();
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
   * Get tool handlers for specific tools, skipping unavailable ones.
   */
  getToolHandlersForTools(toolIds: string[]): ToolHandler[] {
    const handlers: ToolHandler[] = [];

    for (const toolId of toolIds) {
      const tool = this.tools.get(toolId);
      if (tool && this.initialized.has(toolId)) {
        // Use cached availability — only skip if the cache entry is fresh AND unavailable
        const cached = this.availabilityCache.get(toolId);
        if (cached && !cached.result.available && Date.now() - cached.checkedAt < ToolRegistry.AVAILABILITY_TTL) {
          toolLogger.info({ toolId, cacheAge: Date.now() - cached.checkedAt, reason: cached.result.reason }, 'Skipping unavailable tool for agent');
          continue;
        }
        const toolHandlers = tool.getToolHandlers();
        if (toolHandlers.length === 0) {
          toolLogger.warn({ toolId, initialized: this.initialized.has(toolId), cached: cached ? { available: cached.result.available, age: Date.now() - cached.checkedAt } : null }, 'Tool returned 0 handlers');
        }
        handlers.push(...toolHandlers);
      } else if (!tool) {
        toolLogger.warn({ toolId, registeredTools: Array.from(this.tools.keys()) }, 'Tool not found in registry');
      } else if (!this.initialized.has(toolId)) {
        toolLogger.warn({ toolId }, 'Tool not initialized');
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
