import { normalizeLabel } from '@/core/cases/status';
import { FIELD_TYPES, RecordValidationError } from '@/core/records/fields';
import type { ToolManifest } from '@/core/types';
import { reposFor } from '@/db/repositories/content';
import type { RecordRow, RecordType } from '@/db/schema/records';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Record types and records (docs/RECORDS.md): structured data with fields a
 * business defines — invoices, vehicles, licences. The agent reads a type's
 * fields before writing a record, and every write is validated against them.
 * Records link to cases with the cases tool (`link_to_case`, entity type
 * `record`). Form links are not offered here: publishing a form to people
 * outside is the user's call, from the API or the web.
 */
export class RecordsTool extends BaseTool {
  readonly id = 'records';
  readonly name = 'Records';
  readonly version = '1.0.0';
  readonly description = 'Keep structured records (invoices, vehicles, licences…) with fields the business defines.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List record types and read records', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Define record types and create or change records', defaultLevel: 'ASK' },
      ],
      tools: [
        { name: 'list_record_types', description: 'The record types defined here, with their fields', parameters: {}, returns: 'Array of types' },
        { name: 'define_record_type', description: 'Define a new record type or change an existing one', parameters: {}, returns: 'The type' },
        { name: 'list_records', description: 'List records of a type', parameters: {}, returns: 'Array of records' },
        { name: 'get_record', description: 'One record with the cases it is linked to', parameters: {}, returns: 'The record' },
        { name: 'create_record', description: 'Create a record of a type', parameters: {}, returns: 'The record' },
        { name: 'update_record', description: 'Change some fields of a record', parameters: {}, returns: 'The record' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_record_types',
      'List the record types defined here, each with its key and fields. Read this before creating a record.',
      createParameterSchema({}),
      async (_args, context) => ({ types: (await reposFor(context).recordTypes.list()).map(summarizeType) }),
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'define_record_type',
      `Define a record type, or change the one with this key. fields is a list of { key, label, type, required?, options?, help? }; type is one of ${FIELD_TYPES.join(', ')}; a select needs options. Keys are lower-case letters, digits and _. Changing a type keeps existing records' data.`,
      createParameterSchema({
        key: { type: 'string', description: 'Machine key, e.g. "invoice"', required: true },
        name: { type: 'string', description: 'Display name, e.g. "Invoice"', required: true },
        description: { type: 'string', description: 'What records of this type are' },
        fields: { type: 'array', description: 'The fields', required: true, items: { type: 'object' } },
        titleField: { type: 'string', description: 'Key of the text field a record is titled by; empty string clears it' },
      }),
      async (args, context) => {
        const repo = reposFor(context).recordTypes;
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const input = {
          key,
          name: typeof args.name === 'string' ? args.name : '',
          description: typeof args.description === 'string' ? args.description.slice(0, 2000) : undefined,
          fields: args.fields,
          // Absent leaves an existing type's title field as it is; "" clears it.
          ...(args.titleField !== undefined ? { titleField: normalizeLabel(args.titleField, 50) } : {}),
        };
        try {
          const existing = key ? await repo.findByKey(key) : null;
          const type = existing ? await repo.update(existing.id, input) : await repo.create(input);
          if (!type) return { error: 'Record type not found' };
          return { [existing ? 'updated' : 'created']: true, type: summarizeType(type) };
        } catch (err) {
          return failure(err);
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'list_records',
      'List records of a type (by key or id), newest first, optionally matching a text in the title.',
      createParameterSchema({
        type: { type: 'string', description: 'Type key or id', required: true },
        query: { type: 'string', description: 'Text to match in the title' },
        limit: { type: 'number', description: 'Max records (default 50)' },
      }),
      async (args, context) => {
        const repos = reposFor(context);
        const type = await repos.recordTypes.resolve(String(args.type ?? ''));
        if (!type) return { error: `Record type not found: ${String(args.type)}` };
        const limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit) || 50)));
        const rows = await repos.records.list({ typeId: type.id, q: typeof args.query === 'string' ? args.query : undefined, limit });
        return { type: type.key, records: rows.map(summarizeRecord) };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'get_record',
      'Read one record with its data and the cases it is linked to.',
      createParameterSchema({ id: { type: 'string', description: 'Record id', required: true } }),
      async (args, context) => {
        const repos = reposFor(context);
        const record = await repos.records.findById(String(args.id ?? ''));
        if (!record) return { error: 'Record not found' };
        const cases = await repos.cases.casesLinkedTo('record', record.id);
        return { record: { ...summarizeRecord(record), cases: cases.map((l) => ({ id: l.case.id, title: l.case.title, status: l.case.status, role: l.role })) } };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'create_record',
      'Create a record of a type. data maps field keys to values: text as strings, number/money as numbers, date as YYYY-MM-DD, boolean as true/false, select as one of its options. With externalKey (its id in the source system), an existing record for that key is returned instead.',
      createParameterSchema({
        type: { type: 'string', description: 'Type key or id', required: true },
        data: { type: 'object', description: 'Field values by key', required: true },
        externalKey: { type: 'string', description: 'Id of the record in its source system' },
      }),
      async (args, context) => {
        const repo = reposFor(context).records;
        const input = { data: args.data, source: 'agent', sourceRef: context.sessionId ? { sessionId: context.sessionId } : undefined };
        try {
          const externalKey = normalizeLabel(args.externalKey, 300);
          if (externalKey) {
            const result = await repo.createOnce(String(args.type ?? ''), { ...input, externalKey });
            return { created: result.created, record: summarizeRecord(result.record) };
          }
          return { created: true, record: summarizeRecord(await repo.create(String(args.type ?? ''), input)) };
        } catch (err) {
          return failure(err);
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'update_record',
      'Change some fields of a record. Fields not in data keep their value; null clears one.',
      createParameterSchema({
        id: { type: 'string', description: 'Record id', required: true },
        data: { type: 'object', description: 'Field values to change, by key', required: true },
      }),
      async (args, context) => {
        try {
          const updated = await reposFor(context).records.update(String(args.id ?? ''), args.data);
          if (!updated) return { error: 'Record not found' };
          return { updated: true, record: summarizeRecord(updated) };
        } catch (err) {
          return failure(err);
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );
  }
}

function failure(err: unknown): { error: string; problems?: string[] } {
  if (err instanceof RecordValidationError) return { error: err.message, problems: err.problems };
  return { error: err instanceof Error ? err.message : String(err) };
}

function summarizeType(t: RecordType) {
  return { id: t.id, key: t.key, name: t.name, description: t.description, fields: t.fields, titleField: t.titleField };
}

function summarizeRecord(r: RecordRow) {
  return { id: r.id, typeId: r.typeId, title: r.title, data: r.data, source: r.source, externalKey: r.externalKey, protectionLevel: r.protectionLevel, updatedAt: r.updatedAt };
}

export const recordsTool = new RecordsTool();
