import type { OAuthTokens } from './tokens';

export type GCalCredentials = OAuthTokens & { email?: string };

export interface GCalCalendar {
  id: string;
  summary: string;
  description?: string;
  accessRole: string;
  primary?: boolean;
  timeZone?: string;
}

export interface GCalEventDateTime {
  dateTime?: string;  // RFC3339 timestamp with timezone
  date?: string;      // YYYY-MM-DD for all-day events
  timeZone?: string;  // IANA timezone name
}

export interface GCalAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;  // needsAction, declined, tentative, accepted
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  comment?: string;
}

export interface GCalReminder {
  method: 'email' | 'popup';
  minutes: number;
}

export interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GCalEventDateTime;
  end: GCalEventDateTime;
  status?: string;  // confirmed, tentative, cancelled
  htmlLink?: string;
  created?: string;
  updated?: string;
  colorId?: string;
  creator?: { email: string; displayName?: string };
  organizer?: { email: string; displayName?: string };
  attendees?: GCalAttendee[];
  recurrence?: string[];
  recurringEventId?: string;
  transparency?: string;  // opaque (busy) or transparent (free)
  visibility?: string;  // default, public, private, confidential
  reminders?: {
    useDefault: boolean;
    overrides?: GCalReminder[];
  };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType: string;
      uri: string;
      label?: string;
    }>;
  };
  eventType?: string;  // default, focusTime, outOfOffice, workingLocation
}

export interface GCalFreeBusyResponse {
  calendars: Record<string, {
    busy: Array<{ start: string; end: string }>;
    errors?: Array<{ domain: string; reason: string }>;
  }>;
}

export interface GCalListOptions {
  calendarId?: string;
  timeMin?: string;  // RFC3339
  timeMax?: string;  // RFC3339
  maxResults?: number;
  pageToken?: string;
  query?: string;
  singleEvents?: boolean;
  orderBy?: 'startTime' | 'updated';
}

export interface GCalCreateOptions {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;  // RFC3339 or YYYY-MM-DD for all-day
  end: string;
  allDay?: boolean;
  attendees?: string[];  // email addresses
  recurrence?: string[];  // RRULE strings
  reminders?: Array<{ method: 'email' | 'popup'; minutes: number }>;
  colorId?: string;
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  transparency?: 'opaque' | 'transparent';
  sendUpdates?: 'all' | 'externalOnly' | 'none';
  withMeet?: boolean;
}

export interface GCalUpdateOptions {
  calendarId?: string;
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  attendees?: string[];
  addAttendees?: string[];
  recurrence?: string[];
  reminders?: Array<{ method: 'email' | 'popup'; minutes: number }>;
  colorId?: string;
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  transparency?: 'opaque' | 'transparent';
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}

export interface GCalRespondOptions {
  calendarId?: string;
  eventId: string;
  status: 'accepted' | 'declined' | 'tentative';
  comment?: string;
}

export interface GCalFreeBusyOptions {
  calendarIds: string[];
  timeMin: string;
  timeMax: string;
}
