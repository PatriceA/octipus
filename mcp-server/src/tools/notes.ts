/**
 * Notes tools — the user's markdown notes (Notes tab). Backed by the
 * built-in `notes` tool (wikilinks + tags + hybrid search).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

function asText(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
function asError(error: unknown) {
  return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
}

export function registerNotesTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_write_note',
    'Create or update a markdown note. Use [[Wikilinks]] and #tags — both wire into the knowledge graph. Pass id to edit; omit it to create.',
    {
      title: z.string().describe('Note title'),
      body: z.string().optional().describe('Markdown body (may contain [[wikilinks]] and #tags)'),
      id: z.string().optional().describe('Existing note id to update (omit to create)'),
      tags: z.array(z.string()).optional().describe('Explicit tags'),
    },
    async ({ title, body, id, tags }) => {
      try {
        return asText(await client.executeTool('notes', 'write_note', { title, body, id, tags }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_read_note',
    'Read a note (with backlinks) by id or slug.',
    {
      id: z.string().optional().describe('Note id'),
      slug: z.string().optional().describe('Note slug'),
    },
    async ({ id, slug }) => {
      try {
        return asText(await client.executeTool('notes', 'read_note', { id, slug }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_list_notes',
    'List notes, optionally filtered by kind or tag.',
    {
      kind: z.string().optional().describe('Note kind filter'),
      tag: z.string().optional().describe('Tag filter'),
    },
    async ({ kind, tag }) => {
      try {
        return asText(await client.executeTool('notes', 'list_notes', { kind, tag }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_search_notes',
    'Hybrid search over note content.',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      try {
        return asText(await client.executeTool('notes', 'search_notes', { query }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_capture_note',
    "Append a timestamped line to today's daily note (quick capture).",
    { text: z.string().describe('Text to capture') },
    async ({ text }) => {
      try {
        return asText(await client.executeTool('notes', 'capture_note', { text }));
      } catch (error) {
        return asError(error);
      }
    },
  );
}
