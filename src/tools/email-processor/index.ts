import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';
import type { ToolManifest, AgentContext } from '@/core/types';

export class EmailProcessorTool extends BaseTool {
  readonly id = 'email-processor';
  readonly name = 'Email Processor';
  readonly version = '1.0.0';
  readonly description = 'Process emails one-by-one with AI-driven classification and actions. Supports batch processing with per-email decisions.';

  override async checkAvailability(): Promise<ToolAvailability> {
    // Requires at least one email provider (Google or Microsoft) to be configured
    const { getToolRegistry } = await import('../registry');
    const registry = getToolRegistry();
    const google = registry.get('google-workspace');
    const microsoft = registry.get('microsoft365');
    const googleOk = google ? (await google.checkAvailability()).available : false;
    const microsoftOk = microsoft ? (await microsoft.checkAvailability()).available : false;
    if (!googleOk && !microsoftOk) {
      return { available: false, reason: 'No email provider configured (Google or Microsoft OAuth required)' };
    }
    return { available: true };
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'process', description: 'Process and classify emails', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'process_emails', description: 'Process unread emails one by one', parameters: { provider: { type: 'string', description: 'Email provider: gmail or outlook', required: true }, query: { type: 'string', description: 'Search query' }, limit: { type: 'number', description: 'Batch size' } }, returns: 'Processing results per email' },
        { name: 'get_email_summary', description: 'Get a structured summary of a single email for processing', parameters: { provider: { type: 'string', description: 'Email provider: gmail or outlook', required: true }, id: { type: 'string', description: 'Email message ID', required: true } }, returns: 'Structured email summary' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'process_emails',
      'Fetch and return emails one-by-one for processing. Returns a batch of email summaries with IDs. The agent should process each one and decide on actions (reply, label, archive, delete, flag). Use page_token/skip to continue to the next batch.',
      createParameterSchema({
        provider: { type: 'string', description: 'Email provider: gmail or outlook', required: true },
        query: { type: 'string', description: 'Search query (e.g., "is:unread", "from:boss@company.com")', default: 'is:unread' },
        batch_size: { type: 'number', description: 'Number of emails per batch (default: 5)', default: 5 },
        page_token: { type: 'string', description: 'Continuation token from previous batch (Gmail nextPageToken or Outlook nextSkip as string)' },
      }),
      async (args: Record<string, unknown>, context: AgentContext) => {
        const provider = args.provider as string;
        const query = (args.query as string) || 'is:unread';
        const batchSize = (args.batch_size as number) || 5;
        const pageToken = args.page_token as string | undefined;

        const { getToolRegistry } = await import('../registry');
        const registry = getToolRegistry();

        let toolId: string;
        let searchToolName: string;
        let readToolName: string;

        if (provider === 'outlook') {
          toolId = 'microsoft365';
          searchToolName = 'mail_search';
          readToolName = 'mail_read';
        } else {
          toolId = 'google-workspace';
          searchToolName = 'gmail_search';
          readToolName = 'gmail_read';
        }

        const tool = registry.get(toolId);
        if (!tool) {
          return { error: `Email provider tool '${toolId}' not found or not configured` };
        }

        // Build search args based on provider
        const searchArgs: Record<string, unknown> = {
          query,
          limit: batchSize,
        };

        if (provider === 'outlook') {
          // Outlook uses numeric skip for pagination
          if (pageToken) searchArgs.skip = parseInt(pageToken, 10);
        } else {
          // Gmail uses string page tokens
          if (pageToken) searchArgs.page_token = pageToken;
        }

        // Get the search tool handler and execute it
        const searchHandler = tool.getTool(searchToolName);
        if (!searchHandler) {
          return { error: `Search tool '${searchToolName}' not found on provider '${toolId}'` };
        }

        const listResult = await searchHandler.execute(searchArgs, context);
        const listData = typeof listResult === 'string' ? JSON.parse(listResult) : listResult;
        const messages = listData.messages || listData.emails || [];

        if (messages.length === 0) {
          return {
            emails: [],
            totalInBatch: 0,
            hasMore: false,
            message: 'No emails matching the query.',
          };
        }

        // Get the read tool handler
        const readHandler = tool.getTool(readToolName);
        if (!readHandler) {
          return { error: `Read tool '${readToolName}' not found on provider '${toolId}'` };
        }

        // For each email, fetch full content and create a structured summary
        const emailSummaries = [];
        for (const msg of messages) {
          try {
            const fullEmail = await readHandler.execute({ id: msg.id }, context);
            const emailData = typeof fullEmail === 'string' ? JSON.parse(fullEmail) : fullEmail;

            emailSummaries.push({
              id: msg.id,
              from: emailData.from || msg.from,
              to: emailData.to || emailData.toRecipients || msg.to,
              subject: emailData.subject || msg.subject,
              date: emailData.date || msg.date || msg.receivedDateTime,
              snippet: msg.snippet || msg.bodyPreview || (typeof emailData.body === 'string' ? emailData.body.slice(0, 300) : emailData.bodyPreview),
              labels: emailData.labelIds || emailData.labels || emailData.categories,
              threadId: emailData.threadId,
              isRead: emailData.isRead,
            });
          } catch {
            emailSummaries.push({
              id: msg.id,
              subject: msg.subject,
              from: msg.from,
              error: 'Failed to fetch full email',
            });
          }
        }

        // Determine pagination info
        const hasMore = !!listData.nextPageToken || !!listData.hasMore;
        let nextPageToken: string | undefined;
        if (listData.nextPageToken) {
          nextPageToken = listData.nextPageToken;
        } else if (listData.nextSkip !== undefined) {
          nextPageToken = String(listData.nextSkip);
        }

        return {
          emails: emailSummaries,
          totalInBatch: emailSummaries.length,
          hasMore,
          nextPageToken,
          instruction: 'Process each email and decide: reply, label, archive, delete, or skip. Use the email tools directly for actions (gmail_reply/mail_reply, gmail_label, gmail_delete/mail_delete). Pass nextPageToken to process_emails to get the next batch.',
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'get_email_summary',
      'Get a detailed structured summary of a single email for processing decisions.',
      createParameterSchema({
        provider: { type: 'string', description: 'Email provider: gmail or outlook', required: true },
        id: { type: 'string', description: 'Email message ID', required: true },
      }),
      async (args: Record<string, unknown>, context: AgentContext) => {
        const provider = args.provider as string;
        const id = args.id as string;

        const { getToolRegistry } = await import('../registry');
        const registry = getToolRegistry();

        const toolId = provider === 'outlook' ? 'microsoft365' : 'google-workspace';
        const readToolName = provider === 'outlook' ? 'mail_read' : 'gmail_read';

        const tool = registry.get(toolId);
        if (!tool) {
          return { error: `Email provider tool '${toolId}' not found` };
        }

        const readHandler = tool.getTool(readToolName);
        if (!readHandler) {
          return { error: `Read tool '${readToolName}' not found on provider '${toolId}'` };
        }

        const result = await readHandler.execute({ id }, context);
        return typeof result === 'string' ? JSON.parse(result) : result;
      },
      { requiresPermission: false },
    );
  }
}

export const emailProcessorTool = new EmailProcessorTool();
