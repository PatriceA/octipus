import { createParameterSchema } from '../base-skill';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export function registerMailTools(registerTool: RegisterFn, graphApi: ApiFn): void {
  // --- mail_list ---
  registerTool(
    'mail_list',
    'List recent emails from Outlook inbox',
    createParameterSchema({
      limit: { type: 'number', description: 'Maximum number of emails to return (default 20)', default: 20 },
    }),
    async (args: { limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`
      );
    },
    { permissionAction: 'email_read' }
  );

  // --- mail_search ---
  registerTool(
    'mail_search',
    'Search emails by keyword in Outlook',
    createParameterSchema({
      query: { type: 'string', description: 'Search query string', required: true },
      limit: { type: 'number', description: 'Maximum number of results (default 20)', default: 20 },
    }),
    async (args: { query: string; limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/messages?$search="${encodeURIComponent(args.query)}"&$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`
      );
    },
    { permissionAction: 'email_read' }
  );

  // --- mail_read ---
  registerTool(
    'mail_read',
    'Read a specific email by ID',
    createParameterSchema({
      id: { type: 'string', description: 'The email message ID', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'GET',
        `/me/messages/${args.id}?$select=id,subject,from,toRecipients,body,receivedDateTime`
      );
    },
    { permissionAction: 'email_read' }
  );

  // --- mail_send ---
  registerTool(
    'mail_send',
    'Send a new email via Outlook',
    createParameterSchema({
      to: { type: 'string', description: 'Recipient email address', required: true },
      subject: { type: 'string', description: 'Email subject', required: true },
      content: { type: 'string', description: 'Email body text', required: true },
    }),
    async (args: { to: string; subject: string; content: string }, ctx: AgentContext) => {
      return graphApi(ctx.userId, 'POST', '/me/sendMail', {
        message: {
          subject: args.subject,
          body: { contentType: 'Text', content: args.content },
          toRecipients: [{ emailAddress: { address: args.to } }],
        },
      });
    },
    { permissionAction: 'email_send' }
  );

  // --- mail_reply ---
  registerTool(
    'mail_reply',
    'Reply to an existing email',
    createParameterSchema({
      id: { type: 'string', description: 'The email message ID to reply to', required: true },
      comment: { type: 'string', description: 'Reply text', required: true },
    }),
    async (args: { id: string; comment: string }, ctx: AgentContext) => {
      return graphApi(ctx.userId, 'POST', `/me/messages/${args.id}/reply`, {
        comment: args.comment,
      });
    },
    { permissionAction: 'email_send' }
  );

  // --- mail_folders ---
  registerTool(
    'mail_folders',
    'List mail folders with message counts',
    createParameterSchema({}),
    async (_args: Record<string, unknown>, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'GET',
        '/me/mailFolders?$select=id,displayName,totalItemCount,unreadItemCount'
      );
    },
    { permissionAction: 'email_read' }
  );

  // --- mail_delete ---
  registerTool(
    'mail_delete',
    'Delete an email message by ID',
    createParameterSchema({
      id: { type: 'string', description: 'The email message ID to delete', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      return graphApi(ctx.userId, 'DELETE', `/me/messages/${args.id}`);
    },
    { permissionAction: 'delete' }
  );
}
