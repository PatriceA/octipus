/**
 * Meetings as knowledge.
 *
 * A meeting is where most of what a consultant needs to remember actually
 * gets decided, and until now none of it reached the knowledge base: calendar
 * events were read to decide whether to wake an agent and then thrown away,
 * and pasted notes had nowhere to go but a plain note with no idea who was in
 * the room.
 *
 * This writes a meeting as a `note` (kind `meeting`), which already indexes
 * into `embeddings` with `purpose='note'` — so no new table, no new purpose,
 * no new retention rule. What it adds is the edge to each attendee: a
 * `knowledge_links` row per person, bound to their profile when one exists and
 * left as a ghost ref when it does not, so creating the profile later
 * retroactively connects every meeting they were in.
 */
import { getKnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { profileRepository } from '@/db/repositories/profile-repository';
import { coreLogger } from '@/utils/logger';
import { getNoteService } from './notes';
import { slugify } from './wikilink';

/** Note kind every meeting note carries, so they can be listed as a set. */
export const MEETING_NOTE_KIND = 'meeting';

export interface Attendee {
  /** Display name, when the platform gave one. */
  name?: string;
  email?: string;
}

export interface MeetingInput {
  userId: string;
  workspaceId?: string | null;
  title: string;
  /** When the meeting happened or is scheduled, ISO-8601. Defaults to now. */
  at?: string;
  attendees?: Attendee[];
  /** The notes themselves — decisions, actions, whatever was written down. */
  body?: string;
  /** Where this came from, e.g. `google`, `microsoft`, `pasted`. */
  source?: string;
  /** Stable id from the source calendar, so a re-import updates rather than duplicates. */
  externalId?: string;
  createdByAgentId?: string | null;
}

export interface MeetingResult {
  noteId: string;
  slug: string;
  created: boolean;
  indexed: boolean;
  /** One entry per attendee, saying whether it bound to an existing profile. */
  attendees: Array<{ ref: string; name: string; profileId: string | null }>;
}

/** A person's display name, from whatever the calendar gave us. */
export function attendeeName(attendee: Attendee): string {
  const name = attendee.name?.trim();
  if (name) return name;
  const email = attendee.email?.trim();
  if (!email) return 'unknown';
  // `ada.lovelace@x.dev` reads better as "ada.lovelace" than as the whole
  // address, and the local part is what a profile is usually named after.
  return email.split('@')[0];
}

/**
 * A stable slug for the meeting note.
 *
 * Built from the date and the title so two standups a week apart are two
 * notes, and a re-import of the same event updates the same note instead of
 * accumulating one per sync.
 */
export function meetingSlug(title: string, at: string): string {
  const day = at.slice(0, 10);
  const base = slugify(title) || 'meeting';
  return `meeting-${day}-${base}`.slice(0, 120);
}

/** Render the note body: what the meeting was, who was there, what was said. */
export function renderMeetingNote(input: MeetingInput, names: string[]): string {
  const lines: string[] = [];
  const at = input.at ?? new Date().toISOString();
  lines.push(`**When:** ${at}`);
  if (names.length > 0) {
    // Wikilinks so the existing note graph picks the people up too, alongside
    // the explicit profile edges written below.
    lines.push(`**Attendees:** ${names.map((name) => `[[${name}]]`).join(', ')}`);
  }
  if (input.source) lines.push(`**Source:** ${input.source}`);
  lines.push('');
  const body = (input.body ?? '').trim();
  lines.push(body.length > 0 ? body : '_No notes recorded._');
  lines.push('');
  return lines.join('\n');
}

/**
 * Match an attendee to one of the user's profiles.
 *
 * Exact name match wins. An email is matched against a stored `email` fact,
 * because `profiles` has no email column and inventing one for this would
 * touch a table five other features read. A partial name match is deliberately
 * NOT accepted: binding "Ada" to "Ada Lovelace" is a guess, and a wrong edge
 * on a meeting record is worse than a ghost that resolves later.
 */
export async function findAttendeeProfile(
  userId: string,
  attendee: Attendee,
): Promise<string | null> {
  const email = attendee.email?.trim().toLowerCase();
  const name = attendee.name?.trim().toLowerCase();

  const candidates = await profileRepository.findByUserId(userId);
  if (email) {
    const byEmail = candidates.find((profile) =>
      (profile.facts ?? []).some((fact) =>
        fact.key?.toLowerCase() === 'email' && String(fact.value).trim().toLowerCase() === email));
    if (byEmail) return byEmail.id;
  }
  if (name) {
    const byName = candidates.find((profile) => profile.name.trim().toLowerCase() === name);
    if (byName) return byName.id;
  }
  return null;
}

/**
 * Write a meeting as a note, with an edge to each attendee.
 *
 * Re-running with the same title and date updates the note rather than adding
 * a second one, which is what makes a scheduled calendar import safe to run
 * every morning.
 */
export async function ingestMeeting(input: MeetingInput): Promise<MeetingResult> {
  const at = input.at ?? new Date().toISOString();
  const attendees = input.attendees ?? [];
  const names = attendees.map(attendeeName);

  const slug = meetingSlug(input.title, at);
  const tags = ['meeting'];
  if (input.source) tags.push(`source/${slugify(input.source)}`);

  const saved = await getNoteService().save({
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    slug,
    title: input.title,
    body: renderMeetingNote({ ...input, at }, names),
    noteKind: MEETING_NOTE_KIND,
    noteDate: at.slice(0, 10),
    tags,
    frontmatter: {
      meetingAt: at,
      attendees: attendees.map((a) => ({ name: attendeeName(a), email: a.email ?? null })),
      ...(input.source ? { source: input.source } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
    },
    createdByAgentId: input.createdByAgentId ?? null,
  });

  const links = getKnowledgeLinkRepository();
  const recorded: MeetingResult['attendees'] = [];

  for (const attendee of attendees) {
    const name = attendeeName(attendee);
    const ref = slugify(name);
    if (!ref) continue;
    const profileId = await findAttendeeProfile(input.userId, attendee).catch(() => null);
    try {
      await links.create({
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        fromType: 'note',
        fromId: saved.note.id,
        // A ghost edge when the person has no profile yet: `resolveTo` binds
        // it the moment one is created, so the history is not lost.
        toType: profileId ? 'profile' : null,
        toId: profileId,
        toRef: ref,
        linkType: 'attended',
        label: name,
        origin: 'agent',
      });
      recorded.push({ ref, name, profileId });
    } catch (err) {
      // One bad attendee must not lose the meeting note that already saved.
      coreLogger.warn(
        { err, userId: input.userId, noteId: saved.note.id, attendee: name },
        'meetings: failed to link attendee',
      );
    }
  }

  return {
    noteId: saved.note.id,
    slug: saved.note.slug,
    created: saved.created,
    indexed: saved.indexed,
    attendees: recorded,
  };
}

/**
 * Bind every ghost attendee edge that now has a profile.
 *
 * Called after a profile is created so past meetings connect to the person
 * without a re-import.
 */
export async function resolveAttendeeLinks(
  userId: string,
  profileId: string,
  name: string,
): Promise<number> {
  const ref = slugify(name);
  if (!ref) return 0;
  return getKnowledgeLinkRepository().resolveTo({
    userId,
    toRef: ref,
    toType: 'profile',
    toId: profileId,
  });
}
