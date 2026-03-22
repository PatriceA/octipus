import { createParameterSchema } from '../base-tool';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export function registerMailTools(registerTool: RegisterFn, graphApi: ApiFn): void {
  // --- mail_list ---
  registerTool(
    'mail_list',
    'List recent emails from Outlook inbox. Supports pagination via skip parameter.',
    createParameterSchema({
      limit: { type: 'number', description: 'Maximum number of emails to return (default 20)', default: 20 },
      skip: { type: 'number', description: 'Number of emails to skip for pagination (use nextSkip from previous response)' },
    }),
    async (args: { limit?: number; skip?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      const skip = args.skip ?? 0;
      let url = `/me/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime desc`;
      if (skip > 0) url += `&$skip=${skip}`;
      const result = await graphApi(ctx.userId, 'GET', url) as { value?: unknown[]; [key: string]: unknown };
      const emails = result?.value || [];
      return {
        emails,
        hasMore: emails.length >= limit,
        nextSkip: emails.length >= limit ? skip + limit : undefined,
      };
    },
    { permissionAction: 'email_read' }
  );

  // --- mail_search ---
  registerTool(
    'mail_search',
    'Search emails by keyword in Outlook. Supports pagination via skip parameter.',
    createParameterSchema({
      query: { type: 'string', description: 'Search query string', required: true },
      limit: { type: 'number', description: 'Maximum number of results (default 20)', default: 20 },
      skip: { type: 'number', description: 'Number of emails to skip for pagination (use nextSkip from previous response)' },
    }),
    async (args: { query: string; limit?: number; skip?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      const skip = args.skip ?? 0;
      let url = `/me/messages?$search="${encodeURIComponent(args.query)}"&$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`;
      if (skip > 0) url += `&$skip=${skip}`;
      const result = await graphApi(ctx.userId, 'GET', url) as { value?: unknown[]; [key: string]: unknown };
      const emails = result?.value || [];
      return {
        emails,
        hasMore: emails.length >= limit,
        nextSkip: emails.length >= limit ? skip + limit : undefined,
      };
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

  // --- mail_process_batch ---
  registerTool(
    'mail_process_batch',
    'Fetch emails matching a search query in batches and return structured summaries for processing. Use nextSkip from previous response to get the next batch.',
    createParameterSchema({
      query: { type: 'string', description: 'Search query (e.g. "isRead eq false", "from:boss@company.com")', required: true },
      batch_size: { type: 'number', description: 'Number of emails per batch (default 10)', default: 10 },
      skip: { type: 'number', description: 'Number of emails to skip (continuation from previous batch)' },
    }),
    async (args: { query: string; batch_size?: number; skip?: number }, ctx: AgentContext) => {
      const batchSize = args.batch_size ?? 10;
      const skip = args.skip ?? 0;

      let url = `/me/messages?$search="${encodeURIComponent(args.query)}"&$top=${batchSize}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`;
      if (skip > 0) url += `&$skip=${skip}`;

      const listResult = await graphApi(ctx.userId, 'GET', url) as { value?: Array<{ id: string; subject?: string; from?: unknown; receivedDateTime?: string; isRead?: boolean; bodyPreview?: string }>; [key: string]: unknown };

      const messages = listResult?.value || [];

      if (messages.length === 0) {
        return {
          emails: [],
          totalInBatch: 0,
          hasMore: false,
          message: 'No emails matching the query.',
        };
      }

      // Fetch full content for each message in the batch
      const emails = await Promise.all(
        messages.map(async (msg) => {
          try {
            const detail = await graphApi(
              ctx.userId,
              'GET',
              `/me/messages/${msg.id}?$select=id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,categories`
            ) as { id: string; subject?: string; from?: { emailAddress?: { address?: string; name?: string } }; toRecipients?: Array<{ emailAddress?: { address?: string } }>; receivedDateTime?: string; isRead?: boolean; bodyPreview?: string; categories?: string[] };

            return {
              id: detail.id,
              from: detail.from?.emailAddress?.address || '',
              fromName: detail.from?.emailAddress?.name || '',
              to: detail.toRecipients?.map(r => r.emailAddress?.address).filter(Boolean) || [],
              subject: detail.subject || '',
              date: detail.receivedDateTime || '',
              snippet: detail.bodyPreview || '',
              isRead: detail.isRead,
              categories: detail.categories || [],
            };
          } catch {
            return {
              id: msg.id,
              subject: msg.subject,
              error: 'Failed to fetch email details',
            };
          }
        })
      );

      return {
        emails,
        totalInBatch: emails.length,
        hasMore: messages.length >= batchSize,
        nextSkip: messages.length >= batchSize ? skip + batchSize : undefined,
        instruction: 'Process each email and decide: reply, label, archive, delete, or skip. Use the mail tools directly for actions. Call mail_process_batch again with nextSkip to process the next batch.',
      };
    },
    { permissionAction: 'email_read' }
  );
}
