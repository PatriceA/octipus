import { createParameterSchema } from '../base-tool';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, url: string, body?: unknown) => Promise<unknown>;

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4';
const DOCS_BASE = 'https://docs.googleapis.com/v1';

const DRIVE_FILE_FIELDS = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';

export function registerDriveTools(registerTool: RegisterFn, googleApi: ApiFn): void {
  // ==================== Drive ====================

  // --- drive_list ---
  registerTool('drive_list', 'List files in Google Drive', createParameterSchema({
    limit: { type: 'number', description: 'Maximum number of files (default 20)', default: 20 },
    orderBy: { type: 'string', description: 'Sort order (e.g. "modifiedTime desc", "name")', default: 'modifiedTime desc' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const pageSize = (args.limit as number) || 20;
    const orderBy = encodeURIComponent((args.orderBy as string) || 'modifiedTime desc');
    return googleApi(
      context.userId,
      'GET',
      `${DRIVE_BASE}/files?pageSize=${pageSize}&orderBy=${orderBy}&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`
    );
  }, { permissionAction: 'drive_read' });

  // --- drive_search ---
  registerTool('drive_search', 'Search for files in Google Drive using a query', createParameterSchema({
    query: { type: 'string', description: 'Drive search query (e.g. "name contains \'report\'" or "mimeType=\'application/pdf\'")', required: true },
    limit: { type: 'number', description: 'Maximum number of results (default 20)', default: 20 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const q = encodeURIComponent(args.query as string);
    const pageSize = (args.limit as number) || 20;
    return googleApi(
      context.userId,
      'GET',
      `${DRIVE_BASE}/files?q=${q}&pageSize=${pageSize}&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`
    );
  }, { permissionAction: 'drive_read' });

  // --- drive_download ---
  registerTool('drive_download', 'Download text content of a file from Google Drive', createParameterSchema({
    id: { type: 'string', description: 'File ID to download', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const result = await googleApi(
      context.userId,
      'GET',
      `${DRIVE_BASE}/files/${args.id}?alt=media`
    );
    return { content: result };
  }, { permissionAction: 'drive_read' });

  // --- drive_upload ---
  registerTool('drive_upload', 'Upload a text file to Google Drive', createParameterSchema({
    name: { type: 'string', description: 'File name', required: true },
    content: { type: 'string', description: 'Text content to upload', required: true },
    mimeType: { type: 'string', description: 'MIME type of the file (default "text/plain")', default: 'text/plain' },
    folderId: { type: 'string', description: 'Parent folder ID to upload into' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const { getOAuthManager } = await import('@/security/oauth');
    const token = await getOAuthManager().getValidToken(context.userId, 'google');
    if (!token) throw new Error('Google Workspace not connected. Connect your Google account in Settings > Integrations.');

    const mimeType = (args.mimeType as string) || 'text/plain';
    const metadata: Record<string, unknown> = { name: args.name, mimeType };
    if (args.folderId) metadata.parents = [args.folderId];

    const boundary = '-------googleworkspace_boundary';
    const multipartBody = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      args.content as string,
      `--${boundary}--`,
    ].join('\r\n');

    const response = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Google API error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }, { permissionAction: 'drive_write' });

  // --- drive_delete ---
  registerTool('drive_delete', 'Delete a file from Google Drive', createParameterSchema({
    id: { type: 'string', description: 'File ID to delete', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(context.userId, 'DELETE', `${DRIVE_BASE}/files/${args.id}`);
  }, { permissionAction: 'delete' });

  // ==================== Sheets ====================

  // --- sheets_read ---
  registerTool('sheets_read', 'Read values from a Google Sheets range', createParameterSchema({
    id: { type: 'string', description: 'Spreadsheet ID', required: true },
    range: { type: 'string', description: 'A1 notation range (e.g. "Sheet1!A1:D10")', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const range = encodeURIComponent(args.range as string);
    return googleApi(
      context.userId,
      'GET',
      `${SHEETS_BASE}/spreadsheets/${args.id}/values/${range}`
    );
  }, { permissionAction: 'docs_read' });

  // --- sheets_write ---
  registerTool('sheets_write', 'Write values to a Google Sheets range', createParameterSchema({
    id: { type: 'string', description: 'Spreadsheet ID', required: true },
    range: { type: 'string', description: 'A1 notation range (e.g. "Sheet1!A1:D10")', required: true },
    values: { type: 'string', description: 'JSON stringified 2D array of values (e.g. \'[["A","B"],["C","D"]]\')', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const range = encodeURIComponent(args.range as string);
    let values: unknown[][];
    try {
      values = JSON.parse(args.values as string);
    } catch {
      throw new Error('Invalid values format. Must be a JSON-stringified 2D array, e.g. \'[["A","B"],["C","D"]]\'');
    }
    return googleApi(
      context.userId,
      'PUT',
      `${SHEETS_BASE}/spreadsheets/${args.id}/values/${range}?valueInputOption=USER_ENTERED`,
      { values }
    );
  }, { permissionAction: 'docs_write' });

  // --- sheets_create ---
  registerTool('sheets_create', 'Create a new Google Spreadsheet', createParameterSchema({
    title: { type: 'string', description: 'Spreadsheet title', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(
      context.userId,
      'POST',
      `${SHEETS_BASE}/spreadsheets`,
      { properties: { title: args.title } }
    );
  }, { permissionAction: 'docs_write' });

  // --- sheets_info ---
  registerTool('sheets_info', 'Get spreadsheet metadata (title, sheet names, etc.)', createParameterSchema({
    id: { type: 'string', description: 'Spreadsheet ID', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(
      context.userId,
      'GET',
      `${SHEETS_BASE}/spreadsheets/${args.id}?fields=${encodeURIComponent('properties,sheets.properties')}`
    );
  }, { permissionAction: 'docs_read' });

  // ==================== Docs ====================

  // --- docs_read ---
  registerTool('docs_read', 'Read a Google Doc by ID (returns full document structure)', createParameterSchema({
    id: { type: 'string', description: 'Document ID', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(context.userId, 'GET', `${DOCS_BASE}/documents/${args.id}`);
  }, { permissionAction: 'docs_read' });

  // --- docs_create ---
  registerTool('docs_create', 'Create a new Google Doc', createParameterSchema({
    title: { type: 'string', description: 'Document title', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(
      context.userId,
      'POST',
      `${DOCS_BASE}/documents`,
      { title: args.title }
    );
  }, { permissionAction: 'docs_write' });

  // --- docs_update ---
  registerTool('docs_update', 'Insert text into a Google Doc at a given index', createParameterSchema({
    id: { type: 'string', description: 'Document ID', required: true },
    text: { type: 'string', description: 'Text to insert', required: true },
    index: { type: 'number', description: 'Character index to insert at (1 = beginning of document)', default: 1 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const index = (args.index as number) || 1;
    return googleApi(
      context.userId,
      'POST',
      `${DOCS_BASE}/documents/${args.id}:batchUpdate`,
      {
        requests: [
          {
            insertText: {
              text: args.text,
              location: { index },
            },
          },
        ],
      }
    );
  }, { permissionAction: 'docs_write' });
}
