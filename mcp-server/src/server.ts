import { withToolDeadline } from './tool-deadline.js';
/**
 * MCP Server setup — creates the McpServer instance and registers all tools.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OctiClient } from './client.js';
import { registerSearchTools } from './tools/search.js';
import { registerAgentTools } from './tools/agents.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerModelTools } from './tools/models.js';
import { registerChatTools } from './tools/chat.js';
import { registerToolModuleTools } from './tools/tool-modules.js';
import { registerRecurringTaskTools } from './tools/recurring-tasks.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerSkillTools } from './tools/skills.js';
import { registerProfileTools } from './tools/profiles.js';
import { registerPluginTools } from './tools/plugins.js';
import { registerPipelineTools } from './tools/pipelines.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerSettingTools } from './tools/settings.js';
import { registerGatewayTools } from './tools/gateway.js';
import { registerHealthTools } from './tools/health.js';
import { registerAuditTools } from './tools/audit.js';
import { registerArtifactTools } from './tools/artifacts.js';
import { registerTasksTools } from './tools/tasks.js';
import { registerNotesTools } from './tools/notes.js';
import { registerEmailTools } from './tools/email.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerResearchTools } from './tools/research.js';
import { registerReaderTools } from './tools/reader.js';

/**
 * The version this server reports in the MCP handshake.
 *
 * Read from the package rather than written here: a client that asks which
 * bridge it is talking to was told `1.0.0` by every build ever shipped, which
 * is the same drift that left `package.json` at 0.1.0 for four releases. Falls
 * back to `0.0.0` rather than throwing — a handshake is not worth failing over
 * a manifest that could not be read.
 */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** How often the modules that are on are read again. */
const MODULES_REFRESH_MS = 60_000;

/** The tools `register` adds to `server`. */
function collect(server: McpServer, register: () => void): RegisteredTool[] {
  const added: RegisteredTool[] = [];
  const target = server as unknown as Record<'tool' | 'registerTool', (...args: unknown[]) => RegisteredTool>;
  const originals = { tool: target.tool, registerTool: target.registerTool };
  for (const name of ['tool', 'registerTool'] as const) {
    const original = originals[name];
    if (typeof original !== 'function') continue;
    target[name] = (...args: unknown[]) => {
      const registered = original.apply(server, args);
      added.push(registered);
      return registered;
    };
  }
  try {
    register();
  } finally {
    target.tool = originals.tool;
    target.registerTool = originals.registerTool;
  }
  return added;
}

/**
 * Show the tools of the modules that are on and hide the rest. Until the
 * server answers, every module tool stays hidden; when it cannot be read,
 * the last answer stands.
 */
async function syncModules(client: OctiClient, byModule: Record<string, RegisteredTool[]>): Promise<void> {
  let enabled: string[];
  try {
    enabled = await client.getEnabledModules();
  } catch {
    return;
  }
  for (const [module, tools] of Object.entries(byModule)) {
    const on = enabled.includes(module);
    for (const tool of tools) {
      if (on && !tool.enabled) tool.enable();
      if (!on && tool.enabled) tool.disable();
    }
  }
}

export function createServer(octiUrl: string): McpServer {
  const server = new McpServer({
    name: 'octipus',
    version: packageVersion(),
  });

  // Bound every handler, including authentication and local work before HTTP.
  for (const method of ['tool', 'registerTool'] as const) {
    const target = server as unknown as Record<typeof method, (...args: unknown[]) => RegisteredTool>;
    const register = target[method].bind(server);
    target[method] = (...args: unknown[]) => {
      const index = args.length - 1;
      const callback = args[index];
      if (typeof callback === 'function') args[index] = (...input: unknown[]) => withToolDeadline(() => callback(...input));
      return register(...args);
    };
  }

  const client = new OctiClient(octiUrl);

  // Register all tool groups
  registerSearchTools(server, client);
  registerAgentTools(server, client);
  registerSessionTools(server, client);
  registerModelTools(server, client);
  registerChatTools(server, client);
  registerToolModuleTools(server, client);
  registerRecurringTaskTools(server, client);
  registerKnowledgeTools(server, client);
  registerSkillTools(server, client);
  registerPluginTools(server, client);
  registerPipelineTools(server, client);
  registerDocumentTools(server, client);
  registerSettingTools(server, client);
  registerGatewayTools(server, client);
  registerHealthTools(server, client);
  registerAuditTools(server, client);
  // Newer end-user features — previously absent from the MCP surface.
  registerTasksTools(server, client);
  registerNotesTools(server, client);
  registerMemoryTools(server, client);

  // The groups of a module (docs/MODULES.md): hidden while it is off.
  const byModule: Record<string, RegisteredTool[]> = {
    channels: collect(server, () => registerMessagingTools(server, client)),
    people: collect(server, () => registerProfileTools(server, client)),
    artifacts: collect(server, () => registerArtifactTools(server, client)),
    inbox: collect(server, () => registerEmailTools(server, client)),
    research: collect(server, () => registerResearchTools(server, client)),
    reader: collect(server, () => registerReaderTools(server, client)),
  };
  for (const tool of Object.values(byModule).flat()) tool.disable();
  void syncModules(client, byModule);
  const timer = setInterval(() => void syncModules(client, byModule), MODULES_REFRESH_MS);
  timer.unref?.();
  // One server per HTTP session: the refresh ends with it.
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    clearInterval(timer);
    onclose?.();
  };

  return server;
}
