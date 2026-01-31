import { calendar, type calendar_v3 } from '@googleapis/calendar';
import type { OAuth2Client } from 'google-auth-library';
import type {
  GCalCalendar,
  GCalEvent,
  GCalListOptions,
  GCalCreateOptions,
  GCalUpdateOptions,
  GCalRespondOptions,
  GCalFreeBusyOptions,
  GCalFreeBusyResponse,
} from '../../types/gcal';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';

export class GCalClient implements ServiceClient {
  private calendar: calendar_v3.Calendar;
  private userEmail: string | null = null;

  constructor(auth: OAuth2Client) {
    this.calendar = calendar({ version: 'v3', auth: auth as any });
  }

  async validate(): Promise<ValidationResult> {
    try {
      const email = await this.getUserEmail();
      return { valid: true, info: email };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  private async getUserEmail(): Promise<string> {
    if (this.userEmail) return this.userEmail;

    const response = await this.calendar.calendarList.get({ calendarId: 'primary' });
    this.userEmail = response.data.id || 'me';
    return this.userEmail;
  }

  async listCalendars(limit: number = 100): Promise<GCalCalendar[]> {
    try {
      const response = await this.calendar.calendarList.list({
        maxResults: Math.min(limit, 250),
      });

      return (response.data.items || []).map((cal) => ({
        id: cal.id!,
        summary: cal.summary || '',
        description: cal.description || undefined,
        accessRole: cal.accessRole || '',
        primary: cal.primary || false,
        timeZone: cal.timeZone || undefined,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Calendar API error: ${message}`);
    }
  }

  async listEvents(options: GCalListOptions = {}): Promise<{ events: GCalEvent[]; nextPageToken?: string }> {
    const { calendarId = 'primary', timeMin, timeMax, maxResults = 10, pageToken, query, singleEvents = true, orderBy } = options;

    try {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId,
        maxResults: Math.min(maxResults, 250),
        singleEvents,
      };

      if (timeMin) params.timeMin = timeMin;
      if (timeMax) params.timeMax = timeMax;
      if (pageToken) params.pageToken = pageToken;
      if (query) params.q = query;
      if (singleEvents && orderBy) params.orderBy = orderBy;
      else if (singleEvents) params.orderBy = 'startTime';

      const response = await this.calendar.events.list(params);

      const events: GCalEvent[] = (response.data.items || []).map((event) => this.parseEvent(event));

      return {
        events,
        nextPageToken: response.data.nextPageToken || undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Calendar API error: ${message}`);
    }
  }

  async getEvent(calendarId: string, eventId: string): Promise<GCalEvent> {
    try {
      const response = await this.calendar.events.get({ calendarId, eventId });
      return this.parseEvent(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Event not found: ${eventId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Calendar API error: ${message}`);
    }
  }

  async createEvent(options: GCalCreateOptions): Promise<GCalEvent> {
    const { calendarId = 'primary', summary, description, location, start, end, allDay, attendees, recurrence, reminders, colorId, visibility, transparency, sendUpdates = 'all', withMeet } = options;

    try {
      const event: calendar_v3.Schema$Event = {
        summary,
        description,
        location,
        start: this.buildEventDateTime(start, allDay),
        end: this.buildEventDateTime(end, allDay),
      };

      if (attendees?.length) {
        event.attendees = attendees.map((email) => ({ email }));
      }

      if (recurrence?.length) {
        event.recurrence = recurrence;
      }

      if (reminders?.length) {
        event.reminders = {
          useDefault: false,
          overrides: reminders.map((r) => ({ method: r.method, minutes: r.minutes })),
        };
      }

      if (colorId) event.colorId = colorId;
      if (visibility) event.visibility = visibility;
      if (transparency) event.transparency = transparency;

      if (withMeet) {
        event.conferenceData = {
          createRequest: {
            requestId: `agentio-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        };
      }

      const params: calendar_v3.Params$Resource$Events$Insert = {
        calendarId,
        requestBody: event,
        sendUpdates,
      };

      if (withMeet) {
        params.conferenceDataVersion = 1;
      }

      const response = await this.calendar.events.insert(params);
      return this.parseEvent(response.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create event: ${message}`);
    }
  }

  async updateEvent(options: GCalUpdateOptions): Promise<GCalEvent> {
    const { calendarId = 'primary', eventId, summary, description, location, start, end, allDay, attendees, addAttendees, recurrence, reminders, colorId, visibility, transparency, sendUpdates = 'all' } = options;

    try {
      // If addAttendees is used, fetch existing event first
      let existingAttendees: calendar_v3.Schema$EventAttendee[] = [];
      if (addAttendees?.length) {
        const existing = await this.calendar.events.get({ calendarId, eventId });
        existingAttendees = existing.data.attendees || [];
      }

      const patch: calendar_v3.Schema$Event = {};

      if (summary !== undefined) patch.summary = summary;
      if (description !== undefined) patch.description = description;
      if (location !== undefined) patch.location = location;
      if (start) patch.start = this.buildEventDateTime(start, allDay);
      if (end) patch.end = this.buildEventDateTime(end, allDay);
      if (colorId !== undefined) patch.colorId = colorId;
      if (visibility) patch.visibility = visibility;
      if (transparency) patch.transparency = transparency;

      if (attendees?.length) {
        patch.attendees = attendees.map((email) => ({ email }));
      } else if (addAttendees?.length) {
        const existingEmails = new Set(existingAttendees.map((a) => a.email?.toLowerCase()));
        const newAttendees = addAttendees
          .filter((email) => !existingEmails.has(email.toLowerCase()))
          .map((email) => ({ email, responseStatus: 'needsAction' }));
        patch.attendees = [...existingAttendees, ...newAttendees];
      }

      if (recurrence?.length) {
        patch.recurrence = recurrence;
      }

      if (reminders?.length) {
        patch.reminders = {
          useDefault: false,
          overrides: reminders.map((r) => ({ method: r.method, minutes: r.minutes })),
        };
      }

      const response = await this.calendar.events.patch({
        calendarId,
        eventId,
        requestBody: patch,
        sendUpdates,
      });

      return this.parseEvent(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Event not found: ${eventId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to update event: ${message}`);
    }
  }

  async deleteEvent(calendarId: string, eventId: string, sendUpdates: 'all' | 'externalOnly' | 'none' = 'all'): Promise<void> {
    try {
      await this.calendar.events.delete({ calendarId, eventId, sendUpdates });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Event not found: ${eventId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to delete event: ${message}`);
    }
  }

  async respond(options: GCalRespondOptions): Promise<GCalEvent> {
    const { calendarId = 'primary', eventId, status, comment } = options;

    try {
      const event = await this.calendar.events.get({ calendarId, eventId });

      if (!event.data.attendees?.length) {
        throw new CliError('INVALID_PARAMS', 'Event has no attendees');
      }

      const selfIndex = event.data.attendees.findIndex((a) => a.self);
      if (selfIndex === -1) {
        throw new CliError('INVALID_PARAMS', 'You are not an attendee of this event');
      }

      if (event.data.attendees[selfIndex].organizer) {
        throw new CliError('INVALID_PARAMS', 'Cannot respond to your own event (you are the organizer)');
      }

      event.data.attendees[selfIndex].responseStatus = status;
      if (comment) {
        event.data.attendees[selfIndex].comment = comment;
      }

      const response = await this.calendar.events.patch({
        calendarId,
        eventId,
        requestBody: { attendees: event.data.attendees },
      });

      return this.parseEvent(response.data);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Event not found: ${eventId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to respond to event: ${message}`);
    }
  }

  async freeBusy(options: GCalFreeBusyOptions): Promise<GCalFreeBusyResponse> {
    const { calendarIds, timeMin, timeMax } = options;

    try {
      const response = await this.calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: calendarIds.map((id) => ({ id })),
        },
      });

      const calendars: GCalFreeBusyResponse['calendars'] = {};
      for (const [id, data] of Object.entries(response.data.calendars || {})) {
        calendars[id] = {
          busy: (data.busy || []).map((b) => ({ start: b.start!, end: b.end! })),
          errors: data.errors?.map((e) => ({ domain: e.domain || '', reason: e.reason || '' })),
        };
      }

      return { calendars };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Calendar API error: ${message}`);
    }
  }

  async search(query: string, options: Omit<GCalListOptions, 'query'> = {}): Promise<{ events: GCalEvent[]; nextPageToken?: string }> {
    return this.listEvents({ ...options, query });
  }

  private buildEventDateTime(value: string, allDay?: boolean): calendar_v3.Schema$EventDateTime {
    const trimmed = value.trim();
    if (allDay || !trimmed.includes('T')) {
      return { date: trimmed };
    }
    return { dateTime: trimmed };
  }

  private parseEvent(event: calendar_v3.Schema$Event): GCalEvent {
    return {
      id: event.id!,
      summary: event.summary || undefined,
      description: event.description || undefined,
      location: event.location || undefined,
      start: {
        dateTime: event.start?.dateTime || undefined,
        date: event.start?.date || undefined,
        timeZone: event.start?.timeZone || undefined,
      },
      end: {
        dateTime: event.end?.dateTime || undefined,
        date: event.end?.date || undefined,
        timeZone: event.end?.timeZone || undefined,
      },
      status: event.status || undefined,
      htmlLink: event.htmlLink || undefined,
      created: event.created || undefined,
      updated: event.updated || undefined,
      colorId: event.colorId || undefined,
      creator: event.creator ? { email: event.creator.email!, displayName: event.creator.displayName || undefined } : undefined,
      organizer: event.organizer ? { email: event.organizer.email!, displayName: event.organizer.displayName || undefined } : undefined,
      attendees: event.attendees?.map((a) => ({
        email: a.email!,
        displayName: a.displayName || undefined,
        responseStatus: a.responseStatus || undefined,
        optional: a.optional || undefined,
        organizer: a.organizer || undefined,
        self: a.self || undefined,
        comment: a.comment || undefined,
      })),
      recurrence: event.recurrence || undefined,
      recurringEventId: event.recurringEventId || undefined,
      transparency: event.transparency || undefined,
      visibility: event.visibility || undefined,
      reminders: event.reminders ? {
        useDefault: event.reminders.useDefault || false,
        overrides: event.reminders.overrides?.map((r) => ({
          method: r.method as 'email' | 'popup',
          minutes: r.minutes!,
        })),
      } : undefined,
      hangoutLink: event.hangoutLink || undefined,
      conferenceData: event.conferenceData ? {
        entryPoints: event.conferenceData.entryPoints?.map((ep) => ({
          entryPointType: ep.entryPointType!,
          uri: ep.uri!,
          label: ep.label || undefined,
        })),
      } : undefined,
      eventType: event.eventType || undefined,
    };
  }

  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code: unknown }).code === 404;
    }
    return false;
  }
}
