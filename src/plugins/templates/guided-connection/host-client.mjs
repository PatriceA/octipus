// Vendored, dependency-free host client. Credentials remain in Octipus.
import { request } from 'node:http';
import { createInterface } from 'node:readline';

export function hostCall(meta, scope, method, path, body, { allow404 = false } = {}) {
  if (!meta?.scopes?.includes(scope)) throw new Error(`This call does not have ${scope}. Check the plugin's approved access.`);
  const target = new URL(meta.url);
  if (target.origin !== 'http://octipus-host.internal' || !path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid host API destination.');
  const proxy = new URL(process.env.HTTP_PROXY || process.env.http_proxy || '');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port || 80, method, path: target.origin + '/api/plugin-host' + path,
      headers: { host: target.host, authorization: `Bearer ${meta.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { res.destroy(new Error('Host response exceeded 8 MB.')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('Host returned an invalid JSON response.')); return; }
        if (allow404 && res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(value.error || `Host request failed (${res.statusCode}).`)); return; }
        resolve(value);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Host request timed out.')));
    req.on('error', reject); req.end(payload);
  });
}

/** Serve declared handlers; application input validation stays in each handler. */
export function servePlugin(manifest, handlers) {
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  createInterface({ input: process.stdin }).on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { process.stderr.write('Ignoring malformed JSON-RPC input.\n'); return; }
    if (message.id === undefined || message.id === null) return;
    const tools = Object.entries(manifest.tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: handlers[name]?.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } }));
    if (message.method === 'initialize') { send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: manifest.name, version: manifest.version } }); return; }
    if (message.method === 'ping') { send(message.id, {}); return; }
    if (message.method === 'tools/list') { send(message.id, { tools }); return; }
    if (message.method !== 'tools/call') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
    try {
      const name = message.params?.name;
      if (!Object.hasOwn(manifest.tools, name) || !Object.hasOwn(handlers, name)) throw new Error('Unknown tool.');
      const result = await handlers[name].run(message.params?.arguments ?? {}, message.params?._meta?.['octipus/host']);
      send(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) { send(message.id, { isError: true, content: [{ type: 'text', text: error.message }] }); }
  });
}
