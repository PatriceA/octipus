export { BaseTool, createParameterSchema, type ToolAvailability, type ToolContext, type ToolExecutionOptions } from './base-tool';
export { BrowserTool, browserTool } from './browser';
export { BrowserExtTool, browserExtTool } from './browser-ext';
export { DockerTool, dockerTool } from './docker';
export { DocumentsTool, documentsTool } from './documents';
export { EmailProcessorTool, emailProcessorTool } from './email-processor';
// Built-in tools — re-exported for direct import elsewhere. Registration
// is auto-discovered by `discoverTools()` (see `discovery.ts`); adding a
// new built-in tool no longer requires editing this file.
export { FilesystemTool, filesystemTool } from './filesystem';
export { GitTool, gitTool } from './git';
export { GitHubTool, githubTool } from './github';
export { GitLabTool, gitlabTool } from './gitlab';
export { GoogleWorkspaceTool, googleWorkspaceTool } from './google-workspace';
export { KnowledgeTool, knowledgeTool } from './knowledge';
export { MessagingTool, messagingTool } from './messaging';
export { Microsoft365Tool, microsoft365Tool } from './microsoft365';
export { ProfilesTool, profilesTool } from './profiles';
export { getToolRegistry, ToolRegistry, type ToolRegistryOptions } from './registry';
export { SchedulingTool, schedulingTool } from './scheduling';
export { ShellTool, shellTool } from './shell';
export { LocalShellOperations } from './shell/local-operations';
export type { ShellExecResult, ShellOperations } from './shell/operations';
export { TasksTool, tasksTool } from './tasks';
export { VisualTool, visualTool } from './visual';
export { VoiceCallTool } from './voice';
export { WebSearchTool, websearchTool } from './websearch';

import { loadPlugins, PluginTool } from '@/plugins';
import { toolLogger } from '@/utils/logger';
import { discoverTools } from './discovery';
import { getToolRegistry } from './registry';

/**
 * Register all built-in tools (auto-discovered) and plugins.
 *
 * Tool discovery walks `src/tools/<name>/index.ts`; see `discovery.ts`
 * for the convention. Plugins live in `extensions/` and are loaded by
 * `loadPlugins()`.
 */
export async function registerBuiltinTools(): Promise<void> {
  const registry = getToolRegistry();

  const discovered = await discoverTools();
  for (const { folder, tool } of discovered) {
    try {
      await registry.register(tool);
      toolLogger.debug({ folder, toolId: tool.id }, 'Tool auto-registered');
    } catch (err) {
      toolLogger.error(
        { folder, toolId: tool.id, error: (err as Error).message },
        'Auto-registration failed',
      );
    }
  }
  toolLogger.info({ count: discovered.length }, 'Built-in tools registered (auto-discovered)');

  // Load plugins from extensions/ directory
  const plugins = await loadPlugins();
  for (const plugin of plugins) {
    try {
      const pluginTool = new PluginTool(plugin);
      await registry.register(pluginTool);
      toolLogger.info(
        { pluginName: plugin.manifest.name, toolId: pluginTool.id },
        'Plugin tool registered',
      );
    } catch (err) {
      toolLogger.error(
        { pluginName: plugin.manifest.name, error: (err as Error).message },
        'Failed to register plugin tool',
      );
    }
  }

  // Populate availability cache so agents immediately skip unavailable tools
  const availability = await registry.checkAllAvailability();
  for (const [id, result] of availability) {
    if (!result.available) {
      toolLogger.info({ toolId: id, reason: result.reason }, 'Tool unavailable');
    }
  }
}
