#!/usr/bin/env node

/**
 * Assistant MCP Server — Entry point
 *
 * Exposes the assistant's capabilities (search, agents, sessions, models, chat, skills)
 * as MCP tools that CLI models (Claude Code, Gemini CLI) can use.
 *
 * Usage:
 *   node dist/index.js                          # stdio transport (default)
 *   node dist/index.js --transport http --port 3010  # HTTP transport
 *
 * Environment:
 *   ASSISTANT_URL      - Assistant backend URL (default: http://localhost:3005)
 *   ASSISTANT_API_KEY   - API key or JWT for authentication
 *   ASSISTANT_USER      - Username for auto-login (alternative to API key)
 *   ASSISTANT_PASSWORD  - Password for auto-login
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const transport = getArg('transport') || 'stdio';
const port = parseInt(getArg('port') || '3010', 10);
const assistantUrl = process.env.ASSISTANT_URL || 'http://localhost:3005';

async function main(): Promise<void> {
  const server = createServer(assistantUrl);

  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    // Server runs until stdin closes
  } else if (transport === 'http') {
    // HTTP/SSE transport for remote access
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');

    const { createServer: createHttpServer } = await import('http');
    const httpServer = createHttpServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (url.pathname === '/sse') {
        const sseTransport = new SSEServerTransport('/messages', res);
        await server.connect(sseTransport);
      } else if (url.pathname === '/messages') {
        // Collect body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString();

        // The SSE transport handles message routing internally
        // This endpoint receives JSON-RPC messages from the client
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'http', assistantUrl }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(port, () => {
      console.error(`Assistant MCP server (HTTP) listening on port ${port}`);
      console.error(`  SSE endpoint: http://localhost:${port}/sse`);
      console.error(`  Assistant URL: ${assistantUrl}`);
    });
  } else {
    console.error(`Unknown transport: ${transport}. Use "stdio" or "http".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
