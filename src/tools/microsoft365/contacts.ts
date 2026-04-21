import type { AgentContext } from '@/core/types';
import { createParameterSchema } from '../base-tool';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export function registerContactsTools(registerTool: RegisterFn, graphApi: ApiFn): void {
  // --- contacts_list ---
  registerTool(
    'contacts_list',
    'List contacts from Microsoft 365',
    createParameterSchema({
      limit: { type: 'number', description: 'Maximum number of contacts to return (default 20)', default: 20 },
    }),
    async (args: { limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/contacts?$select=id,displayName,emailAddresses,businessPhones,companyName,jobTitle&$top=${limit}`
      );
    },
    { permissionAction: 'contacts_read' }
  );

  // --- contacts_search ---
  registerTool(
    'contacts_search',
    'Search contacts by display name',
    createParameterSchema({
      query: { type: 'string', description: 'Name to search for (matches start of display name)', required: true },
      limit: { type: 'number', description: 'Maximum number of results (default 20)', default: 20 },
    }),
    async (args: { query: string; limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/contacts?$filter=startswith(displayName,'${encodeURIComponent(args.query)}')&$select=id,displayName,emailAddresses,businessPhones,companyName,jobTitle&$top=${limit}`
      );
    },
    { permissionAction: 'contacts_read' }
  );

  // --- contacts_get ---
  registerTool(
    'contacts_get',
    'Get a specific contact by ID',
    createParameterSchema({
      id: { type: 'string', description: 'The contact ID', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      return graphApi(ctx.userId, 'GET', `/me/contacts/${args.id}`);
    },
    { permissionAction: 'contacts_read' }
  );

  // --- contacts_create ---
  registerTool(
    'contacts_create',
    'Create a new contact in Microsoft 365',
    createParameterSchema({
      givenName: { type: 'string', description: 'First name', required: true },
      surname: { type: 'string', description: 'Last name' },
      email: { type: 'string', description: 'Email address' },
      emailName: { type: 'string', description: 'Display name for the email address' },
      businessPhone: { type: 'string', description: 'Business phone number' },
    }),
    async (args: {
      givenName: string;
      surname?: string;
      email?: string;
      emailName?: string;
      businessPhone?: string;
    }, ctx: AgentContext) => {
      const contact: Record<string, unknown> = {
        givenName: args.givenName,
      };

      if (args.surname) contact.surname = args.surname;

      if (args.email) {
        contact.emailAddresses = [
          { address: args.email, name: args.emailName ?? args.email },
        ];
      }

      if (args.businessPhone) {
        contact.businessPhones = [args.businessPhone];
      }

      return graphApi(ctx.userId, 'POST', '/me/contacts', contact);
    },
    { permissionAction: 'contacts_write' }
  );

  // --- contacts_update ---
  registerTool(
    'contacts_update',
    'Update an existing contact',
    createParameterSchema({
      id: { type: 'string', description: 'The contact ID to update', required: true },
      givenName: { type: 'string', description: 'Updated first name' },
      surname: { type: 'string', description: 'Updated last name' },
      email: { type: 'string', description: 'Updated email address' },
      emailName: { type: 'string', description: 'Updated display name for the email address' },
      businessPhone: { type: 'string', description: 'Updated business phone number' },
      companyName: { type: 'string', description: 'Updated company name' },
      jobTitle: { type: 'string', description: 'Updated job title' },
    }),
    async (args: {
      id: string;
      givenName?: string;
      surname?: string;
      email?: string;
      emailName?: string;
      businessPhone?: string;
      companyName?: string;
      jobTitle?: string;
    }, ctx: AgentContext) => {
      const update: Record<string, unknown> = {};

      if (args.givenName) update.givenName = args.givenName;
      if (args.surname) update.surname = args.surname;
      if (args.companyName) update.companyName = args.companyName;
      if (args.jobTitle) update.jobTitle = args.jobTitle;

      if (args.email) {
        update.emailAddresses = [
          { address: args.email, name: args.emailName ?? args.email },
        ];
      }

      if (args.businessPhone) {
        update.businessPhones = [args.businessPhone];
      }

      return graphApi(ctx.userId, 'PATCH', `/me/contacts/${args.id}`, update);
    },
    { permissionAction: 'contacts_write' }
  );
}
