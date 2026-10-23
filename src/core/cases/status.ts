/**
 * The fixed vocabularies of cases and contacts (docs/CASES.md). Kinds, link
 * roles and contact tags are free text; these are not.
 */

import { CASE_ENTITY_VALUES, CASE_STATUS_VALUES, type CaseEntityValue, type CaseStatusValue } from '@/shared/business';

/** A case is open (being worked), waiting (on someone outside), done, or archived. */
export const CASE_STATUSES = CASE_STATUS_VALUES;
export type CaseStatus = CaseStatusValue;

/** The statuses a case is still active in; leaving them stamps `closedAt`. */
export const ACTIVE_CASE_STATUSES: readonly CaseStatus[] = ['open', 'waiting'];

export function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === 'string' && (CASE_STATUSES as readonly string[]).includes(value);
}

/** What a case can link to: the shared entities of a scope. */
export const CASE_ENTITY_TYPES = CASE_ENTITY_VALUES;
export type CaseEntityType = CaseEntityValue;

export function isCaseEntityType(value: unknown): value is CaseEntityType {
  return typeof value === 'string' && (CASE_ENTITY_TYPES as readonly string[]).includes(value);
}

export const CONTACT_KINDS = ['person', 'organization'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export function isContactKind(value: unknown): value is ContactKind {
  return typeof value === 'string' && (CONTACT_KINDS as readonly string[]).includes(value);
}

/**
 * The `closedAt` a status change implies: stamped when a case leaves the
 * active statuses, cleared when it comes back, untouched otherwise.
 */
export function closedAtPatch(next: string | undefined, wasClosed: boolean): { closedAt?: Date | null } {
  if (next === undefined) return {};
  const active = (ACTIVE_CASE_STATUSES as readonly string[]).includes(next);
  if (!active && !wasClosed) return { closedAt: new Date() };
  if (active && wasClosed) return { closedAt: null };
  return {};
}

/** A free-text label (kind, role, tag): trimmed, bounded, empty → null. */
export function normalizeLabel(value: unknown, max = 100): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v.slice(0, max);
}

/** Tags: trimmed, lower-cased, de-duplicated, bounded. */
export function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const tags = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase().slice(0, 50))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, 20);
}
