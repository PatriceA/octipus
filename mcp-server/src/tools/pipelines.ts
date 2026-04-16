/**
 * Pipeline management tools — list templates, create, monitor, and stop pipelines.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantClient } from '../client.js';

export function registerPipelineTools(server: McpServer, client: AssistantClient): void {
  server.tool(
    'assistant_list_pipeline_templates',
    'List all available pipeline templates.',
    {},
    async () => {
      try {
        const templates = await client.listPipelineTemplates();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(templates, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list pipeline templates: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_create_pipeline',
    'Create a new pipeline from a template.',
    {
      templateName: z.string().describe('Name of the pipeline template to use'),
      description: z.string().describe('Description of the pipeline purpose'),
    },
    async ({ templateName, description }) => {
      try {
        const result = await client.createPipeline(templateName, description);
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
          content: [{ type: 'text' as const, text: `Failed to create pipeline: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_list_pipelines',
    'List all pipelines with their current status.',
    {},
    async () => {
      try {
        const pipelines = await client.listPipelines();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(pipelines, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list pipelines: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_get_pipeline',
    'Get details of a specific pipeline by ID.',
    {
      pipeline_id: z.string().describe('The pipeline ID'),
    },
    async ({ pipeline_id }) => {
      try {
        const pipeline = await client.getPipeline(pipeline_id);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(pipeline, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get pipeline: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'assistant_stop_pipeline',
    'Stop a running pipeline by ID.',
    {
      pipeline_id: z.string().describe('The pipeline ID to stop'),
    },
    async ({ pipeline_id }) => {
      try {
        await client.stopPipeline(pipeline_id);
        return {
          content: [{ type: 'text' as const, text: `Pipeline ${pipeline_id} stopped.` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to stop pipeline: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
