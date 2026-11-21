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
