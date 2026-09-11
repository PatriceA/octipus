#!/usr/bin/env node
// Shell fallback for CLIs without a per-run MCP configuration interface.
import { agentBridgeRequest } from './agent-bridge.js';
try {
  const [operation, name, args] = process.argv.slice(2);
  if (operation !== 'tools' && operation !== 'call') throw new Error('Usage: tools | call <tool-name> <JSON arguments>');
  const result = await agentBridgeRequest(operation === 'tools' ? '/tools' : '/call',
    operation === 'call' ? { name, arguments: JSON.parse(args || '{}') } : undefined);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result && typeof result === 'object' && 'isError' in result && result.isError) process.exitCode = 1;
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
