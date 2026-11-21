/** Calendar shapes shared by the provider service and calendar page. */
export type CalendarProvider = 'google' | 'microsoft';

/** The reader's own answer to an invitation. */
export type CalendarResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction';

/** How an event counts against the reader's time. */
export type CalendarShowAs = 'busy' | 'free' | 'tentative' | 'away';

/** One calendar of a connected account: the reader's own, or one shared with them. */
export interface CalendarInfo {
  provider: CalendarProvider;
  /** The connected account it belongs to (its address), when that is not the provider's default account. */
  account?: string;
  /** The provider's id for the calendar. */
  id: string;
  name: string;
  /** `#rrggbb`, as the provider shows it. */
  color?: string;
  /** The account's default calendar. */
  primary: boolean;
  /** The reader may look but not write. */
  readOnly: boolean;
  /** Someone else's calendar, shared with the reader. */
  shared: boolean;
  /** Whose calendar it is, when the provider says. */
  owner?: string;
  /** Shown on the Calendar page (the reader's stored choice, or the provider's default). */
  visible: boolean;
}

/**
 * `provider:id` — how a calendar is named in stored choices and in the page.
 * A calendar of another account than the provider's default is
 * `provider:account:id`, so the default account's stored choices stay valid.
 */
export const calendarKey = (c: { provider: CalendarProvider; id: string; account?: string }) => (c.account ? `${c.provider}:${c.account}:${c.id}` : `${c.provider}:${c.id}`);

export interface CalendarAttendee {
  name?: string;
  email?: string;
  response?: CalendarResponse;
}

export interface CalendarEvent {
  /** The provider's own id, stable across syncs. */
  id: string;
  title: string;
  /**
   * ISO-8601 start. An all-day event is `YYYY-MM-DDT00:00:00.000Z`: its date
   * part is the calendar date for every reader, whatever their timezone.
   */
  start: string;
  /** For an all-day event the date part is the day after the last one (exclusive). */
  end?: string;
  allDay: boolean;
  description?: string;
  location?: string;
  organizer?: { name?: string; email?: string };
  attendees: CalendarAttendee[];
  provider: CalendarProvider;
  /** The connected account it was read from, when that is not the provider's default account. */
  account?: string;
  /** The calendar it was read from; absent when only the default calendar was read. */
  calendarId?: string;
  calendarName?: string;
  /** The calendar's colour, `#rrggbb`. */
  color?: string;
  /** The reader cannot change it (a read-only calendar). */
  readOnly?: boolean;
  /** The reader's own answer; absent on an event without an invitation to them. */
  responseStatus?: CalendarResponse;
  /** An https link to join the meeting. */
  meetingUrl?: string;
  /** An occurrence of a repeating event. */
  recurring?: boolean;
  /** The repeating event this occurrence belongs to (Google `recurringEventId`, Graph `seriesMasterId`). */
  seriesId?: string;
  showAs?: CalendarShowAs;
  /** The event in the provider's own calendar app. */
  webUrl?: string;
}

/** What the reader chose to see on the Calendar page. */
export interface CalendarPreferences {
  /** Calendar keys (`provider:id`) to show. Unset: the provider's own selection. */
  visible?: string[];
  hideDeclined?: boolean;
}

/** How often an event repeats. Monthly repeats on the start's day of the month, yearly on its date. */
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A repeat rule the Calendar page can make and show. */
export interface CalendarRecurrence {
  frequency: RecurrenceFrequency;
  /** Every n days/weeks/months/years; 1 when absent. */
  interval?: number;
  /** For weekly: the days it falls on; the start's weekday when absent. */
  byDay?: Weekday[];
  /** The last day it may fall on (`YYYY-MM-DD`). */
  until?: string;
  /** How many times it happens in all. Not with `until`. */
  count?: number;
}

/** Which events of a series a change or a deletion reaches. */
export type RecurrenceScope = 'this' | 'all';

/** Reminder choices offered on the page, in minutes before the start. */
export const REMINDER_CHOICES: readonly number[] = [0, 5, 10, 15, 30, 60, 1440];

/** What the edit dialog reads about one event that the event list leaves out or shortens. */
export interface CalendarEventDetails {
  /** The full description as text. */
  description: string;
  /** The description has formatting (HTML) that a changed text would drop. */
  descriptionHasFormatting: boolean;
  attendees: CalendarAttendee[];
  /** Minutes before the start; null: no reminder; absent: the calendar's default. */
  reminderMinutes?: number | null;
  /** The series' rule, when this is one of a repeating event. `custom`: a rule the page cannot show or change. */
  recurrence?: CalendarRecurrence | 'custom';
  seriesId?: string;
}

/** A busy stretch of someone's time. */
export interface BusyInterval { start: string; end: string }

/** POST /api/calendar/freebusy */
export interface FreeBusyResponse {
  /** Busy stretches per guest address. */
  busy: Record<string, BusyInterval[]>;
  /** Guests whose schedule could not be read, with why. Their time is unknown, never free. */
  failed: Record<string, string>;
  /** The reader's own busy time, from the calendars they show. */
  own: BusyInterval[];
  /** Some of the reader's calendars could not be read. */
  ownPartial: boolean;
}
