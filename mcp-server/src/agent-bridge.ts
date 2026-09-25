import { request } from 'node:http';
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

/**
 * Forward only to the capability issued by this agent's parent process.
 * node:http, not fetch: undici's default 300 s headersTimeout cut off any tool
 * call that waits longer (collect_children waits up to a child's 10 min wall)
 * with "fetch failed". http.request has no response timeout; the CLI's own
 * MCP tool timeout bounds the call, and its cancellation arrives as `signal`.
 */
export async function agentBridgeRequest(path: '/tools' | '/call', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const { url, key } = readAgentBridgeConfig();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(new URL(path, url), {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
  const result: unknown = JSON.parse(text);
  if (status < 200 || status >= 300) throw new Error(`Agent bridge rejected request (${status}): ${JSON.stringify(result)}`);
  return result;
}

export function createAgentBridgeServer(): Server {
  readAgentBridgeConfig();
  const server = new Server({ name: 'octipus-agent', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ListToolsResultSchema.parse(await agentBridgeRequest('/tools')));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    // Claude Code gives up on a call that sends no response or progress for
    // 1800 s, and collect_children can wait a child's whole wall (1 h). A
    // heartbeat keeps a long wait alive when the client asked for progress.
    const progressToken = params._meta?.progressToken;
    let progress = 0;
    const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++progress } })
        .catch(() => { /* the response itself still reports the outcome */ });
    }, 60_000);
    try {
      // Pass cancellation through so the backend sees the drop and keeps the result.
      return CallToolResultSchema.parse(await agentBridgeRequest('/call', { name: params.name, arguments: params.arguments ?? {} }, extra.signal));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    } finally {
      clearInterval(heartbeat);
    }
  });
  return server;
}
