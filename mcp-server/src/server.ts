/**
 * MCP Server setup — creates the McpServer instance and registers all tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AssistantClient } from './client.js';
import { registerSearchTools } from './tools/search.js';
import { registerAgentTools } from './tools/agents.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerModelTools } from './tools/models.js';
import { registerChatTools } from './tools/chat.js';
import { registerToolModuleTools } from './tools/tool-modules.js';
import { registerExpertTools } from './tools/experts.js';
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

export function createServer(assistantUrl: string): McpServer {
  const server = new McpServer({
    name: 'assistant',
    version: '1.0.0',
  });

  const client = new AssistantClient(assistantUrl);

  // Register all tool groups
  registerSearchTools(server, client);
  registerAgentTools(server, client);
  registerSessionTools(server, client);
  registerModelTools(server, client);
  registerChatTools(server, client);
  registerToolModuleTools(server, client);
  registerExpertTools(server, client);
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

  return server;
}
