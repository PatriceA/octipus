/**
 * Turning calendar events into meeting notes.
 *
 * Kept separate from both halves it joins so neither depends on the other:
 * `calendar/events.ts` knows nothing about notes, and `knowledge/meetings.ts`
 * knows nothing about Google or Microsoft.
 *
 * Safe to run on a schedule. Each event writes to a slug derived from its
 * date and title, so a second import of the same day updates the same notes
 * instead of stacking duplicates — and an event whose note already has typed
 * notes in it is left alone rather than overwritten with the invite text.
 */
import { ingestMeeting, type MeetingResult, meetingSlug } from '@/core/knowledge/meetings';
import { getNoteRepository } from '@/db/repositories/note-repository';
import { coreLogger } from '@/utils/logger';
import { type CalendarDeps, type CalendarEvent, listCalendarEvents } from './events';

export interface ImportResult {
  imported: Array<MeetingResult & { title: string; at: string; provider: string }>;
  /** Events skipped because a note for them already has content of its own. */
  skipped: Array<{ title: string; at: string; reason: string }>;
  providers: string[];
  /** True when a connected calendar could not be read. */
  partial: boolean;
}

/** The invite text an event carries, as the initial body of its note. */
export function eventBody(event: CalendarEvent): string {
  const lines: string[] = [];
  if (event.location) lines.push(`**Where:** ${event.location}`);
  if (event.end) lines.push(`**Until:** ${event.end}`);
  if (event.organizer) {
    lines.push(`**Organiser:** ${event.organizer.name ?? event.organizer.email ?? 'unknown'}`);
  }
  if (event.description) {
    lines.push('', '## From the invite', '', event.description);
  }
  lines.push('', '## Notes', '', '_Add what was decided and who owns what._');
  return lines.join('\n');
}

/**
 * Whether a note already holds notes a person wrote.
 *
 * The imported body ends with the "Add what was decided" placeholder; once
 * somebody has replaced that, re-importing must not throw their notes away.
 */
export function hasOwnNotes(body: string): boolean {
  return !body.includes('_Add what was decided and who owns what._');
}

export async function importCalendarMeetings(input: {
  userId: string;
  workspaceId?: string | null;
  from: Date;
  to: Date;
  limit?: number;
  /** Skip all-day entries — usually holidays and out-of-office, not meetings. */
  includeAllDay?: boolean;
  deps?: CalendarDeps;
  createdByAgentId?: string | null;
}): Promise<ImportResult> {
  const listed = await listCalendarEvents(input.userId, {
    from: input.from,
    to: input.to,
    limit: input.limit,
    deps: input.deps,
  });

  const notes = getNoteRepository();
  const imported: ImportResult['imported'] = [];
  const skipped: ImportResult['skipped'] = [];

  for (const event of listed.events) {
    if (event.allDay && !input.includeAllDay) {
      skipped.push({ title: event.title, at: event.start, reason: 'all-day entry' });
      continue;
    }

    const slug = meetingSlug(event.title, event.start);
    const existing = await notes.getBySlug(input.userId, input.workspaceId ?? null, slug).catch(() => null);
    if (existing && hasOwnNotes(existing.body ?? '')) {
      skipped.push({ title: event.title, at: event.start, reason: 'note already has your own notes' });
      continue;
    }

    try {
      const result = await ingestMeeting({
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        title: event.title,
        at: event.start,
        attendees: event.attendees,
        body: eventBody(event),
        source: event.provider,
        externalId: event.id,
        createdByAgentId: input.createdByAgentId ?? null,
      });
      imported.push({ ...result, title: event.title, at: event.start, provider: event.provider });
    } catch (err) {
      // One unwritable event must not abort the rest of the day's import.
      coreLogger.warn(
        { err: (err as Error).message, userId: input.userId, title: event.title },
        'calendar: failed to import meeting',
      );
      skipped.push({ title: event.title, at: event.start, reason: (err as Error).message });
    }
  }

  return { imported, skipped, providers: listed.providers, partial: listed.partial };
}
