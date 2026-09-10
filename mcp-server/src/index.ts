#!/usr/bin/env node

/**
 * Octipus MCP Server — Entry point
 *
 * Exposes Octipus's capabilities (search, agents, sessions, models, chat, tools)
 * as MCP tools that CLI models (Claude Code, Gemini CLI) can use.
 *
 * Usage:
 *   node dist/index.js                          # stdio transport (default)
 *   node dist/index.js --transport http --port 3010  # HTTP transport
 *
 * Environment:
 *   OCTIPUS_URL      - Octipus backend URL (default: http://localhost:3005)
 *   OCTIPUS_API_KEY   - API key or JWT for authentication
 *   OCTIPUS_USER      - Username for auto-login (alternative to API key)
 *   OCTIPUS_PASSWORD  - Password for auto-login
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { createHttpBridge } from './http.js';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const transport = getArg('transport') || 'stdio';
const port = Number(getArg('port') || '3010');
const host = getArg('host') || process.env.MCP_HOST || '127.0.0.1';
const octiUrl = process.env.OCTIPUS_URL || 'http://localhost:3005';

async function main(): Promise<void> {
  if (transport === 'stdio') {
    const server = createServer(octiUrl);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    // Server runs until stdin closes
  } else if (transport === 'http') {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port');
    const bridge = createHttpBridge({
      backendUrl: octiUrl,
      apiKey: process.env.MCP_API_KEY || '',
      allowedOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3007').split(','),
    });
    await new Promise<void>((resolve, reject) => {
      bridge.httpServer.once('error', reject);
      bridge.httpServer.listen(port, host, () => {
        bridge.httpServer.removeListener('error', reject);
        resolve();
      });
    });
    bridge.httpServer.on('error', error => console.error('MCP HTTP listener error:', error.message));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void bridge.close().catch(() => {
        console.error('MCP HTTP shutdown failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.error(`Octipus MCP server (HTTP/SSE) listening on ${host}:${port}`);

  } else {
    console.error(`Unknown transport: ${transport}. Use "stdio" or "http".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
