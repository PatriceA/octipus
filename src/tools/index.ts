export { BaseTool, createParameterSchema, type ToolContext, type ToolExecutionOptions } from './base-tool';
export { ToolRegistry, getToolRegistry, type ToolRegistryOptions } from './registry';

// Built-in tools
export { FilesystemTool, filesystemTool } from './filesystem';
export { ShellTool, shellTool } from './shell';
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
}
