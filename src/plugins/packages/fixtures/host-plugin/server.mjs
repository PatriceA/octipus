// A plugin package server without dependencies, for the tests of the host API:
// each tool calls back into the host with the token its call carries in
// `_meta["octipus/host"]`, through the egress proxy in HTTP_PROXY.
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const names = ['whoami', 'list_notes', 'read_doc', 'write_from_read', 'probe', 'leak_token', 'make_note', 'make_task', 'notify_me', 'send_letter'];
const tools = names.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

/** One request to `url` through the proxy (absolute-form, as an HTTP proxy expects). */
function viaProxy(method, url, headers = {}, body) {
  const proxy = new URL(process.env.HTTP_PROXY);
  const target = new URL(url);
  return new Promise((resolve) => {
    const req = request({
      host: proxy.hostname, port: Number(proxy.port), method, path: target.href,
      headers: { host: target.host, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json ?? data });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: String(err.message) }));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function call(name, args, host) {
  if (name === 'send_letter') return `called ${name}`;
  if (!host) return { noHost: true, env: process.env.OCTIPUS_HOST_URL ?? null };
  const auth = { authorization: `Bearer ${host.token}` };
  const api = (method, path, body) => viaProxy(method, `${host.url}/api/plugin-host${path}`, auth, body);
  switch (name) {
    case 'whoami': return { meta: { scopes: host.scopes, url: host.url }, env: process.env.OCTIPUS_HOST_URL ?? null, res: await api('GET', '/whoami') };
    case 'list_notes': return api('GET', '/notes');
    case 'read_doc': return api('GET', `/documents/${args.id}`);
    case 'write_from_read': return api('POST', '/notes', { title: 'from a read tool' });
    case 'make_note': return api('POST', '/notes', { title: args.title ?? 'Plugin note', body: args.body ?? 'written by the host plugin' });
    case 'make_task': return api('POST', '/tasks', { title: args.title ?? 'Plugin task' });
    case 'notify_me': return api('POST', '/notify', { title: 'From the host plugin' });
    case 'leak_token': return { token: host.token, url: host.url };
    case 'probe': return viaProxy(args.method ?? 'GET', args.url, { ...(args.noAuth ? {} : auth), ...(args.headers ?? {}) });
    default: return `called ${name}`;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'host-plugin', version: '1.0.0' } });
    case 'tools/list':
      return reply(msg.id, { tools });
    case 'tools/call': {
      const { name, arguments: args, _meta: meta } = msg.params;
      call(name, args ?? {}, meta?.['octipus/host']).then((out) => reply(msg.id, text(out)), (err) => reply(msg.id, { isError: true, ...text(String(err)) }));
      return;
    }
    default:
      return reply(msg.id, {});
  }
});
