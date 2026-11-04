/** Calendar shapes shared by the provider service and calendar page. */
export type CalendarProvider = 'google' | 'microsoft';

export interface CalendarEvent {
  /** The provider's own id, stable across syncs. */
  id: string;
  title: string;
  /** ISO-8601 start. An all-day event starts at midnight in its own zone. */
  start: string;
  end?: string;
  allDay: boolean;
  description?: string;
  location?: string;
  organizer?: { name?: string; email?: string };
  attendees: Array<{ name?: string; email?: string }>;
  provider: CalendarProvider;
}

