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
      slug: z.string().optional().describe('Explicit slug (defaults to a slug of the title)'),
      noteKind: z.string().optional().describe('note (default) | moc | literature | …'),
      tags: z.array(z.string()).optional().describe('Explicit tags'),
    },
    async ({ title, body, id, slug, noteKind, tags }) => {
      try {
        return asText(await client.executeTool('notes', 'write_note', { title, body, id, slug, note_kind: noteKind, tags }));
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
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async ({ kind, tag, limit }) => {
      try {
        return asText(await client.executeTool('notes', 'list_notes', { kind, tag, limit }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_search_notes',
    'Hybrid search over note content.',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default 5)'),
    },
    async ({ query, limit }) => {
      try {
        return asText(await client.executeTool('notes', 'search_notes', { query, limit }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.tool(
    'octipus_capture_note',
    "Append a timestamped line to a daily note (quick capture).",
    {
      text: z.string().describe('Text to capture'),
      date: z.string().optional().describe('Target day (YYYY-MM-DD); defaults to today'),
    },
    async ({ text, date }) => {
      try {
        return asText(await client.executeTool('notes', 'capture_note', { text, date }));
      } catch (error) {
        return asError(error);
      }
    },
  );
}
