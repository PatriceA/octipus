// A plugin package's MCP server: newline-delimited JSON-RPC 2.0 over stdio,
// no dependencies. Octipus starts it in the package directory (read-only under
// the sandbox) and calls initialize, tools/list and tools/call.
// Keep state in OCTIPUS_PLUGIN_DATA_DIR, the only writable directory.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const NAME = 'my-tools';
const VERSION = '0.1.0';

// Every tool here must be declared in octipus-plugin.json with its effect;
// one that is not is hidden from agents and refused.
const TOOLS = [
  {
    name: 'greet',
    description: 'Greet someone by name',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Who to greet' } }, required: ['name'] },
    run: (args) => `${process.env.OCTIPUS_SETTING_GREETING || 'Hello'}, ${String(args.name ?? 'there')}!`,
  },
  {
    name: 'save_note',
    description: 'Keep a short note in the plugin\'s data directory',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note' } }, required: ['text'] },
    run: (args) => {
      const dir = process.env.OCTIPUS_PLUGIN_DATA_DIR;
      if (!dir) throw new Error('OCTIPUS_PLUGIN_DATA_DIR is not set');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'notes.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), text: String(args.text ?? '') })}\n`);
      return 'saved';
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
