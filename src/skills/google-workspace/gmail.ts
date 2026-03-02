import { createParameterSchema } from '../base-skill';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, url: string, body?: unknown) => Promise<unknown>;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function buildMimeMessage(to: string, subject: string, body: string, inReplyTo?: string): string {
  const lines = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', ''];
  if (inReplyTo) lines.splice(1, 0, `In-Reply-To: ${inReplyTo}`);
  lines.push(body);
  return lines.join('\r\n');
}

export function registerGmailTools(registerTool: RegisterFn, googleApi: ApiFn): void {
  // --- gmail_list ---
  registerTool('gmail_list', 'List recent emails from your Gmail inbox', createParameterSchema({
    limit: { type: 'number', description: 'Maximum number of messages to return (default 10)', default: 10 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const limit = (args.limit as number) || 10;
    const listResult = await googleApi(
      context.userId,
      'GET',
      `${GMAIL_BASE}/messages?maxResults=${limit}`
    ) as { messages?: { id: string; threadId: string }[] };

    if (!listResult.messages || listResult.messages.length === 0) {
      return { messages: [] };
    }

    // Batch-get each message with format=metadata for summary info
    const messages = await Promise.all(
      listResult.messages.map(async (msg) => {
        const detail = await googleApi(
          context.userId,
          'GET',
          `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
        ) as { id: string; threadId: string; snippet: string; labelIds: string[]; payload?: { headers?: { name: string; value: string }[] } };

        const headers: Record<string, string> = {};
        if (detail.payload?.headers) {
          for (const h of detail.payload.headers) {
            headers[h.name.toLowerCase()] = h.value;
          }
        }

        return {
          id: detail.id,
          threadId: detail.threadId,
          from: headers['from'] || '',
          to: headers['to'] || '',
          subject: headers['subject'] || '',
          date: headers['date'] || '',
          snippet: detail.snippet,
          labelIds: detail.labelIds,
        };
      })
    );

    return { messages };
  }, { permissionAction: 'email_read' });

  // --- gmail_search ---
  registerTool('gmail_search', 'Search Gmail messages using a query string (same syntax as Gmail search bar)', createParameterSchema({
    query: { type: 'string', description: 'Gmail search query (e.g. "from:user@example.com subject:meeting")', required: true },
    limit: { type: 'number', description: 'Maximum number of results (default 10)', default: 10 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const query = encodeURIComponent(args.query as string);
    const limit = (args.limit as number) || 10;
    const listResult = await googleApi(
      context.userId,
      'GET',
      `${GMAIL_BASE}/messages?q=${query}&maxResults=${limit}`
    ) as { messages?: { id: string; threadId: string }[] };

    if (!listResult.messages || listResult.messages.length === 0) {
      return { messages: [], resultSizeEstimate: 0 };
    }

    const messages = await Promise.all(
      listResult.messages.map(async (msg) => {
        const detail = await googleApi(
          context.userId,
          'GET',
          `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
        ) as { id: string; threadId: string; snippet: string; labelIds: string[]; payload?: { headers?: { name: string; value: string }[] } };

        const headers: Record<string, string> = {};
        if (detail.payload?.headers) {
          for (const h of detail.payload.headers) {
            headers[h.name.toLowerCase()] = h.value;
          }
        }

        return {
          id: detail.id,
          threadId: detail.threadId,
          from: headers['from'] || '',
          to: headers['to'] || '',
          subject: headers['subject'] || '',
          date: headers['date'] || '',
          snippet: detail.snippet,
          labelIds: detail.labelIds,
        };
      })
    );

    return { messages };
  }, { permissionAction: 'email_read' });

  // --- gmail_read ---
  registerTool('gmail_read', 'Read the full content of an email message by ID', createParameterSchema({
    id: { type: 'string', description: 'The message ID to read', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const message = await googleApi(
      context.userId,
      'GET',
      `${GMAIL_BASE}/messages/${args.id}?format=full`
    );
    return message;
  }, { permissionAction: 'email_read' });

  // --- gmail_send ---
  registerTool('gmail_send', 'Send a new email via Gmail', createParameterSchema({
    to: { type: 'string', description: 'Recipient email address', required: true },
    subject: { type: 'string', description: 'Email subject', required: true },
    body: { type: 'string', description: 'Plain text email body', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const mime = buildMimeMessage(args.to as string, args.subject as string, args.body as string);
    const raw = Buffer.from(mime).toString('base64url');
    return googleApi(context.userId, 'POST', `${GMAIL_BASE}/messages/send`, { raw });
  }, { permissionAction: 'email_send' });

  // --- gmail_reply ---
  registerTool('gmail_reply', 'Reply to an existing email thread', createParameterSchema({
    to: { type: 'string', description: 'Recipient email address', required: true },
    subject: { type: 'string', description: 'Email subject (typically "Re: ...")', required: true },
    body: { type: 'string', description: 'Plain text reply body', required: true },
    threadId: { type: 'string', description: 'Thread ID to reply to', required: true },
    inReplyTo: { type: 'string', description: 'Message-ID header of the message being replied to', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const mime = buildMimeMessage(
      args.to as string,
      args.subject as string,
      args.body as string,
      args.inReplyTo as string
    );
    const raw = Buffer.from(mime).toString('base64url');
    return googleApi(context.userId, 'POST', `${GMAIL_BASE}/messages/send`, {
      raw,
      threadId: args.threadId,
    });
  }, { permissionAction: 'email_send' });

  // --- gmail_labels ---
  registerTool('gmail_labels', 'List all Gmail labels', createParameterSchema({}), async (_args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(context.userId, 'GET', `${GMAIL_BASE}/labels`);
  }, { permissionAction: 'email_read' });

  // --- gmail_label ---
  registerTool('gmail_label', 'Add or remove labels from a message', createParameterSchema({
    id: { type: 'string', description: 'Message ID', required: true },
    addLabelIds: { type: 'string', description: 'Comma-separated label IDs to add' },
    removeLabelIds: { type: 'string', description: 'Comma-separated label IDs to remove' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const body: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.addLabelIds) {
      body.addLabelIds = (args.addLabelIds as string).split(',').map(s => s.trim());
    }
    if (args.removeLabelIds) {
      body.removeLabelIds = (args.removeLabelIds as string).split(',').map(s => s.trim());
    }
    return googleApi(context.userId, 'POST', `${GMAIL_BASE}/messages/${args.id}/modify`, body);
  }, { permissionAction: 'email_read' });

  // --- gmail_delete ---
  registerTool('gmail_delete', 'Move an email message to Trash', createParameterSchema({
    id: { type: 'string', description: 'Message ID to trash', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(context.userId, 'POST', `${GMAIL_BASE}/messages/${args.id}/trash`);
  }, { permissionAction: 'delete' });
}
