/**
 * Live Artifact tools — workspace-scoped CRUD, versions, refresh, share links.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OctiClient } from '../client.js';

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function err(label: string, e: unknown) {
  return {
    content: [{ type: 'text' as const, text: `${label}: ${(e as Error).message}` }],
    isError: true,
  };
}

export function registerArtifactTools(server: McpServer, client: OctiClient): void {
  server.tool(
    'octipus_list_artifacts',
    'List all live artifacts in the current workspace.',
    {},
    async () => {
      try { return ok(await client.listArtifacts()); }
      catch (e) { return err('Failed to list artifacts', e); }
    },
  );

  server.tool(
    'octipus_get_artifact',
    'Get a single artifact (with current version) by ID.',
    { id: z.string().describe('Artifact ID') },
    async ({ id }) => {
      try { return ok(await client.getArtifact(id)); }
      catch (e) { return err('Failed to get artifact', e); }
    },
  );

  server.tool(
    'octipus_get_artifact_spec',
    'Fetch the full pipeline spec of one artifact in the current workspace by slug or id. ' +
      'Returns `{ artifact, version, sources, transforms, widgets, exports }` — feed those four ' +
      'arrays into `art_toolbox_validate` verbatim. Use this BEFORE validating an existing artifact.',
    { slugOrId: z.string().describe('Artifact slug (preferred) or UUID') },
    async ({ slugOrId }) => {
      try { return ok(await client.getArtifactSpec(slugOrId)); }
      catch (e) { return err('Failed to get artifact spec', e); }
    },
  );

  server.tool(
    'octipus_create_artifact',
    'Create a new live artifact. Optionally provide htmlTemplate + css for the initial version.',
    {
      slug: z.string().describe('URL slug (lowercase, digits, dashes, 1-64 chars)'),
      title: z.string().describe('Display title'),
      type: z.enum(['dashboard', 'table', 'rss', 'news', 'html']).describe('Artifact type'),
      visibility: z.enum(['workspace', 'public', 'private']).optional(),
      htmlTemplate: z.string().optional().describe('Initial HTML template'),
      css: z.string().optional().describe('Initial CSS'),
      createdByAgentId: z.string().optional(),
    },
    async (params) => {
      try { return ok(await client.createArtifact(params)); }
      catch (e) { return err('Failed to create artifact', e); }
    },
  );

  server.tool(
    'octipus_update_artifact',
    'Update an artifact. Providing htmlTemplate/css creates a new version.',
    {
      id: z.string().describe('Artifact ID'),
      title: z.string().optional(),
      visibility: z.enum(['workspace', 'public', 'private']).optional(),
      htmlTemplate: z.string().optional(),
      css: z.string().optional(),
      changeSummary: z.string().optional().describe('Note describing what changed'),
    },
    async ({ id, ...params }) => {
      try { return ok(await client.updateArtifact(id, params)); }
      catch (e) { return err('Failed to update artifact', e); }
    },
  );

  server.tool(
    'octipus_delete_artifact',
    'Delete an artifact by ID.',
    { id: z.string().describe('Artifact ID') },
    async ({ id }) => {
      try { return ok(await client.deleteArtifact(id)); }
      catch (e) { return err('Failed to delete artifact', e); }
    },
  );

  server.tool(
    'octipus_list_artifact_versions',
    'List all versions of an artifact.',
    { id: z.string().describe('Artifact ID') },
    async ({ id }) => {
      try { return ok(await client.listArtifactVersions(id)); }
      catch (e) { return err('Failed to list versions', e); }
    },
  );

  server.tool(
    'octipus_refresh_artifact',
    'Trigger a refresh of all data sources on an artifact.',
    { id: z.string().describe('Artifact ID') },
    async ({ id }) => {
      try { return ok(await client.refreshArtifact(id)); }
      catch (e) { return err('Failed to refresh artifact', e); }
    },
  );

  server.tool(
    'octipus_list_artifact_share_links',
    'List active share links for an artifact.',
    { id: z.string().describe('Artifact ID') },
    async ({ id }) => {
      try { return ok(await client.listArtifactShareLinks(id)); }
      catch (e) { return err('Failed to list share links', e); }
    },
  );

  server.tool(
    'octipus_mint_artifact_share_link',
    'Mint a new time-limited share link for an artifact. ttlSeconds defaults to 3600.',
    {
      id: z.string().describe('Artifact ID'),
      ttlSeconds: z.number().int().positive().optional().describe('Link lifetime in seconds (default 3600)'),
      scope: z.record(z.unknown()).optional().describe('Optional scope claims attached to the link'),
    },
    async ({ id, ttlSeconds, scope }) => {
      try { return ok(await client.mintArtifactShareLink(id, { ttlSeconds, scope })); }
      catch (e) { return err('Failed to mint share link', e); }
    },
  );
}
