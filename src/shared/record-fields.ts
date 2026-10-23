/**
 * The vocabulary of record type fields (docs/RECORDS.md). Dependency-free so
 * `web/` imports the same definitions the server validates against
 * (core/records/fields.ts).
 */

export const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'boolean', 'select', 'email', 'phone', 'url'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Machine key of a field or a record type: lower-case, starts with a letter. */
export const KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;

export const MAX_FIELDS = 50;

/** One field of a record type. */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** The choices of a `select` field. */
  options?: string[];
  /** Shown under the field in a form. */
  help?: string;
}

export type RecordValue = string | number | boolean;
export type RecordData = Record<string, RecordValue>;
