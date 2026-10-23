/**
 * Field definitions of record types and validation of record data against
 * them (docs/RECORDS.md). A record type is data, not code: a module or a
 * plugin defines "invoice" with an amount and a due date, and every write of
 * an invoice record — through the API, the agent's tool or a public form —
 * is checked here against the type's current fields.
 *
 * Values are stored as JSON: text kinds as strings, `number` and `money` as
 * numbers (money in the currency's major unit, e.g. 12.5 = 12,50 €), `date`
 * as `YYYY-MM-DD`, `boolean` as true/false, `select` as one of its options.
 */
import { z } from 'zod';
import { FIELD_TYPES, type FieldDef, KEY_RE, MAX_FIELDS, type RecordData, type RecordValue } from '@/shared/record-fields';

export { FIELD_TYPES, type FieldDef, type FieldType, KEY_RE, MAX_FIELDS, type RecordData, type RecordValue } from '@/shared/record-fields';

export const fieldDefSchema = z.object({
  key: z.string().regex(KEY_RE, 'A field key is lower-case letters, digits and _, starting with a letter (at most 50)'),
  label: z.string().trim().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  /** The choices of a `select` field. */
  options: z.array(z.string().trim().min(1).max(100)).min(1).max(100).optional(),
  /** Shown under the field in a form. */
  help: z.string().max(500).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.type === 'select' && !field.options) ctx.addIssue({ code: 'custom', message: `Field "${field.key}" is a select and needs options` });
  if (field.type !== 'select' && field.options) ctx.addIssue({ code: 'custom', message: `Field "${field.key}" has options but is not a select` });
  if (field.options && new Set(field.options).size !== field.options.length) {
    ctx.addIssue({ code: 'custom', message: `Field "${field.key}" lists an option twice` });
  }
});

export const fieldListSchema = z.array(fieldDefSchema).max(MAX_FIELDS).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.key)) ctx.addIssue({ code: 'custom', message: `Field key "${f.key}" is used twice` });
    seen.add(f.key);
  }
});

/** Parse a field list, or throw with every problem in one message. */
export function parseFields(value: unknown): FieldDef[] {
  const result = fieldListSchema.safeParse(value);
  if (!result.success) throw new RecordValidationError(result.error.issues.map((i) => i.message));
  return result.data;
}

export class RecordValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'RecordValidationError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+0-9 ()/.-]{3,40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_TEXT = 2_000;
const MAX_TEXTAREA = 20_000;

/** One value checked against its field; returns the stored form or a problem. */
function checkValue(field: FieldDef, raw: unknown): { value: RecordValue } | { problem: string } {
  const bad = (what: string) => ({ problem: `${field.label}: ${what}` });
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') return bad('must be text');
      const max = field.type === 'text' ? MAX_TEXT : MAX_TEXTAREA;
      if (raw.length > max) return bad(`at most ${max} characters`);
      return { value: raw.trim() };
    }
    case 'email':
      if (typeof raw !== 'string' || !EMAIL_RE.test(raw.trim()) || raw.length > 320) return bad('must be an email address');
      return { value: raw.trim() };
    case 'phone':
      if (typeof raw !== 'string' || !PHONE_RE.test(raw.trim())) return bad('must be a phone number');
      return { value: raw.trim() };
    case 'url': {
      if (typeof raw !== 'string' || raw.length > 2_000) return bad('must be a web address');
      try {
        const url = new URL(raw.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('must start with http:// or https://');
      } catch {
        return bad('must be a web address');
      }
      return { value: raw.trim() };
    }
    case 'number':
    case 'money': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim().replace(',', '.')) : Number.NaN;
      if (!Number.isFinite(n)) return bad('must be a number');
      return { value: field.type === 'money' ? Math.round(n * 100) / 100 : n };
    }
    case 'date': {
      const m = typeof raw === 'string' ? DATE_RE.exec(raw.trim()) : null;
      if (!m) return bad('must be a date (YYYY-MM-DD)');
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return bad('is not a real date');
      return { value: (raw as string).trim() };
    }
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
      return bad('must be yes or no');
    case 'select':
      if (typeof raw !== 'string' || !field.options?.includes(raw)) return bad(`must be one of: ${field.options?.join(', ')}`);
      return { value: raw };
  }
}

/** An empty input: absent, null, or a blank string. */
function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * Check `input` against `fields` and return the data to store. Unknown keys
 * are refused (a typo must not vanish silently); `null` or a blank string
 * leaves a field empty; a required field must hold a value. An update
 * passes the stored values merged with the change, so they are checked
 * against the type's current fields too.
 */
export function validateRecordData(fields: readonly FieldDef[], input: unknown): RecordData {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RecordValidationError(['Record data must be an object']);
  const problems: string[] = [];
  const known = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(input)) if (!known.has(key)) problems.push(`Unknown field "${key}"`);
  const out: RecordData = {};
  const given = input as Record<string, unknown>;
  // Own keys only: a field named `constructor` must not find Object's.
  for (const field of fields) {
    if (!Object.hasOwn(given, field.key)) continue;
    const raw = given[field.key];
    if (isBlank(raw)) {
      delete out[field.key];
      continue;
    }
    const checked = checkValue(field, raw);
    if ('problem' in checked) problems.push(checked.problem);
    else out[field.key] = checked.value;
  }
  for (const field of fields) {
    if (field.required && !Object.hasOwn(out, field.key)) problems.push(`${field.label}: required`);
  }
  if (problems.length > 0) throw new RecordValidationError(problems);
  return out;
}

/** The title a record shows under: the type's title field, else its first filled text field. */
export function recordTitle(fields: readonly FieldDef[], data: RecordData, titleField: string | null): string | null {
  const pick = (key: string) => {
    const v = data[key];
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
  };
  if (titleField) {
    const v = pick(titleField);
    if (v) return v;
  }
  for (const f of fields) {
    if (f.type !== 'text') continue;
    const v = pick(f.key);
    if (v) return v;
  }
  return null;
}
