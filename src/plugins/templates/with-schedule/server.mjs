// A plugin package's MCP server with a schedule: newline-delimited JSON-RPC 2.0
// over stdio, no dependencies. The cron runner calls `check` with the
// schedule's input; it runs as the admin who installed the package, unattended,
// so a read tool runs, a write tool needs that admin's ALLOW rule and an
// external one never runs. Keep state in OCTIPUS_PLUGIN_DATA_DIR.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const NAME = 'my-schedule';
const VERSION = '0.1.0';

function logFile() {
  const dir = process.env.OCTIPUS_PLUGIN_DATA_DIR;
  if (!dir) throw new Error('OCTIPUS_PLUGIN_DATA_DIR is not set');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'checks.jsonl');
}

const TOOLS = [
  {
    name: 'check',
    description: 'Run the periodic check and record when it ran',
    inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Who asked: schedule or agent' } } },
    run: (args) => {
      // Replace with the real check (an API call through the declared hosts, say).
      const entry = { at: new Date().toISOString(), source: String(args.source ?? 'agent'), ok: true };
      appendFileSync(logFile(), `${JSON.stringify(entry)}\n`);
      return `checked at ${entry.at}`;
    },
  },
  {
    name: 'last_checks',
    description: 'The most recent checks',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many (default 5)' } } },
    run: (args) => {
      const file = logFile();
      if (!existsSync(file)) return 'no checks yet';
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(50, Number(args.limit) || 5))).join('\n');
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
