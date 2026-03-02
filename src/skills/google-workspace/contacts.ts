import { createParameterSchema } from '../base-skill';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, url: string, body?: unknown) => Promise<unknown>;

const PEOPLE_BASE = 'https://people.googleapis.com/v1';

export function registerContactsTools(registerTool: RegisterFn, googleApi: ApiFn): void {
  // --- contacts_list ---
  registerTool('contacts_list', 'List contacts from Google Contacts', createParameterSchema({
    limit: { type: 'number', description: 'Maximum number of contacts (default 25)', default: 25 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const pageSize = (args.limit as number) || 25;
    return googleApi(
      context.userId,
      'GET',
      `${PEOPLE_BASE}/people/me/connections?personFields=${encodeURIComponent('names,emailAddresses,phoneNumbers')}&pageSize=${pageSize}`
    );
  }, { permissionAction: 'contacts_read' });

  // --- contacts_search ---
  registerTool('contacts_search', 'Search contacts by name or email', createParameterSchema({
    query: { type: 'string', description: 'Search query (name, email, or phone number)', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const query = encodeURIComponent(args.query as string);
    return googleApi(
      context.userId,
      'GET',
      `${PEOPLE_BASE}/people:searchContacts?query=${query}&readMask=${encodeURIComponent('names,emailAddresses,phoneNumbers')}`
    );
  }, { permissionAction: 'contacts_read' });

  // --- contacts_get ---
  registerTool('contacts_get', 'Get detailed information about a specific contact', createParameterSchema({
    resourceName: { type: 'string', description: 'Contact resource name (e.g. "people/c1234567890")', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const resourceName = args.resourceName as string;
    return googleApi(
      context.userId,
      'GET',
      `${PEOPLE_BASE}/${resourceName}?personFields=${encodeURIComponent('names,emailAddresses,phoneNumbers,organizations,addresses')}`
    );
  }, { permissionAction: 'contacts_read' });

  // --- contacts_create ---
  registerTool('contacts_create', 'Create a new contact in Google Contacts', createParameterSchema({
    givenName: { type: 'string', description: 'First name', required: true },
    familyName: { type: 'string', description: 'Last name' },
    email: { type: 'string', description: 'Email address' },
    phone: { type: 'string', description: 'Phone number' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const name: Record<string, unknown> = { givenName: args.givenName };
    if (args.familyName) name.familyName = args.familyName;

    const contact: Record<string, unknown> = {
      names: [name],
    };

    if (args.email) {
      contact.emailAddresses = [{ value: args.email }];
    }
    if (args.phone) {
      contact.phoneNumbers = [{ value: args.phone }];
    }

    return googleApi(
      context.userId,
      'POST',
      `${PEOPLE_BASE}/people:createContact`,
      contact
    );
  }, { permissionAction: 'contacts_write' });
}
