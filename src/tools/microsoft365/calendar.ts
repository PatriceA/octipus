import type { AgentContext } from '@/core/types';
import { createParameterSchema } from '../base-tool';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export function registerCalendarTools(registerTool: RegisterFn, graphApi: ApiFn): void {
  // --- calendar_list ---
  registerTool(
    'calendar_list',
    'List all calendars for the user',
    createParameterSchema({}),
    async (_args: Record<string, unknown>, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'GET',
        '/me/calendars?$select=id,name,color,isDefaultCalendar'
      );
    },
    { permissionAction: 'calendar_read' }
  );

  // --- calendar_events ---
  registerTool(
    'calendar_events',
    'List events from a calendar (or default calendar)',
    createParameterSchema({
      calendarId: { type: 'string', description: 'Calendar ID (omit for default calendar)' },
      limit: { type: 'number', description: 'Maximum number of events to return (default 20)', default: 20 },
    }),
    async (args: { calendarId?: string; limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      const basePath = args.calendarId
        ? `/me/calendars/${args.calendarId}/events`
        : '/me/events';
      return graphApi(
        ctx.userId,
        'GET',
        `${basePath}?$top=${limit}&$select=id,subject,start,end,location,organizer,isAllDay&$orderby=start/dateTime`
      );
    },
    { permissionAction: 'calendar_read' }
  );

  // --- calendar_event_get ---
  registerTool(
    'calendar_event_get',
    'Get a specific calendar event by ID',
    createParameterSchema({
      id: { type: 'string', description: 'The event ID', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'GET',
        `/me/events/${args.id}?$select=id,subject,body,start,end,location,attendees,organizer`
      );
    },
    { permissionAction: 'calendar_read' }
  );

  // --- calendar_event_create ---
  registerTool(
    'calendar_event_create',
    'Create a new calendar event',
    createParameterSchema({
      calendarId: { type: 'string', description: 'Calendar ID (omit for default calendar)' },
      subject: { type: 'string', description: 'Event subject/title', required: true },
      description: { type: 'string', description: 'Event description' },
      startDateTime: { type: 'string', description: 'Start date and time (ISO 8601, e.g. 2025-06-15T09:00:00)', required: true },
      endDateTime: { type: 'string', description: 'End date and time (ISO 8601, e.g. 2025-06-15T10:00:00)', required: true },
      timeZone: { type: 'string', description: 'Time zone (e.g. UTC, America/New_York)', default: 'UTC' },
      attendees: { type: 'string', description: 'Comma-separated list of attendee email addresses' },
    }),
    async (args: {
      calendarId?: string;
      subject: string;
      description?: string;
      startDateTime: string;
      endDateTime: string;
      timeZone?: string;
      attendees?: string;
    }, ctx: AgentContext) => {
      const timeZone = args.timeZone ?? 'UTC';
      const basePath = args.calendarId
        ? `/me/calendars/${args.calendarId}/events`
        : '/me/events';

      const event: Record<string, unknown> = {
        subject: args.subject,
        start: { dateTime: args.startDateTime, timeZone },
        end: { dateTime: args.endDateTime, timeZone },
      };

      if (args.description) {
        event.body = { contentType: 'Text', content: args.description };
      }

      if (args.attendees) {
        event.attendees = args.attendees.split(',').map((email) => ({
          emailAddress: { address: email.trim() },
          type: 'required',
        }));
      }

      return graphApi(ctx.userId, 'POST', basePath, event);
    },
    { permissionAction: 'calendar_write' }
  );

  // --- calendar_event_update ---
  registerTool(
    'calendar_event_update',
    'Update an existing calendar event',
    createParameterSchema({
      id: { type: 'string', description: 'The event ID to update', required: true },
      subject: { type: 'string', description: 'New event subject/title' },
      description: { type: 'string', description: 'New event description' },
      startDateTime: { type: 'string', description: 'New start date and time (ISO 8601)' },
      endDateTime: { type: 'string', description: 'New end date and time (ISO 8601)' },
      timeZone: { type: 'string', description: 'Time zone (e.g. UTC, America/New_York)' },
    }),
    async (args: {
      id: string;
      subject?: string;
      description?: string;
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
    }, ctx: AgentContext) => {
      const update: Record<string, unknown> = {};

      if (args.subject) update.subject = args.subject;
      if (args.description) update.body = { contentType: 'Text', content: args.description };
      if (args.startDateTime) {
        update.start = { dateTime: args.startDateTime, timeZone: args.timeZone ?? 'UTC' };
      }
      if (args.endDateTime) {
        update.end = { dateTime: args.endDateTime, timeZone: args.timeZone ?? 'UTC' };
      }

      return graphApi(ctx.userId, 'PATCH', `/me/events/${args.id}`, update);
    },
    { permissionAction: 'calendar_write' }
  );

  // --- calendar_event_delete ---
  registerTool(
    'calendar_event_delete',
    'Delete a calendar event by ID',
    createParameterSchema({
      id: { type: 'string', description: 'The event ID to delete', required: true },
    }),
    async (args: { id: string }, ctx: AgentContext) => {
      return graphApi(ctx.userId, 'DELETE', `/me/events/${args.id}`);
    },
    { permissionAction: 'delete' }
  );
}
