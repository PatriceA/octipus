// A plugin package's MCP server behind a slash command: newline-delimited
// JSON-RPC 2.0 over stdio, no dependencies. `/wordcount some text` calls
// count_words with { "text": "some text" } (the manifest's input, "$args"
// replaced) as the user who typed it; the tool's text is the answer.
import { createInterface } from 'node:readline';

const NAME = 'my-command';
const VERSION = '0.1.0';

const TOOLS = [
  {
    name: 'count_words',
    description: 'Count the words and characters of a text',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The text' } }, required: ['text'] },
    run: (args) => {
      const value = String(args.text ?? '');
      const words = value.trim() ? value.trim().split(/\s+/).length : 0;
      return `${words} word${words === 1 ? '' : 's'}, ${value.length} character${value.length === 1 ? '' : 's'}`;
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
        return text(String(await tool.run(msg.params?.arguments ?? {})));
      } catch (err) {
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
  if (msg.id === undefined || msg.id === null) return;
  try {
    send({ id: msg.id, result: await handle(msg) });
  } catch (err) {
    send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
