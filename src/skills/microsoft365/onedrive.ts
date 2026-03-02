import { createParameterSchema } from '../base-skill';
import type { AgentContext } from '@/core/types';
import { getOAuthManager } from '@/security/oauth';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export function registerOneDriveTools(registerTool: RegisterFn, graphApi: ApiFn): void {
  // --- drive_list ---
  registerTool(
    'drive_list',
    'List files and folders in OneDrive root (or a folder)',
    createParameterSchema({
      limit: { type: 'number', description: 'Maximum number of items to return (default 20)', default: 20 },
    }),
    async (args: { limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/drive/root/children?$select=id,name,size,lastModifiedDateTime,webUrl,file,folder&$top=${limit}`
      );
    },
    { permissionAction: 'drive_read' }
  );

  // --- drive_search ---
  registerTool(
    'drive_search',
    'Search for files in OneDrive by name or content',
    createParameterSchema({
      query: { type: 'string', description: 'Search query', required: true },
      limit: { type: 'number', description: 'Maximum number of results (default 20)', default: 20 },
    }),
    async (args: { query: string; limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/drive/root/search(q='${encodeURIComponent(args.query)}')?$select=id,name,size,lastModifiedDateTime,webUrl&$top=${limit}`
      );
    },
    { permissionAction: 'drive_read' }
  );

  // --- drive_download ---
  registerTool(
    'drive_download',
    'Download a file from OneDrive by item ID (returns text content)',
    createParameterSchema({
      id: { type: 'string', description: 'The OneDrive item ID', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      const token = await getOAuthManager().getValidToken(ctx.userId, 'microsoft');
      if (!token) throw new Error('Microsoft 365 not connected. Connect your Microsoft account in Settings > Integrations.');

      const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${args.id}/content`, {
        headers: { 'Authorization': `Bearer ${token}` },
        redirect: 'follow',
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Microsoft Graph error (${response.status}): ${JSON.stringify(error)}`);
      }

      return {
        content: await response.text(),
        contentType: response.headers.get('content-type'),
      };
    },
    { permissionAction: 'drive_read' }
  );

  // --- drive_upload ---
  registerTool(
    'drive_upload',
    'Upload a small file to OneDrive by path',
    createParameterSchema({
      path: { type: 'string', description: 'Destination path in OneDrive (e.g. Documents/notes.txt)', required: true },
      content: { type: 'string', description: 'File content to upload', required: true },
    }),
    async (args: { path: string; content: string }, ctx: AgentContext) => {
      const token = await getOAuthManager().getValidToken(ctx.userId, 'microsoft');
      if (!token) throw new Error('Microsoft 365 not connected. Connect your Microsoft account in Settings > Integrations.');

      const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${args.path}:/content`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: args.content,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Microsoft Graph error (${response.status}): ${JSON.stringify(error)}`);
      }

      return response.json();
    },
    { permissionAction: 'drive_write' }
  );

  // --- drive_delete ---
  registerTool(
    'drive_delete',
    'Delete a file or folder from OneDrive by item ID',
    createParameterSchema({
      id: { type: 'string', description: 'The OneDrive item ID to delete', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      return graphApi(ctx.userId, 'DELETE', `/me/drive/items/${args.id}`);
    },
    { permissionAction: 'delete' }
  );
}
