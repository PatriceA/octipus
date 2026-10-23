import { addFollowUp, CaseLinkError, caseLinks, linkToCase } from '@/core/cases/links';
import {
  CASE_ENTITY_TYPES,
  CASE_STATUSES,
  CONTACT_KINDS,
  isCaseStatus,
  isContactKind,
  normalizeLabel,
  normalizeTags,
} from '@/core/cases/status';
import { parseTaskDate } from '@/core/tasks/timezone';
import type { ToolManifest } from '@/core/types';
import { reposFor } from '@/db/repositories/content';
import type { Case } from '@/db/schema/cases';
import type { Contact, ContactAddress } from '@/db/schema/contacts';
import { effectiveProtectionLevel } from '@/shared/protection';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Cases ("Vorgänge") and contacts (docs/CASES.md). The agent files a matter
 * as a case, links the people, documents, tasks and notes that belong to it,
 * and sets follow-ups that come back on a date. Everything goes through the
 * caller's content scope (`reposFor`): personally their own records, in a
 * space the space's, by the member's role. Reads are ALLOW, writes ASK.
 */
export class CasesTool extends BaseTool {
  readonly id = 'cases';
  readonly name = 'Cases & Contacts';
  readonly version = '1.0.0';
  readonly description = 'File matters of business as cases, link the people, documents and tasks that belong to them, and set follow-ups.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List and read cases and contacts', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create and change cases, contacts, links and follow-ups', defaultLevel: 'ASK' },
      ],
      tools: [
        { name: 'list_cases', description: 'List cases (filter by status, kind, text)', parameters: {}, returns: 'Array of cases' },
        { name: 'get_case', description: 'One case with everything linked to it', parameters: {}, returns: 'The case and its links' },
        { name: 'create_case', description: 'File a new case', parameters: {}, returns: 'The case' },
        { name: 'update_case', description: 'Change a case\'s title, kind, status, summary or assignee', parameters: {}, returns: 'The case' },
        { name: 'link_to_case', description: 'Link a contact, document, task, note or artifact to a case', parameters: {}, returns: 'The link' },
        { name: 'unlink_from_case', description: 'Remove a link from a case', parameters: {}, returns: 'Whether it was removed' },
        { name: 'add_follow_up', description: 'Set a follow-up on a case: a task that reminds on a date', parameters: {}, returns: 'The follow-up task' },
        { name: 'find_contacts', description: 'Find contacts by name, email, phone, tag or kind', parameters: {}, returns: 'Array of contacts' },
        { name: 'get_contact', description: 'One contact with the cases it is linked to', parameters: {}, returns: 'The contact' },
        { name: 'create_contact', description: 'Add a person or organisation', parameters: {}, returns: 'The contact' },
        { name: 'update_contact', description: 'Change a contact', parameters: {}, returns: 'The contact' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_cases',
      'List cases, active ones (open, waiting) first. Default: active cases only; status "all" for every case.',
      createParameterSchema({
        status: { type: 'string', description: 'Filter by status; "all" for every status', enum: [...CASE_STATUSES, 'all'] },
        kind: { type: 'string', description: 'Only cases of this kind, e.g. "invoice" or "complaint"' },
        query: { type: 'string', description: 'Text to match in title and summary' },
        limit: { type: 'number', description: 'Max cases (default 50)' },
      }),
      async (args, context) => {
        const status = args.status as string | undefined;
        const rows = await reposFor(context).cases.list({
          status: status && status !== 'all' ? status : undefined,
          statuses: status ? undefined : ['open', 'waiting'],
          kind: normalizeLabel(args.kind) ?? undefined,
          q: typeof args.query === 'string' ? args.query : undefined,
          limit: clampLimit(args.limit, 50),
        });
        return { cases: rows.map(summarizeCase) };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'get_case',
      'Read one case with every contact, document, task, note and artifact linked to it.',
      createParameterSchema({ id: { type: 'string', description: 'Case id', required: true } }),
      async (args, context) => {
        const repos = reposFor(context);
        const found = await repos.cases.findById(String(args.id ?? ''));
        const links = found ? await caseLinks(repos, found) : null;
        if (!found || !links) return { error: 'Case not found' };
        return { case: { ...summarizeCase(found), links } };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'create_case',
      'File a new case for a matter of business (an incoming invoice, a complaint, an inquiry). Set kind to name what it is. With externalKey (the matter\'s id in the system it came from), a case that already exists for that key is returned instead of a duplicate.',
      createParameterSchema({
        title: { type: 'string', description: 'Case title', required: true },
        kind: { type: 'string', description: 'What kind of matter, e.g. "invoice", "complaint", "inquiry"' },
        summary: { type: 'string', description: 'What the case is about' },
        status: { type: 'string', description: 'Initial status (default open)', enum: [...CASE_STATUSES] },
        assigneeUserId: { type: 'string', description: 'User responsible for the case' },
        externalKey: { type: 'string', description: 'Id of the matter in its source system, e.g. "mail:<message-id>"' },
      }),
      async (args, context) => {
        const title = typeof args.title === 'string' ? args.title.trim().slice(0, 500) : '';
        if (!title) return { error: 'title is required' };
        if (args.status !== undefined && !isCaseStatus(args.status)) return { error: `Invalid status "${String(args.status)}"` };
        const values = {
          title,
          kind: normalizeLabel(args.kind),
          summary: typeof args.summary === 'string' ? args.summary.slice(0, 20_000) : null,
          status: (args.status as string | undefined) ?? 'open',
          assigneeUserId: idOrNull(args.assigneeUserId),
          source: 'agent',
          sourceRef: context.sessionId ? { sessionId: context.sessionId } : undefined,
        };
        try {
          const repo = reposFor(context).cases;
          const externalKey = normalizeLabel(args.externalKey, 300);
          if (externalKey) {
            const result = await repo.createOnce({ ...values, externalKey });
            return { created: result.created, case: summarizeCase(result.case) };
          }
          return { created: true, case: summarizeCase(await repo.create(values)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'update_case',
      'Change a case. Status: open (being worked), waiting (on someone outside), done, archived.',
      createParameterSchema({
        id: { type: 'string', description: 'Case id', required: true },
        title: { type: 'string', description: 'New title' },
        kind: { type: 'string', description: 'New kind; empty string clears it' },
        status: { type: 'string', description: 'New status', enum: [...CASE_STATUSES] },
        summary: { type: 'string', description: 'New summary' },
        assigneeUserId: { type: 'string', description: 'User responsible; empty string unassigns' },
      }),
      async (args, context) => {
        if (args.status !== undefined && !isCaseStatus(args.status)) return { error: `Invalid status "${String(args.status)}"` };
        const title = typeof args.title === 'string' ? args.title.trim().slice(0, 500) : undefined;
        if (title === '') return { error: 'title cannot be empty' };
        try {
          const updated = await reposFor(context).cases.update(String(args.id ?? ''), {
            title,
            kind: args.kind !== undefined ? normalizeLabel(args.kind) : undefined,
            status: args.status as string | undefined,
            summary: typeof args.summary === 'string' ? args.summary.slice(0, 20_000) : undefined,
            assigneeUserId: args.assigneeUserId !== undefined ? idOrNull(args.assigneeUserId) : undefined,
          });
          if (!updated) return { error: 'Case not found' };
          return { updated: true, case: summarizeCase(updated) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'link_to_case',
      'Link a contact, document, task, note, artifact or record to a case, with an optional role ("client", "sender", "invoice"). Linking the same entity again changes its role.',
      createParameterSchema({
        caseId: { type: 'string', description: 'Case id', required: true },
        entityType: { type: 'string', description: 'What to link', enum: [...CASE_ENTITY_TYPES], required: true },
        entityId: { type: 'string', description: 'Id of the contact, document, task, note, artifact or record', required: true },
        role: { type: 'string', description: 'What it is to the case' },
      }),
      async (args, context) => {
        try {
          const link = await linkToCase(reposFor(context), String(args.caseId ?? ''), {
            entityType: args.entityType,
            entityId: String(args.entityId ?? ''),
            role: args.role,
          });
          if (!link) return { error: 'Case not found' };
          return { linked: true, link };
        } catch (err) {
          return { error: err instanceof CaseLinkError ? err.message : (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'unlink_from_case',
      'Remove a link from a case (the linked entity itself stays).',
      createParameterSchema({
        caseId: { type: 'string', description: 'Case id', required: true },
        linkId: { type: 'string', description: 'Link id, from get_case', required: true },
      }),
      async (args, context) => {
        const removed = await reposFor(context).cases.removeLink(String(args.caseId ?? ''), String(args.linkId ?? ''));
        return removed ? { removed: true } : { error: 'Link not found' };
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'add_follow_up',
      'Set a follow-up ("Wiedervorlage") on a case: a task linked to the case that reminds its assignee at remindAt. The assignee defaults to the case\'s.',
      createParameterSchema({
        caseId: { type: 'string', description: 'Case id', required: true },
        title: { type: 'string', description: 'What to follow up on', required: true },
        remindAt: { type: 'string', description: 'When to remind, ISO 8601; a bare date is the start of that day', required: true },
        dueAt: { type: 'string', description: 'Optional due date, ISO 8601; a bare date is the end of that day' },
        notes: { type: 'string', description: 'Optional details' },
        assigneeUserId: { type: 'string', description: 'User to remind; defaults to the case\'s assignee' },
      }),
      async (args, context) => {
        const title = typeof args.title === 'string' ? args.title.trim().slice(0, 500) : '';
        if (!title) return { error: 'title is required' };
        if (typeof args.remindAt !== 'string' || !args.remindAt.trim()) return { error: 'remindAt is required' };
        try {
          const remindAt = await parseTaskDate(args.remindAt, 'remindAt', context.userId);
          const dueAt = typeof args.dueAt === 'string' && args.dueAt.trim() ? await parseTaskDate(args.dueAt, 'dueAt', context.userId) : null;
          const result = await addFollowUp(reposFor(context), String(args.caseId ?? ''), {
            title,
            remindAt,
            dueAt,
            notes: typeof args.notes === 'string' ? args.notes.slice(0, 10_000) : null,
            assigneeUserId: args.assigneeUserId !== undefined ? idOrNull(args.assigneeUserId) : undefined,
            source: 'agent',
            sourceRef: context.sessionId ? { sessionId: context.sessionId } : undefined,
          });
          if (!result) return { error: 'Case not found' };
          return { created: true, task: { id: result.task.id, title: result.task.title, remindAt: result.task.remindAt, dueAt: result.task.dueAt }, link: result.link };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'find_contacts',
      'Find contacts by name, email or phone (query), tag ("client", "relative") or kind.',
      createParameterSchema({
        query: { type: 'string', description: 'Text to match in name, email and phone' },
        tag: { type: 'string', description: 'Only contacts with this tag' },
        kind: { type: 'string', description: 'person or organization', enum: [...CONTACT_KINDS] },
        organizationId: { type: 'string', description: 'Only the people of this organisation' },
        limit: { type: 'number', description: 'Max contacts (default 50)' },
      }),
      async (args, context) => {
        const rows = await reposFor(context).contacts.list({
          q: typeof args.query === 'string' ? args.query : undefined,
          tag: typeof args.tag === 'string' && args.tag.trim() ? args.tag : undefined,
          kind: isContactKind(args.kind) ? args.kind : undefined,
          organizationId: idOrNull(args.organizationId) ?? undefined,
          limit: clampLimit(args.limit, 50),
        });
        return { contacts: rows.map(summarizeContact) };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'get_contact',
      'Read one contact with the cases it is linked to.',
      createParameterSchema({ id: { type: 'string', description: 'Contact id', required: true } }),
      async (args, context) => {
        const repos = reposFor(context);
        const contact = await repos.contacts.findById(String(args.id ?? ''));
        if (!contact) return { error: 'Contact not found' };
        const linked = await repos.cases.casesLinkedTo('contact', contact.id);
        return { contact: { ...summarizeContact(contact), cases: linked.map((l) => ({ ...summarizeCase(l.case), role: l.role })) } };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    const contactParams = {
      kind: { type: 'string', description: 'person (default) or organization', enum: [...CONTACT_KINDS] as string[] },
      email: { type: 'string', description: 'Email address' },
      phone: { type: 'string', description: 'Phone number' },
      street: { type: 'string', description: 'Street and number' },
      postalCode: { type: 'string', description: 'Postal code' },
      city: { type: 'string', description: 'City' },
      country: { type: 'string', description: 'Country' },
      organizationId: { type: 'string', description: 'The organisation (a contact of kind organization) this person belongs to' },
      tags: { type: 'array', description: 'What the contact is to the business, e.g. ["client"]', items: { type: 'string' } },
      notes: { type: 'string', description: 'Free notes' },
    };

    this.registerTool(
      'create_contact',
      'Add a person or organisation. Search with find_contacts first so the same person is not added twice. With externalKey (their id in the system they came from), an existing contact for that key is returned instead.',
      createParameterSchema({
        name: { type: 'string', description: 'Full name or organisation name', required: true },
        ...contactParams,
        externalKey: { type: 'string', description: 'Id of the contact in its source system' },
      }),
      async (args, context) => {
        const name = typeof args.name === 'string' ? args.name.trim().slice(0, 300) : '';
        if (!name) return { error: 'name is required' };
        if (args.kind !== undefined && !isContactKind(args.kind)) return { error: `Invalid kind "${String(args.kind)}"` };
        const values = {
          name,
          kind: (args.kind as string | undefined) ?? 'person',
          email: text(args.email, 320),
          phone: text(args.phone, 50),
          address: addressOf(args),
          organizationId: idOrNull(args.organizationId),
          tags: normalizeTags(args.tags),
          notes: text(args.notes, 20_000),
        };
        try {
          const repo = reposFor(context).contacts;
          const externalKey = normalizeLabel(args.externalKey, 300);
          if (externalKey) {
            const result = await repo.createOnce({ ...values, externalKey });
            return { created: result.created, contact: summarizeContact(result.contact) };
          }
          return { created: true, contact: summarizeContact(await repo.create(values)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'update_contact',
      'Change a contact. Fields not given stay as they are; an empty string clears a field. Address fields replace the whole address when any is given.',
      createParameterSchema({
        id: { type: 'string', description: 'Contact id', required: true },
        name: { type: 'string', description: 'New name' },
        ...contactParams,
      }),
      async (args, context) => {
        if (args.kind !== undefined && !isContactKind(args.kind)) return { error: `Invalid kind "${String(args.kind)}"` };
        const name = typeof args.name === 'string' ? args.name.trim().slice(0, 300) : undefined;
        if (name === '') return { error: 'name cannot be empty' };
        const addressGiven = ['street', 'postalCode', 'city', 'country'].some((k) => args[k] !== undefined);
        try {
          const updated = await reposFor(context).contacts.update(String(args.id ?? ''), {
            name,
            kind: args.kind as string | undefined,
            email: args.email !== undefined ? text(args.email, 320) : undefined,
            phone: args.phone !== undefined ? text(args.phone, 50) : undefined,
            address: addressGiven ? addressOf(args) : undefined,
            organizationId: args.organizationId !== undefined ? idOrNull(args.organizationId) : undefined,
            tags: args.tags !== undefined ? normalizeTags(args.tags) : undefined,
            notes: args.notes !== undefined ? text(args.notes, 20_000) : undefined,
          });
          if (!updated) return { error: 'Contact not found' };
          return { updated: true, contact: summarizeContact(updated) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );
  }
}

function clampLimit(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(200, Math.trunc(n))) : fallback;
}

/** An optional id argument: empty/absent → null. */
function idOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** An optional text argument, trimmed and bounded; empty → null. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s.slice(0, max);
}

function addressOf(args: Record<string, unknown>): ContactAddress | null {
  const out: ContactAddress = {};
  for (const key of ['street', 'postalCode', 'city', 'country'] as const) {
    const v = text(args[key], 200);
    if (v) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function summarizeCase(c: Case) {
  return {
    id: c.id,
    title: c.title,
    kind: c.kind,
    status: c.status,
    summary: c.summary,
    assigneeUserId: c.assigneeUserId,
    source: c.source,
    externalKey: c.externalKey,
    protectionLevel: effectiveProtectionLevel(c.protectionLevel),
    closedAt: c.closedAt,
    updatedAt: c.updatedAt,
  };
}

function summarizeContact(c: Contact) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: c.address,
    organizationId: c.organizationId,
    tags: c.tags,
    notes: c.notes,
  };
}

export const casesTool = new CasesTool();
