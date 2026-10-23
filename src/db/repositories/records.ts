/**
 * Record types, records and form links through one `RepoScope`
 * (docs/RECORDS.md), the way `CaseRepo` reaches cases: reads use the scope's
 * filter, writes stamp the scope's author and workspace and check its `can`.
 * A guest reaches none of them. A record's type is always a type of the same
 * scope, and every write of a record is validated against the type's current
 * fields (core/records/fields.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, ilike, isNull, type SQL, sql } from 'drizzle-orm';
import { parseFields, type RecordData, RecordValidationError, recordTitle, validateRecordData, KEY_RE } from '@/core/records/fields';
import { isProtectionLevel } from '@/shared/protection';
import { getDb } from '../postgres';
import { caseLinks } from '../schema/cases';
import { type FormLink, formLinks, type NewRecordRow, type RecordRow, type RecordType, recordTypes, records } from '../schema/records';
import { isUuid, type RepoScope } from './scoped';

/** `%` and `_` in a search term match themselves, not any character. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function stampRow(scope: RepoScope): Promise<{ userId: string; workspaceId: string | null }> {
  return { userId: scope.stamp().userId, workspaceId: await scope.writeWorkspace() };
}

/** sha256 of a form token, as stored. */
export function hashFormToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────
// Record types
// ─────────────────────────────────────────────────────────────────────

export interface RecordTypeInput {
  key: string;
  name: string;
  description?: string | null;
  fields: unknown;
  titleField?: string | null;
  /** The level new records of the type start at (docs/PROTECTION-LEVELS.md); null: unclear. */
  defaultProtectionLevel?: number | null;
}

export class RecordTypeRepo {
  constructor(private readonly scope: RepoScope) {}

  private get db() { return getDb(); }

  private rows(): SQL[] {
    return this.scope.shared(recordTypes);
  }

