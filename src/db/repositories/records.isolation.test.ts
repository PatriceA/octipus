/**
 * Record types, records and form links (docs/RECORDS.md) through
 * `contentRepos`, and public form submissions: personal rows stay their
 * owner's, space rows follow the member's role, a guest reaches none, a
 * record's type is always of its scope, and a form link writes as its
 * creator only while they may still write.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ContentRepos } from '@/db/repositories/content';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';
const dave = '44444444-4444-4444-8444-444444444444';

let spaceId: string;
let personal: (userId: string) => Promise<ContentRepos>;
let inSpace: (userId: string, space?: string) => Promise<ContentRepos>;

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'start', label: 'Start date', type: 'date' },
];

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-records-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${alice}', 'alice', false), ('${bob}', 'bob', false), ('${carol}', 'carol', false), ('${dave}', 'dave', false)
     ON CONFLICT DO NOTHING`,
  );
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(alice, [[bob, 'editor'], [carol, 'viewer'], [dave, 'guest']]);
  const { contentRepos } = await import('@/db/repositories/content');
  personal = async (userId) => contentRepos(await resolvedPrincipal(userId, null));
  inSpace = async (userId, space = spaceId) => contentRepos(await resolvedPrincipal(userId, space));
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('record types and records', () => {
  test('personal types and records stay their owner\'s', async () => {
    const a = await personal(alice);
    const b = await personal(bob);
    const type = await a.recordTypes.create({ key: 'applicant', name: 'Applicant', fields: FIELDS, titleField: 'name' });
    const record = await a.records.create('applicant', { data: { name: 'Jana', email: 'jana@example.com' } });
    expect(record.title).toBe('Jana');
    expect(await b.recordTypes.findById(type.id)).toBeNull();
    expect(await b.recordTypes.findByKey('applicant')).toBeNull();
    expect(await b.records.findById(record.id)).toBeNull();
    expect(await b.records.update(record.id, { name: 'x' })).toBeNull();
    expect(await b.records.delete(record.id)).toBeNull();
    // Bob cannot write a record of alice's type: the type is not in his scope.
    await expect(b.records.create(type.id, { data: { name: 'x', email: 'x@y.de' } })).rejects.toThrow(/Record type not found/);
  });

  test('keys are unique per scope; a title field must be a text field', async () => {
    const a = await personal(alice);
    await a.recordTypes.create({ key: 'vehicle', name: 'Vehicle', fields: [{ key: 'plate', label: 'Plate', type: 'text' }] });
    await expect(a.recordTypes.create({ key: 'vehicle', name: 'Again', fields: [] })).rejects.toThrow(/already exists/);
    await expect(a.recordTypes.create({ key: 'car', name: 'Car', fields: [{ key: 'km', label: 'km', type: 'number' }], titleField: 'km' }))
      .rejects.toThrow(/not a text field/);
    // Another user's scope has its own keys.
    expect((await (await personal(bob)).recordTypes.create({ key: 'vehicle', name: 'Bob vehicle', fields: [] })).key).toBe('vehicle');
  });

  test('a type in use cannot be deleted; removed fields drop on the next write', async () => {
    const a = await personal(alice);
    const type = await a.recordTypes.create({
      key: 'licence', name: 'Licence',
      fields: [{ key: 'product', label: 'Product', type: 'text' }, { key: 'seats', label: 'Seats', type: 'number' }],
    });
    const r = await a.records.create(type.id, { data: { product: 'Office', seats: 5 } });
    await expect(a.recordTypes.delete(type.id)).rejects.toThrow(/still has 1 record/);
    await a.recordTypes.update(type.id, { fields: [{ key: 'product', label: 'Product', type: 'text' }] });
    expect((await a.records.findById(r.id))?.data).toEqual({ product: 'Office', seats: 5 });
    expect((await a.records.update(r.id, { product: 'Office 365' }))?.data).toEqual({ product: 'Office 365' });
    await a.records.delete(r.id);
    expect((await a.recordTypes.delete(type.id))?.id).toBe(type.id);
  });

  test('stored values are checked again after the type changed', async () => {
    const a = await personal(alice);
    const type = await a.recordTypes.create({
      key: 'order', name: 'Order',
      fields: [{ key: 'no', label: 'No', type: 'text' }, { key: 'state', label: 'State', type: 'select', options: ['new', 'sent'] }],
    });
    const r = await a.records.create(type.id, { data: { no: '1', state: 'sent' } });
    await a.recordTypes.update(type.id, { fields: [{ key: 'no', label: 'No', type: 'text' }, { key: 'state', label: 'State', type: 'select', options: ['new', 'done'] }] });
    await expect(a.records.update(r.id, { no: '2' })).rejects.toThrow(/State: must be one of: new, done/);
    expect((await a.records.update(r.id, { no: '2', state: 'done' }))?.data).toEqual({ no: '2', state: 'done' });
  });

  test("an admin's personal scope does not reach another user's types or records", async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const a = await personal(alice);
    const type = await a.recordTypes.create({ key: 'secret_type', name: 'Secret', fields: [{ key: 'x', label: 'X', type: 'text' }] });
    const r = await a.records.create(type.id, { data: { x: '1' } });
    const admin = contentRepos(await resolvedPrincipal(dave, null, { isAdmin: true }));
    expect(await admin.recordTypes.findById(type.id)).toBeNull();
    expect(await admin.records.findById(r.id)).toBeNull();
    await expect(admin.records.create(type.id, { data: { x: '2' } })).rejects.toThrow(/Record type not found/);
  });

  test('createOnce is idempotent by external key', async () => {
    const a = await personal(alice);
    await a.recordTypes.create({ key: 'booking', name: 'Booking', fields: [{ key: 'ref', label: 'Ref', type: 'text' }] });
    const first = await a.records.createOnce('booking', { data: { ref: '1' }, externalKey: 'datev:9' });
    const again = await a.records.createOnce('booking', { data: { ref: '1' }, externalKey: 'datev:9' });
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.record.id).toBe(first.record.id);
    await a.recordTypes.create({ key: 'other', name: 'Other', fields: [{ key: 'ref', label: 'Ref', type: 'text' }] });
    await expect(a.records.createOnce('other', { data: { ref: '1' }, externalKey: 'datev:9' })).rejects.toThrow(/another type/);
  });

  test('in a space: members read, editors write, viewers do not, guests see nothing', async () => {
    const editor = await inSpace(bob);
    const type = await editor.recordTypes.create({ key: 'complaint_form', name: 'Complaint', fields: FIELDS });
    const record = await editor.records.create(type.id, { data: { name: 'Herr M.', email: 'm@example.com' } });
    const viewer = await inSpace(carol);
    const guest = await inSpace(dave);
    expect((await viewer.records.findById(record.id))?.id).toBe(record.id);
    await expect(viewer.records.create(type.id, { data: { name: 'x', email: 'x@y.de' } })).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(viewer.recordTypes.update(type.id, { name: 'x' })).rejects.toMatchObject({ code: 'forbidden_role' });
    expect(await guest.recordTypes.list()).toEqual([]);
    expect(await guest.records.findById(record.id)).toBeNull();
    expect(await (await personal(bob)).records.findById(record.id)).toBeNull();
  });

  test('records link to cases and their links go when they are deleted', async () => {
    const { linkToCase, caseLinks } = await import('@/core/cases/links');
    const a = await personal(alice);
    await a.recordTypes.create({ key: 'invoice', name: 'Invoice', fields: [{ key: 'no', label: 'No', type: 'text' }] });
    const r = await a.records.create('invoice', { data: { no: 'R-77' } });
    const c = await a.cases.create({ title: 'Pay R-77' });
    const link = await linkToCase(a, c.id, { entityType: 'record', entityId: r.id, role: 'invoice' });
    expect([link?.label, link?.detail]).toEqual(['R-77', 'invoice']);
    expect((await a.cases.casesLinkedTo('record', r.id)).map((x) => x.case.id)).toEqual([c.id]);
    await a.records.delete(r.id);
    expect(await caseLinks(a, c.id)).toEqual([]);
  });
});

describe('form links and public submissions', () => {
  test('a submission writes a record (and a case) as the creator; the token is shown once', async () => {
    const { publicForm, submitForm } = await import('@/core/records/forms');
    const editor = await inSpace(bob);
    const type = await editor.recordTypes.create({ key: 'application', name: 'Application', fields: FIELDS, titleField: 'name' });
    const minted = await editor.formLinks.create(type.id, { title: 'Apply now', caseKind: 'recruiting' });
    expect(minted?.token).toBeTruthy();
    expect(JSON.stringify(await editor.formLinks.list(type.id))).not.toContain(minted!.token);

    const form = await publicForm(minted!.token);
    expect(form).toEqual({ title: 'Apply now', intro: null, fields: type.fields });
    const result = await submitForm(minted!.token, { name: 'Pia', email: 'pia@example.com' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = await editor.records.findById(result.recordId);
    expect([record?.source, record?.userId, record?.workspaceId]).toEqual(['form', bob, spaceId]);
    const opened = await editor.cases.findById(result.caseId as string);
    expect([opened?.kind, opened?.source]).toEqual(['recruiting', 'form']);
    expect((await editor.cases.casesLinkedTo('record', result.recordId)).map((l) => l.role)).toEqual(['submission']);
  });

  test('bad data is refused and does not use up the link', async () => {
    const { submitForm } = await import('@/core/records/forms');
    const { RecordValidationError } = await import('@/core/records/fields');
    const editor = await inSpace(bob);
    const type = await editor.recordTypes.create({ key: 'callback', name: 'Callback', fields: FIELDS });
    const minted = await editor.formLinks.create(type.id, { title: 'Call me', maxSubmissions: 1 });
    await expect(submitForm(minted!.token, { name: 'x' })).rejects.toBeInstanceOf(RecordValidationError);
    expect((await submitForm(minted!.token, { name: 'Kai', email: 'kai@example.com' })).ok).toBe(true);
    // Full now.
    expect(await submitForm(minted!.token, { name: 'Lea', email: 'lea@example.com' })).toEqual({ ok: false, reason: 'gone' });
  });

  test('revoked, expired, unknown and orphaned links are gone', async () => {
    const { publicForm, submitForm } = await import('@/core/records/forms');
    const { spaceWith } = await import('@/test-helpers/space-fixtures');
    const s = await spaceWith(alice, [[bob, 'editor']]);
    const editor = await inSpace(bob, s);
    const type = await editor.recordTypes.create({ key: 'request', name: 'Request', fields: FIELDS });
    const revoked = await editor.formLinks.create(type.id, { title: 'Revoked' });
    expect(await editor.formLinks.revoke(type.id, revoked!.link.id)).toBe(true);
    expect(await publicForm(revoked!.token)).toBeNull();
    expect(await submitForm(revoked!.token, { name: 'x', email: 'x@y.de' })).toEqual({ ok: false, reason: 'gone' });
    expect(await publicForm('not-a-real-token-at-all-000000')).toBeNull();
    await expect(editor.formLinks.create(type.id, { title: 'Past', expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/future/);

    // The creator is demoted to viewer: the link stops working.
    const live = await editor.formLinks.create(type.id, { title: 'Live' });
    expect(await publicForm(live!.token)).not.toBeNull();
    const { setRole } = await import('@/core/spaces/service');
    await setRole({ userId: alice }, s, bob, { role: 'viewer' });
    expect(await publicForm(live!.token)).toBeNull();
    expect(await submitForm(live!.token, { name: 'x', email: 'x@y.de' })).toEqual({ ok: false, reason: 'gone' });
  });

  test("a personal type's form writes as the type's owner", async () => {
    const { submitForm } = await import('@/core/records/forms');
    const a = await personal(alice);
    const type = await a.recordTypes.create({ key: 'wish', name: 'Wish', fields: FIELDS });
    const minted = await a.formLinks.create(type.id, { title: 'Your wish' });
    const result = await submitForm(minted!.token, { name: 'Oma', email: 'oma@example.com' });
    expect(result.ok).toBe(true);
    if (result.ok) expect((await a.records.findById(result.recordId))?.userId).toBe(alice);
  });

  test('a viewer cannot mint a form link; another user cannot list or revoke one', async () => {
    const editor = await inSpace(bob);
    const type = await editor.recordTypes.create({ key: 'survey', name: 'Survey', fields: FIELDS });
    const minted = await editor.formLinks.create(type.id, { title: 'Survey' });
    await expect((await inSpace(carol)).formLinks.create(type.id, { title: 'no' })).rejects.toMatchObject({ code: 'forbidden_role' });
    expect(await (await personal(bob)).formLinks.list(type.id)).toBeNull();
    expect(await (await personal(bob)).formLinks.revoke(type.id, minted!.link.id)).toBe(false);
  });
});
