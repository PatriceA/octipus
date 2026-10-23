// A minimal MCP server over stdio, without dependencies, for the plugin package tests.
import { createInterface } from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'env_report', description: 'Environment names', inputSchema: { type: 'object', properties: {} } },
  { name: 'send_letter', description: 'Pretend to send a letter', inputSchema: { type: 'object', properties: {} } },
  { name: 'undeclared_tool', description: 'Not in the manifest', inputSchema: { type: 'object', properties: {} } },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo-plugin', version: '1.0.0' } });
    case 'tools/list':
      return reply(msg.id, { tools });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') return reply(msg.id, text(String(args?.text ?? '')));
      if (name === 'env_report') {
        return reply(msg.id, text({
          names: Object.keys(process.env).sort(),
          region: process.env.OCTIPUS_SETTING_REGION ?? null,
          token: process.env.ECHO_TOKEN ?? null,
          cwd: process.cwd(),
        }));
      }
      return reply(msg.id, text(`called ${name}`));
    }
    default:
      return reply(msg.id, {});
  }
});
