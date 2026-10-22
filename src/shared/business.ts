/**
 * The JSON shapes of cases, contacts, record types, records and form links
 * as the API returns them (docs/CASES.md, docs/RECORDS.md). Dependency-free
 * so `web/` imports it as is; `business.types.test.ts` checks them against
 * the server's schema types, so the two cannot drift.
 */
import type { FieldDef, RecordData } from './record-fields';

export const CASE_STATUS_VALUES = ['open', 'waiting', 'done', 'archived'] as const;
export type CaseStatusValue = (typeof CASE_STATUS_VALUES)[number];
export const CASE_ENTITY_VALUES = ['contact', 'document', 'task', 'note', 'artifact', 'record'] as const;
export type CaseEntityValue = (typeof CASE_ENTITY_VALUES)[number];

export interface CaseView {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  kind: string | null;
  status: string;
  summary: string | null;
  assigneeUserId: string | null;
  source: string;
  externalKey: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseLinkView {
  id: string;
  entityType: CaseEntityValue;
  entityId: string;
  role: string | null;
  createdAt: string;
  label: string;
  detail: string | null;
}

export interface CaseDetailView extends CaseView {
  links: CaseLinkView[];
}

export interface ContactAddressView {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

export interface ContactView {
  id: string;
  userId: string;
  workspaceId: string | null;
  kind: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: ContactAddressView | null;
  organizationId: string | null;
  tags: string[];
  notes: string | null;
  attributes: Record<string, string>;
  externalKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A case as the contact and record reads list it, with the link's role. */
export type LinkedCaseView = CaseView & { role: string | null };

export interface ContactDetailView extends ContactView {
  cases: LinkedCaseView[];
}

export interface RecordTypeView {
  id: string;
  userId: string;
  workspaceId: string | null;
  key: string;
  name: string;
  description: string | null;
  fields: FieldDef[];
  titleField: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordView {
  id: string;
  userId: string;
  workspaceId: string | null;
  typeId: string;
  title: string | null;
  data: RecordData;
  source: string;
  externalKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordDetailView extends RecordView {
  cases: LinkedCaseView[];
}

export interface FormLinkView {
  id: string;
  recordTypeId: string;
  createdByUserId: string;
  title: string;
  intro: string | null;
  caseKind: string | null;
  expiresAt: string | null;
  maxSubmissions: number | null;
  submissionCount: number;
  revokedAt: string | null;
  createdAt: string;
}

/** `POST /api/record-types/:id/form-links`: the raw token is in this response only. */
export interface MintedFormLinkView extends FormLinkView {
  token: string;
  path: string;
}

/** `GET /api/forms/:token`. */
export interface PublicFormView {
  title: string;
  intro: string | null;
  fields: FieldDef[];
}
