/**
 * Meetings as notes, with an edge to everyone who was there.
 *
 * The behaviours worth pinning down are the ones that decide whether a
 * meeting record can be trusted six months later: re-saving must update the
 * same note rather than accumulate copies, an attendee with no profile must
 * leave a ghost edge that binds when the profile appears, and a partial name
 * must NOT bind — inventing an edge to the wrong person is worse than leaving
 * one unresolved.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { attendeeName, meetingSlug, renderMeetingNote } from './meetings';

const userId = '33333333-3333-3333-3333-333333333333';
let links: KnowledgeLinkRepository;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-meetings-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'meetings-user' }]);

  // Same seam as notes.test.ts: stub the embedding calls at the singleton the
  // note service reaches for, so indexing degrades locally instead of talking
  // to whatever proxy the environment has configured.
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  const service = getEmbeddingService();
  const noModel = new Error('No embedding model configured (test)');
  vi.spyOn(service, 'generateEmbedding').mockRejectedValue(noModel);
  vi.spyOn(service, 'embedBatch').mockImplementation(async (texts: string[]) => texts.map(() => noModel));

  const mod = await import('@/db/repositories/knowledge-link-repository');
  links = new mod.KnowledgeLinkRepository();
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw('TRUNCATE TABLE knowledge_links');
  await executeRaw('TRUNCATE TABLE notes CASCADE');
  await executeRaw('TRUNCATE TABLE profiles CASCADE');
});

describe('pure helpers', () => {
  test('attendeeName prefers a real name over an address', () => {
    expect(attendeeName({ name: 'Ada Lovelace', email: 'ada@x.dev' })).toBe('Ada Lovelace');
    expect(attendeeName({ email: 'grace.hopper@x.dev' })).toBe('grace.hopper');
    expect(attendeeName({})).toBe('unknown');
  });

  test('meetingSlug is stable per title and day', () => {
    expect(meetingSlug('Roadmap Review', '2026-09-02T10:00:00Z'))
      .toBe(meetingSlug('Roadmap  review', '2026-09-02T16:00:00Z'));
    expect(meetingSlug('Roadmap Review', '2026-09-02T10:00:00Z'))
      .not.toBe(meetingSlug('Roadmap Review', '2026-09-03T10:00:00Z'));
  });

  test('the rendered note wikilinks the attendees', () => {
    const body = renderMeetingNote(
      { userId, title: 'Review', at: '2026-09-02T10:00:00Z', body: 'We ship Friday.' },
      ['Ada Lovelace'],
    );
    expect(body).toContain('[[Ada Lovelace]]');
    expect(body).toContain('We ship Friday.');
  });

  test('an empty meeting says so rather than looking like a lost note', () => {
    expect(renderMeetingNote({ userId, title: 'Review' }, [])).toContain('_No notes recorded._');
  });
});

describe('ingestMeeting', () => {
  test('writes a meeting note and links a known attendee to their profile', async () => {
    const { profileRepository } = await import('@/db/repositories/profile-repository');
    const ada = await profileRepository.create({
      userId, name: 'Ada Lovelace', category: 'person',
      facts: [{ key: 'email', value: 'ada@x.dev' }],
    });

    const { ingestMeeting } = await import('./meetings');
    const result = await ingestMeeting({
      userId,
      title: 'Roadmap review',
      at: '2026-09-02T10:00:00Z',
      body: 'Decision: ship Friday.',
      attendees: [{ name: 'Ada Lovelace', email: 'ada@x.dev' }],
      source: 'pasted',
    });

    expect(result.created).toBe(true);
    expect(result.slug).toBe('meeting-2026-09-02-roadmap-review');
    expect(result.attendees).toEqual([{ ref: 'ada-lovelace', name: 'Ada Lovelace', profileId: ada.id }]);

    const edges = await links.getOutgoing(userId, 'note', result.noteId);
    const attended = edges.find((e) => e.linkType === 'attended');
    expect(attended?.toType).toBe('profile');
    expect(attended?.toId).toBe(ada.id);
  });

  test('matches an attendee by email even when the name differs', async () => {
    const { profileRepository } = await import('@/db/repositories/profile-repository');
    const grace = await profileRepository.create({
      userId, name: 'Grace Hopper', category: 'person',
      facts: [{ key: 'email', value: 'Grace@X.dev' }],
    });

    const { ingestMeeting } = await import('./meetings');
    const result = await ingestMeeting({
      userId, title: 'Sync', at: '2026-09-02T10:00:00Z',
      attendees: [{ name: 'G. Hopper', email: 'grace@x.dev' }],
    });
    expect(result.attendees[0].profileId).toBe(grace.id);
  });

  test('leaves a ghost edge for someone with no profile', async () => {
    const { ingestMeeting } = await import('./meetings');
    const result = await ingestMeeting({
      userId, title: 'Intro call', at: '2026-09-02T10:00:00Z',
      attendees: [{ name: 'Alan Turing' }],
    });
    expect(result.attendees[0].profileId).toBeNull();

    const [edge] = await links.getOutgoing(userId, 'note', result.noteId);
    expect(edge.toId).toBeNull();
    expect(edge.toRef).toBe('alan-turing');
  });

  test('does not bind a partial name to a similarly named profile', async () => {
    // `findByName` does a LIKE match; using it to bind would attach a meeting
    // with "Ada" to "Ada Lovelace" on a guess. Exact only.
    const { profileRepository } = await import('@/db/repositories/profile-repository');
    await profileRepository.create({ userId, name: 'Ada Lovelace', category: 'person', facts: [] });

    const { ingestMeeting } = await import('./meetings');
    const result = await ingestMeeting({
      userId, title: 'Coffee', at: '2026-09-02T10:00:00Z', attendees: [{ name: 'Ada' }],
    });
    expect(result.attendees[0].profileId).toBeNull();
  });

  test('re-saving the same meeting updates the note instead of duplicating it', async () => {
    const { ingestMeeting } = await import('./meetings');
    const first = await ingestMeeting({
      userId, title: 'Roadmap review', at: '2026-09-02T10:00:00Z', body: 'Draft.',
    });
    const second = await ingestMeeting({
      userId, title: 'Roadmap review', at: '2026-09-02T16:00:00Z', body: 'Decision: ship Friday.',
    });

    expect(second.noteId).toBe(first.noteId);
    expect(second.created).toBe(false);

    const { getNoteRepository } = await import('@/db/repositories/note-repository');
    const note = await getNoteRepository().getById(userId, first.noteId);
    expect(note?.body).toContain('Decision: ship Friday.');
    expect(note?.noteKind).toBe('meeting');
  });

  test('a failed attendee link does not lose the meeting note', async () => {
    const { ingestMeeting } = await import('./meetings');
    const repoMod = await import('@/db/repositories/knowledge-link-repository');
    const repo = repoMod.getKnowledgeLinkRepository();
    const spy = vi.spyOn(repo, 'create').mockRejectedValue(new Error('edge write failed'));

    const result = await ingestMeeting({
      userId, title: 'Fragile', at: '2026-09-02T10:00:00Z', attendees: [{ name: 'Ada Lovelace' }],
    });
    expect(result.noteId).toBeTruthy();
    expect(result.attendees).toEqual([]);
    spy.mockRestore();
  });
});

describe('resolveAttendeeLinks', () => {
  test('binds past ghost edges when the profile is finally created', async () => {
    const { ingestMeeting, resolveAttendeeLinks } = await import('./meetings');
    const meeting = await ingestMeeting({
      userId, title: 'Intro call', at: '2026-09-02T10:00:00Z', attendees: [{ name: 'Alan Turing' }],
    });

    const { profileRepository } = await import('@/db/repositories/profile-repository');
    const alan = await profileRepository.create({ userId, name: 'Alan Turing', category: 'person', facts: [] });

    const bound = await resolveAttendeeLinks(userId, alan.id, 'Alan Turing');
    expect(bound).toBeGreaterThan(0);

    const [edge] = await links.getOutgoing(userId, 'note', meeting.noteId);
    expect(edge.toId).toBe(alan.id);
    expect(edge.toType).toBe('profile');
  });

  test('is a no-op for a name nobody attended', async () => {
    const { resolveAttendeeLinks } = await import('./meetings');
    expect(await resolveAttendeeLinks(userId, randomUUID(), 'Nobody At All')).toBe(0);
  });
});
