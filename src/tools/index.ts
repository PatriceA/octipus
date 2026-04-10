export { BaseTool, createParameterSchema, type ToolContext, type ToolExecutionOptions, type ToolAvailability } from './base-tool';
export { ToolRegistry, getToolRegistry, type ToolRegistryOptions } from './registry';

// Built-in tools
export { FilesystemTool, filesystemTool } from './filesystem';
export { ShellTool, shellTool } from './shell';
export type { ShellOperations, ShellExecResult } from './shell/operations';
export { LocalShellOperations } from './shell/local-operations';
export { GitTool, gitTool } from './git';
export { BrowserTool, browserTool } from './browser';
export { WebSearchTool, websearchTool } from './websearch';
export { DockerTool, dockerTool } from './docker';
export { GitHubTool, githubTool } from './github';
export { GitLabTool, gitlabTool } from './gitlab';
export { GoogleWorkspaceTool, googleWorkspaceTool } from './google-workspace';
export { Microsoft365Tool, microsoft365Tool } from './microsoft365';
export { KnowledgeTool, knowledgeTool } from './knowledge';
export { MessagingTool, messagingTool } from './messaging';
export { BrowserExtTool, browserExtTool } from './browser-ext';
export { SchedulingTool, schedulingTool } from './scheduling';
export { DocumentsTool, documentsTool } from './documents';
export { ProfilesTool, profilesTool } from './profiles';
export { EmailProcessorTool, emailProcessorTool } from './email-processor';
export { VoiceCallTool } from './voice';

import { getToolRegistry } from './registry';
import { filesystemTool } from './filesystem';
import { shellTool } from './shell';
import { gitTool } from './git';
import { browserTool } from './browser';
import { websearchTool } from './websearch';
import { dockerTool } from './docker';
import { githubTool } from './github';
import { gitlabTool } from './gitlab';
import { googleWorkspaceTool } from './google-workspace';
import { microsoft365Tool } from './microsoft365';
import { knowledgeTool } from './knowledge';
import { messagingTool } from './messaging';
import { browserExtTool } from './browser-ext';
import { schedulingTool } from './scheduling';
import { documentsTool } from './documents';
import { profilesTool } from './profiles';
import { emailProcessorTool } from './email-processor';
import { VoiceCallTool } from './voice';
import { loadPlugins, PluginTool } from '@/plugins';
import { toolLogger } from '@/utils/logger';

/**
 * Register all built-in tools
 */
export async function registerBuiltinTools(): Promise<void> {
  const registry = getToolRegistry();

  await registry.register(filesystemTool);
  await registry.register(shellTool);
  await registry.register(gitTool);
  await registry.register(browserTool);
  await registry.register(websearchTool);
  await registry.register(dockerTool);
  await registry.register(githubTool);
  await registry.register(gitlabTool);
  await registry.register(googleWorkspaceTool);
  await registry.register(microsoft365Tool);
  await registry.register(knowledgeTool);
  await registry.register(messagingTool);
  await registry.register(browserExtTool);
  await registry.register(schedulingTool);
  await registry.register(documentsTool);
  await registry.register(profilesTool);
  await registry.register(emailProcessorTool);
  await registry.register(new VoiceCallTool());

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
