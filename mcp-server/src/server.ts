/**
 * MCP Server setup — creates the McpServer instance and registers all tools.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

export function createServer(octiUrl: string): McpServer {
  const server = new McpServer({
    name: 'octipus',
    version: packageVersion(),
  });

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
  registerMessagingTools(server, client);
  registerSkillTools(server, client);
  registerProfileTools(server, client);
  registerPluginTools(server, client);
  registerPipelineTools(server, client);
  registerDocumentTools(server, client);
  registerSettingTools(server, client);
  registerGatewayTools(server, client);
  registerHealthTools(server, client);
  registerAuditTools(server, client);
  registerArtifactTools(server, client);
  // Newer end-user features — previously absent from the MCP surface.
  registerTasksTools(server, client);
  registerNotesTools(server, client);
  registerEmailTools(server, client);
  registerMemoryTools(server, client);
  registerResearchTools(server, client);
  registerReaderTools(server, client);

  return server;
}
