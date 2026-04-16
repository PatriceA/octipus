/**
 * Document management tools — list, upload, get, and delete documents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerDocumentTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_documents',
    'List all indexed documents.',
    {},
    async () => {
      try {
        const documents = await client.listDocuments();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(documents, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list documents: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_upload_document',
    'Upload and index a document by file path.',
    {
      path: z.string().describe('File path to the document to index'),
    },
    async ({ path }) => {
      try {
        const result = await client.uploadDocument(path);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to upload document: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_get_document',
    'Get details of a specific document by ID.',
    {
      document_id: z.string().describe('The document ID'),
    },
    async ({ document_id }) => {
      try {
        const document = await client.getDocument(document_id);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(document, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get document: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_delete_document',
    'Delete a document by ID.',
    {
      document_id: z.string().describe('The document ID to delete'),
    },
    async ({ document_id }) => {
      try {
        await client.deleteDocument(document_id);
        return {
          content: [{ type: 'text' as const, text: `Document ${document_id} deleted.` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to delete document: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
