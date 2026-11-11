// A plugin package's MCP server that keeps per-user data in the store:
// newline-delimited JSON-RPC 2.0 over stdio, no dependencies.
//
// OCTIPUS_PLUGIN_DATA_DIR is shared by every user of the install: never keep a
// user's data there. The store is kept by Octipus for each user apart: a call's
// token (in `_meta["octipus/host"]`) names the user who asked, and the store
// answers for that user only. Reach it through the egress proxy (HTTP_PROXY),
// at `<url>/api/plugin-host/store/<key>`, with `Authorization: Bearer <token>`.
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const NAME = 'my-store';
const VERSION = '0.1.0';

class ToolError extends Error {}

/** One JSON request to the host API, absolute-form through HTTP_PROXY (as an HTTP proxy expects). */
function hostRequest(host, method, path, body) {
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return Promise.reject(new ToolError('The Octipus host API is not reachable (no egress proxy); is the plugin enabled with its host scopes approved?'));
  const p = new URL(proxy);
  const target = new URL(`${host.url}/api/plugin-host${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      host: p.hostname, port: Number(p.port || 80), method, path: target.href,
      headers: {
        host: target.host,
        authorization: `Bearer ${host.token}`,
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: json ?? {} });
      });
    });
    req.on('error', (err) => reject(new ToolError(`The Octipus host API could not be reached: ${err.message}`)));
    req.end(payload);
  });
}

/** A store request with the call's token; the answer, or null for a missing key. */
async function store(hostMeta, scope, method, path, body) {
  if (!hostMeta) throw new ToolError('This call carries no host API token: the plugin\'s host scopes are not approved, or it was not started by a user');
  if (!hostMeta.scopes?.includes(scope)) throw new ToolError(`This call may not use ${scope}`);
  const res = await hostRequest(hostMeta, method, path, body);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new ToolError(res.body?.error || `The host API answered ${res.status}`);
  return res.body;
}

/** A store key: letters, digits and . _ : / - (no empty, "." or ".." segment). */
const keyOf = (name) => `memo/${String(name ?? 'note').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100) || 'note'}`;

// Every tool here must be declared in octipus-plugin.json with its effect;
// one that is not is hidden from agents and refused. A read tool's token never
// carries store:write.
const TOOLS = [
  {
    name: 'remember',
    description: 'Remember a short text for the user who asks, under a name',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'What to call it (default: note)' }, text: { type: 'string', description: 'The text' } },
      required: ['text'],
    },
    run: async (args, hostMeta) => {
      const out = await store(hostMeta, 'store:write', 'PUT', `/store/${keyOf(args.name)}`, { value: { text: String(args.text ?? ''), at: new Date().toISOString() } });
      return `remembered (version ${out.version})`;
    },
  },
  {
    name: 'recall',
    description: 'Recall what the user who asks remembered under a name, or list the names',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The name; leave it out to list them' } } },
    run: async (args, hostMeta) => {
      if (args.name === undefined) {
        const out = await store(hostMeta, 'store:read', 'GET', '/store?prefix=memo/');
        return out.keys.length ? out.keys.map((k) => k.key.slice('memo/'.length)).join(', ') : 'nothing remembered yet';
      }
      const entry = await store(hostMeta, 'store:read', 'GET', `/store/${keyOf(args.name)}`);
      return entry ? String(entry.value.text) : `nothing remembered under ${args.name}`;
    },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      };
    case 'ping':
    case 'shutdown': // sent before Octipus stops the server
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return text(`Unknown tool: ${msg.params?.name}`, true);
      try {
        // The host API token of this one call: it names the user who asked, and dies with the call.
        return text(String(await tool.run(msg.params?.arguments ?? {}, msg.params?._meta?.['octipus/host'])));
      } catch (err) {
        // A tool error is a result with isError, so the agent sees why.
        return text(err instanceof Error ? err.message : String(err), true);
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // Notifications (no id), such as notifications/initialized, get no answer.
  if (msg.id === undefined || msg.id === null) return;
  try {
    send({ id: msg.id, result: await handle(msg) });
  } catch (err) {
    send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
