import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

function readAgentBridgeConfig(): { url: URL; key: string } {
  const url = new URL(process.env.OCTIPUS_AGENT_URL || '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('Agent bridge must be an HTTP loopback endpoint');
  }
  const key = process.env.OCTIPUS_AGENT_KEY;
  if (!key) throw new Error('Missing agent bridge capability');
  return { url, key };
}

/** Forward only to the capability issued by this agent's parent process. */
export async function agentBridgeRequest(path: '/tools' | '/call', body?: unknown): Promise<unknown> {
  const { url, key } = readAgentBridgeConfig();
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`Agent bridge rejected request (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

export function createAgentBridgeServer(): Server {
  readAgentBridgeConfig();
  const server = new Server({ name: 'octipus-agent', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ListToolsResultSchema.parse(await agentBridgeRequest('/tools')));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      return CallToolResultSchema.parse(await agentBridgeRequest('/call', { name: params.name, arguments: params.arguments ?? {} }));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
