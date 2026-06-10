/**
 * Deep Research tools — start a multi-source research job and poll for the
 * cited report. Jobs are async; start returns a jobId to poll with get_report.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

export function registerResearchTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_start_research',
    'Start a Deep Research job. Returns a jobId — poll octipus_get_research_report until status is "done".',
    {
      question: z.string().describe('The research question'),
      depth: z.enum(['quick', 'standard', 'deep']).optional().describe('Depth (default: standard)'),
    },
    async ({ question, depth }) => {
      try {
        const res = await client.startResearch(question, depth);
        return { content: [{ type: 'text' as const, text: `Started research job ${res.jobId} (status: ${res.status}). Poll octipus_get_research_report with this jobId.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'octipus_get_research_report',
    'Poll a Deep Research job: returns progress while running, or the full cited report when done.',
    { jobId: z.string().describe('Job id from octipus_start_research') },
    async ({ jobId }) => {
      try {
        const job = await client.getResearch(jobId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