  /**
   * A type of this scope. No admin by-id bypass: a record's type must be of
   * the record's scope, and a form writes as its creator in the type's scope.
   */
  async findById(id: string): Promise<RecordType | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(recordTypes).where(and(eq(recordTypes.id, id), ...this.rows())).limit(1);
    return row ?? null;
  }

  async findByKey(key: string): Promise<RecordType | null> {
    const [row] = await this.db.select().from(recordTypes).where(and(eq(recordTypes.key, key), ...this.rows())).limit(1);
    return row ?? null;
  }

  /** A type by id or key. */
  async resolve(idOrKey: string): Promise<RecordType | null> {
    return isUuid(idOrKey) ? this.findById(idOrKey) : this.findByKey(idOrKey);
  }

  async list(): Promise<RecordType[]> {
    return this.db.select().from(recordTypes).where(and(...this.rows())).orderBy(recordTypes.name).limit(500);
  }

  /** The type's checked shape: key, fields, and a title field that names a text field. */
  private shape(input: Partial<RecordTypeInput>, current?: RecordType) {
    const problems: string[] = [];
    const key = input.key !== undefined ? input.key.trim() : current?.key;
    if (!key || !KEY_RE.test(key)) problems.push('A type key is lower-case letters, digits and _, starting with a letter (at most 50)');
    const name = input.name !== undefined ? input.name.trim() : current?.name;
    if (!name) problems.push('A type needs a name');
    const fields = input.fields !== undefined ? parseFields(input.fields) : current?.fields ?? [];
    const titleField = input.titleField !== undefined ? input.titleField || null : current?.titleField ?? null;
    if (titleField && !fields.some((f) => f.key === titleField && f.type === 'text')) problems.push(`titleField "${titleField}" is not a text field of this type`);
    if (problems.length > 0) throw new RecordValidationError(problems);
    const defaultProtectionLevel = input.defaultProtectionLevel !== undefined ? input.defaultProtectionLevel : current?.defaultProtectionLevel ?? null;
    if (defaultProtectionLevel !== null && !isProtectionLevel(defaultProtectionLevel)) problems.push('defaultProtectionLevel is 1, 2, 3 or 4');
    if (problems.length > 0) throw new RecordValidationError(problems);
    return { key: key as string, name: (name as string).slice(0, 200), fields, titleField, defaultProtectionLevel };
  }

  async create(input: RecordTypeInput): Promise<RecordType> {
    this.scope.can('write');
    const shape = this.shape(input);
    if (await this.findByKey(shape.key)) throw new RecordValidationError([`A record type "${shape.key}" already exists here`]);
    const [row] = await this.db
      .insert(recordTypes)
      .values({ ...shape, description: input.description ?? null, ...(await stampRow(this.scope)) })
      .returning();
    return row;
  }

  /**
   * Change a type. Records keep their stored data: a removed field's values
   * stay in old records (and are dropped on their next write), a new required
   * field is enforced from the next write of each record on.
   */
  async update(id: string, patch: Partial<RecordTypeInput>): Promise<RecordType | null> {
    this.scope.can('write');
    const current = await this.findById(id);
    if (!current) return null;
    const shape = this.shape(patch, current);
    if (shape.key !== current.key && (await this.findByKey(shape.key))) {
      throw new RecordValidationError([`A record type "${shape.key}" already exists here`]);
    }
    const [row] = await this.db
      .update(recordTypes)
      .set({ ...shape, ...(patch.description !== undefined ? { description: patch.description } : {}), updatedAt: new Date() })
      .where(and(eq(recordTypes.id, id), ...this.rows()))
      .returning();
    return row ?? null;
  }

  /** Delete a type without records; a type in use is refused. */
  async delete(id: string): Promise<RecordType | null> {
    this.scope.can('write');
    const current = await this.findById(id);
    if (!current) return null;
    const [used] = await this.db.select({ n: count() }).from(records).where(eq(records.typeId, id));
    if ((used?.n ?? 0) > 0) throw new RecordValidationError([`"${current.name}" still has ${used.n} record(s); delete them first`]);
    const [row] = await this.db.delete(recordTypes).where(and(eq(recordTypes.id, id), ...this.rows())).returning();
    return row ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Records
// ─────────────────────────────────────────────────────────────────────

export interface RecordListFilter {
  typeId?: string;
  /** Matches the title. */
  q?: string;
  limit?: number;
}

export interface RecordInput {
  data: unknown;
  source?: string;
  sourceRef?: NewRecordRow['sourceRef'];
  externalKey?: string | null;
  /** The record's level; absent: the type's default, copied now (a later change of the default does not reach it). Null: unclear. */
  protectionLevel?: number | null;
}

export class RecordRepo {
  constructor(private readonly scope: RepoScope, private readonly types: RecordTypeRepo) {}

  private get db() { return getDb(); }

  /** The scope's records; no admin by-id bypass, like the types they belong to. */
  private rows(): SQL[] {
    return this.scope.shared(records);
  }

  async findById(id: string): Promise<RecordRow | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(records).where(and(eq(records.id, id), ...this.rows())).limit(1);
    return row ?? null;
  }

  /** Set a record's protection level (null: unclear, 4). `onlyRaise`: see `CaseRepo.setProtectionLevel`. */
  async setProtectionLevel(id: string, level: number | null, onlyRaise = false): Promise<RecordRow | null> {
    this.scope.can('write');
    if (!isUuid(id)) return null;
    const [row] = await this.db.update(records).set({ protectionLevel: level, updatedAt: new Date() })
      .where(and(eq(records.id, id), ...this.rows(), ...(onlyRaise && level !== null ? [sql`coalesce(${records.protectionLevel}, 4) <= ${level}`] : []))).returning();
    return row ?? null;
  }

  async list(filter: RecordListFilter = {}): Promise<RecordRow[]> {
    const filters: SQL[] = [...this.rows()];
    if (filter.typeId) {
      if (!isUuid(filter.typeId)) return [];
      filters.push(eq(records.typeId, filter.typeId));
    }
    const q = filter.q?.trim();
    if (q) filters.push(ilike(records.title, likePattern(q)));
    return this.db
      .select()
      .from(records)
      .where(and(...filters))
      .orderBy(desc(records.updatedAt))
      .limit(Math.max(1, Math.min(500, filter.limit ?? 200)));
  }

  /** The type of a write: one of this scope, or a clear error. */
  private async typeOf(typeIdOrKey: string): Promise<RecordType> {
    const type = await this.types.resolve(typeIdOrKey);
    if (!type) throw new RecordValidationError([`Record type not found: ${typeIdOrKey}`]);
    return type;
  }

  private values(type: RecordType, data: RecordData) {
    return { data, title: recordTitle(type.fields, data, type.titleField) };
  }

  async create(typeIdOrKey: string, input: RecordInput): Promise<RecordRow> {
    this.scope.can('write');
    const type = await this.typeOf(typeIdOrKey);
    const data = validateRecordData(type.fields, input.data);
    const [row] = await this.db
      .insert(records)
      .values({
        typeId: type.id,
        ...this.values(type, data),
        source: input.source ?? 'user',
        sourceRef: input.sourceRef,
        externalKey: input.externalKey ?? null,
        protectionLevel: input.protectionLevel !== undefined ? input.protectionLevel : type.defaultProtectionLevel,
        ...(await stampRow(this.scope)),
      })
      .returning();
    return row;
  }

  /** Create unless the scope already has a record with `externalKey`; `created` says which. */
  async createOnce(typeIdOrKey: string, input: RecordInput & { externalKey: string }): Promise<{ record: RecordRow; created: boolean }> {
    this.scope.can('write');
    const type = await this.typeOf(typeIdOrKey);
    const data = validateRecordData(type.fields, input.data);
    const [created] = await this.db
      .insert(records)
      .values({
        typeId: type.id,
        ...this.values(type, data),
        source: input.source ?? 'user',
        sourceRef: input.sourceRef,
        externalKey: input.externalKey,
        protectionLevel: input.protectionLevel !== undefined ? input.protectionLevel : type.defaultProtectionLevel,
        ...(await stampRow(this.scope)),
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { record: created, created: true };
    const [existing] = await this.db.select().from(records).where(and(eq(records.externalKey, input.externalKey), ...this.rows())).limit(1);
    if (!existing) throw new Error('A record with this external key exists outside this scope');
    if (existing.typeId !== type.id) {
      throw new RecordValidationError([`The external key "${input.externalKey}" already belongs to a record of another type`]);
    }
    return { record: existing, created: false };
  }

  /**
   * Change a record's data: absent fields keep their value, `null` or an
   * empty string clears one. Values of fields the type no longer has are
   * dropped; the rest are validated again with the change.
   */
  async update(id: string, data: unknown): Promise<RecordRow | null> {
    this.scope.can('write');
    const current = await this.findById(id);
    if (!current) return null;
    const type = await this.typeOf(current.typeId);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new RecordValidationError(['Record data must be an object']);
    // The stored values are checked again with the change: a field whose
    // type changed (text → money, an option removed) must be fixed, not
    // written back unchecked. Values of removed fields are dropped.
    const keys = new Set(type.fields.map((f) => f.key));
    const kept = Object.fromEntries(Object.entries(current.data).filter(([k]) => keys.has(k)));
    const merged = validateRecordData(type.fields, { ...kept, ...(data as Record<string, unknown>) });
    const [row] = await this.db
      .update(records)
      .set({ ...this.values(type, merged), updatedAt: new Date() })
      .where(and(eq(records.id, id), ...this.rows()))
      .returning();
    return row ?? null;
  }

  /** Delete a record the scope reaches; the links of cases to it go with it. */
  async delete(id: string): Promise<RecordRow | null> {
    if (!isUuid(id)) return null;
    this.scope.can('write');
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(records).where(and(eq(records.id, id), ...this.rows())).returning();
      if (!row) return null;
      await tx.delete(caseLinks).where(and(eq(caseLinks.entityType, 'record'), eq(caseLinks.entityId, id)));
      return row;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Form links
// ─────────────────────────────────────────────────────────────────────

export interface FormLinkInput {
  title: string;
  intro?: string | null;
  caseKind?: string | null;
  expiresAt?: Date | null;
  maxSubmissions?: number | null;
}

/** A form link as its owners see it: never the token or its hash. */
export type FormLinkView = Omit<FormLink, 'tokenHash'>;

function view(link: FormLink): FormLinkView {
  const { tokenHash: _hash, ...rest } = link;
  void _hash;
  return rest;
}

/**
 * The form links of a scope's record types. Minting and revoking a link is a
 * write; the raw token is returned once, by `create`.
 */
export class FormLinkRepo {
  constructor(private readonly scope: RepoScope, private readonly types: RecordTypeRepo) {}

  private get db() { return getDb(); }

  async list(recordTypeId: string): Promise<FormLinkView[] | null> {
    if (!(await this.types.findById(recordTypeId))) return null;
    const rows = await this.db.select().from(formLinks).where(eq(formLinks.recordTypeId, recordTypeId)).orderBy(desc(formLinks.createdAt));
    return rows.map(view);
  }

  async create(recordTypeId: string, input: FormLinkInput): Promise<{ link: FormLinkView; token: string } | null> {
    this.scope.can('write');
    if (!(await this.types.findById(recordTypeId))) return null;
    if (input.maxSubmissions != null && (!Number.isInteger(input.maxSubmissions) || input.maxSubmissions < 1)) {
      throw new RecordValidationError(['maxSubmissions must be a whole number of at least 1']);
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new RecordValidationError(['expiresAt must be in the future']);
    const token = randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(formLinks)
      .values({
        recordTypeId,
        tokenHash: hashFormToken(token),
        createdByUserId: this.scope.stamp().userId,
        title: input.title,
        intro: input.intro ?? null,
        caseKind: input.caseKind ?? null,
        expiresAt: input.expiresAt ?? null,
        maxSubmissions: input.maxSubmissions ?? null,
      })
      .returning();
    return { link: view(row), token };
  }

  /** Revoke a link of a type the scope reaches; immediate for every later submission. */
  async revoke(recordTypeId: string, linkId: string): Promise<boolean> {
    this.scope.can('write');
    if (!isUuid(linkId) || !(await this.types.findById(recordTypeId))) return false;
    const revoked = await this.db
      .update(formLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(formLinks.id, linkId), eq(formLinks.recordTypeId, recordTypeId), isNull(formLinks.revokedAt)))
      .returning();
    return revoked.length > 0;
  }
}

/**
 * A live form link by its raw token, for the public form routes: not
 * revoked, not expired, not full. No scope: the token is the credential, and
 * the submission then runs as the link's creator (core/records/forms.ts).
 */
export async function findLiveFormLink(token: string): Promise<(FormLink & { type: RecordType }) | null> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 100) return null;
  const [row] = await getDb()
    .select({ link: formLinks, type: recordTypes })
    .from(formLinks)
    .innerJoin(recordTypes, eq(recordTypes.id, formLinks.recordTypeId))
    .where(and(
      eq(formLinks.tokenHash, hashFormToken(token)),
      isNull(formLinks.revokedAt),
      sql`(${formLinks.expiresAt} IS NULL OR ${formLinks.expiresAt} > now())`,
      sql`(${formLinks.maxSubmissions} IS NULL OR ${formLinks.submissionCount} < ${formLinks.maxSubmissions})`,
    ))
    .limit(1);
  return row ? { ...row.link, type: row.type } : null;
}

/**
 * Count one submission against a link, atomically: false when the link
 * filled up, was revoked or expired since it was read.
 */
export async function claimFormSubmission(linkId: string): Promise<boolean> {
  const claimed = await getDb()
    .update(formLinks)
    .set({ submissionCount: sql`${formLinks.submissionCount} + 1` })
    .where(and(
      eq(formLinks.id, linkId),
      isNull(formLinks.revokedAt),
      sql`(${formLinks.expiresAt} IS NULL OR ${formLinks.expiresAt} > now())`,
      sql`(${formLinks.maxSubmissions} IS NULL OR ${formLinks.submissionCount} < ${formLinks.maxSubmissions})`,
    ))
    .returning({ id: formLinks.id });
  return claimed.length > 0;
}

/** Give back a claimed submission whose write failed. */
export async function releaseFormSubmission(linkId: string): Promise<void> {
  await getDb()
    .update(formLinks)
    .set({ submissionCount: sql`greatest(${formLinks.submissionCount} - 1, 0)` })
    .where(eq(formLinks.id, linkId));
}
