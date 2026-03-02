import { createParameterSchema } from '../base-skill';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, url: string, body?: unknown) => Promise<unknown>;

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

export function registerCalendarTools(registerTool: RegisterFn, googleApi: ApiFn): void {
  // --- calendar_list ---
  registerTool('calendar_list', 'List all calendars for the authenticated user', createParameterSchema({}), async (_args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(context.userId, 'GET', `${CALENDAR_BASE}/users/me/calendarList`);
  }, { permissionAction: 'calendar_read' });

  // --- calendar_events ---
  registerTool('calendar_events', 'List events from a calendar within a time range', createParameterSchema({
    calendarId: { type: 'string', description: 'Calendar ID (use "primary" for the main calendar)', default: 'primary' },
    start: { type: 'string', description: 'Start time in ISO 8601 format (e.g. "2025-01-01T00:00:00Z")', required: true },
    end: { type: 'string', description: 'End time in ISO 8601 format', required: true },
    limit: { type: 'number', description: 'Maximum number of events (default 25)', default: 25 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const calendarId = encodeURIComponent((args.calendarId as string) || 'primary');
    const timeMin = encodeURIComponent(args.start as string);
    const timeMax = encodeURIComponent(args.end as string);
    const maxResults = (args.limit as number) || 25;
    return googleApi(
      context.userId,
      'GET',
      `${CALENDAR_BASE}/calendars/${calendarId}/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`
    );
  }, { permissionAction: 'calendar_read' });

  // --- calendar_event_get ---
  registerTool('calendar_event_get', 'Get details of a specific calendar event', createParameterSchema({
    calendarId: { type: 'string', description: 'Calendar ID (use "primary" for the main calendar)', default: 'primary' },
    eventId: { type: 'string', description: 'Event ID', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const calendarId = encodeURIComponent((args.calendarId as string) || 'primary');
    return googleApi(
      context.userId,
      'GET',
      `${CALENDAR_BASE}/calendars/${calendarId}/events/${args.eventId}`
    );
  }, { permissionAction: 'calendar_read' });

  // --- calendar_event_create ---
  registerTool('calendar_event_create', 'Create a new calendar event', createParameterSchema({
    calendarId: { type: 'string', description: 'Calendar ID (use "primary" for the main calendar)', default: 'primary' },
    summary: { type: 'string', description: 'Event title', required: true },
    description: { type: 'string', description: 'Event description' },
    startDateTime: { type: 'string', description: 'Start time in ISO 8601 format', required: true },
    endDateTime: { type: 'string', description: 'End time in ISO 8601 format', required: true },
    timeZone: { type: 'string', description: 'Time zone (e.g. "America/New_York")', default: 'UTC' },
    attendees: { type: 'string', description: 'Comma-separated list of attendee email addresses' },
    location: { type: 'string', description: 'Event location' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const calendarId = encodeURIComponent((args.calendarId as string) || 'primary');
    const timeZone = (args.timeZone as string) || 'UTC';

    const event: Record<string, unknown> = {
      summary: args.summary,
      start: { dateTime: args.startDateTime, timeZone },
      end: { dateTime: args.endDateTime, timeZone },
    };

    if (args.description) event.description = args.description;
    if (args.location) event.location = args.location;
    if (args.attendees) {
      event.attendees = (args.attendees as string).split(',').map(email => ({ email: email.trim() }));
    }

    return googleApi(context.userId, 'POST', `${CALENDAR_BASE}/calendars/${calendarId}/events`, event);
  }, { permissionAction: 'calendar_write' });

  // --- calendar_event_update ---
  registerTool('calendar_event_update', 'Update an existing calendar event (partial update)', createParameterSchema({
    calendarId: { type: 'string', description: 'Calendar ID (use "primary" for the main calendar)', default: 'primary' },
    eventId: { type: 'string', description: 'Event ID', required: true },
    summary: { type: 'string', description: 'New event title' },
    description: { type: 'string', description: 'New event description' },
    startDateTime: { type: 'string', description: 'New start time in ISO 8601 format' },
    endDateTime: { type: 'string', description: 'New end time in ISO 8601 format' },
    timeZone: { type: 'string', description: 'Time zone (e.g. "America/New_York")' },
    attendees: { type: 'string', description: 'Comma-separated list of attendee email addresses (replaces existing)' },
    location: { type: 'string', description: 'Event location' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const calendarId = encodeURIComponent((args.calendarId as string) || 'primary');
    const patch: Record<string, unknown> = {};

    if (args.summary) patch.summary = args.summary;
    if (args.description) patch.description = args.description;
    if (args.location) patch.location = args.location;
    if (args.startDateTime) {
      patch.start = { dateTime: args.startDateTime, timeZone: args.timeZone || 'UTC' };
    }
    if (args.endDateTime) {
      patch.end = { dateTime: args.endDateTime, timeZone: args.timeZone || 'UTC' };
    }
    if (args.attendees) {
      patch.attendees = (args.attendees as string).split(',').map(email => ({ email: email.trim() }));
    }

    return googleApi(
      context.userId,
      'PATCH',
      `${CALENDAR_BASE}/calendars/${calendarId}/events/${args.eventId}`,
      patch
    );
  }, { permissionAction: 'calendar_write' });

  // --- calendar_event_delete ---
  registerTool('calendar_event_delete', 'Delete a calendar event', createParameterSchema({
    calendarId: { type: 'string', description: 'Calendar ID (use "primary" for the main calendar)', default: 'primary' },
    eventId: { type: 'string', description: 'Event ID to delete', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const calendarId = encodeURIComponent((args.calendarId as string) || 'primary');
    return googleApi(
      context.userId,
      'DELETE',
      `${CALENDAR_BASE}/calendars/${calendarId}/events/${args.eventId}`
    );
  }, { permissionAction: 'delete' });
}
