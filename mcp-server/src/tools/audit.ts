/**
 * Audit log tools — view audit trail entries.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerAuditTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_audit_log',
    'List recent audit log entries.',
    {
      limit: z.number().optional().describe('Maximum number of entries to return (default 50)'),
    },
    async ({ limit }) => {
      try {
        const logs = await client.listAuditLog(limit ?? 50);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(logs, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list audit log: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
