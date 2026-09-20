import type { GCalCalendar, GCalEvent, GCalFreeBusyResponse } from './types';

// Google Calendar specific formatters
function getEventDateTime(dt: { dateTime?: string; date?: string }): string {
  return dt.dateTime || dt.date || '';
}

export function printGCalCalendarList(calendars: GCalCalendar[]): void {
  if (calendars.length === 0) {
    console.log('No calendars found');
    return;
  }

  console.log(`Calendars (${calendars.length})\n`);

  for (let i = 0; i < calendars.length; i++) {
    const cal = calendars[i];
    const primaryBadge = cal.primary ? ' [primary]' : '';
    console.log(`[${i + 1}] ${cal.summary}${primaryBadge}`);
    console.log(`    ID: ${cal.id}`);
    console.log(`    Role: ${cal.accessRole}`);
    if (cal.timeZone) console.log(`    Timezone: ${cal.timeZone}`);
    if (cal.description) {
      const desc = cal.description.length > 80
        ? cal.description.slice(0, 80) + '...'
        : cal.description;
      console.log(`    > ${desc}`);
    }
    console.log('');
  }
}

export function printGCalEventList(events: GCalEvent[], nextPageToken?: string): void {
  if (events.length === 0) {
    console.log('No events found');
    return;
  }

  console.log(`Events (${events.length})\n`);

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const start = getEventDateTime(event.start);
    const end = getEventDateTime(event.end);
    const title = event.summary || '(no title)';

    console.log(`[${i + 1}] ${event.id}`);
    console.log(`    ${title}`);
    console.log(`    Start: ${start}`);
    console.log(`    End: ${end}`);
    if (event.location) console.log(`    Location: ${event.location}`);
    if (event.attendees?.length) {
      console.log(`    Attendees: ${event.attendees.length}`);
    }
    if (event.hangoutLink) console.log(`    Meet: ${event.hangoutLink}`);
    console.log('');
  }

  if (nextPageToken) {
    console.log(`(more results available, use --page ${nextPageToken})`);
  }
}

export function printGCalEvent(event: GCalEvent): void {
  console.log(`ID: ${event.id}`);
  console.log(`Summary: ${event.summary || '(no title)'}`);

  if (event.eventType && event.eventType !== 'default') {
    console.log(`Type: ${event.eventType}`);
  }

  const start = getEventDateTime(event.start);
  const end = getEventDateTime(event.end);
  console.log(`Start: ${start}`);
  console.log(`End: ${end}`);

  if (event.start.timeZone) console.log(`Timezone: ${event.start.timeZone}`);
  if (event.location) console.log(`Location: ${event.location}`);
  if (event.description) console.log(`Description: ${event.description}`);

  if (event.colorId) console.log(`Color: ${event.colorId}`);
  if (event.visibility && event.visibility !== 'default') {
    console.log(`Visibility: ${event.visibility}`);
  }
  if (event.transparency === 'transparent') {
    console.log(`Show as: free`);
  }

  if (event.attendees?.length) {
    console.log(`\nAttendees (${event.attendees.length}):`);
    for (const a of event.attendees) {
      const status = a.responseStatus || 'unknown';
      const optional = a.optional ? ' (optional)' : '';
      const organizer = a.organizer ? ' [organizer]' : '';
      const self = a.self ? ' [you]' : '';
      console.log(`  ${a.email} - ${status}${optional}${organizer}${self}`);
    }
  }

  if (event.recurrence?.length) {
    console.log(`Recurrence: ${event.recurrence.join('; ')}`);
  }

  if (event.reminders) {
    if (event.reminders.useDefault) {
      console.log(`Reminders: (calendar default)`);
    } else if (event.reminders.overrides?.length) {
      const parts = event.reminders.overrides.map(r => `${r.method}:${r.minutes}m`);
      console.log(`Reminders: ${parts.join(', ')}`);
    }
  }

  if (event.hangoutLink) console.log(`Meet: ${event.hangoutLink}`);
  if (event.conferenceData?.entryPoints?.length) {
    for (const ep of event.conferenceData.entryPoints) {
      if (ep.entryPointType === 'video') {
        console.log(`Video: ${ep.uri}`);
      }
    }
  }

  if (event.htmlLink) console.log(`Link: ${event.htmlLink}`);
}

export function printGCalEventCreated(event: GCalEvent): void {
  console.log('Event created');
  console.log(`ID: ${event.id}`);
  console.log(`Summary: ${event.summary || '(no title)'}`);
  console.log(`Start: ${getEventDateTime(event.start)}`);
  console.log(`End: ${getEventDateTime(event.end)}`);
  if (event.hangoutLink) console.log(`Meet: ${event.hangoutLink}`);
  if (event.htmlLink) console.log(`Link: ${event.htmlLink}`);
}

export function printGCalEventDeleted(calendarId: string, eventId: string): void {
  console.log('Event deleted');
  console.log(`Calendar: ${calendarId}`);
  console.log(`Event ID: ${eventId}`);
}

export function printGCalFreeBusy(result: GCalFreeBusyResponse): void {
  const calendars = Object.entries(result.calendars);
  if (calendars.length === 0) {
    console.log('No free/busy data');
    return;
  }

  console.log('Free/Busy Information\n');

  for (const [calendarId, data] of calendars) {
    console.log(`Calendar: ${calendarId}`);
    if (data.errors?.length) {
      for (const err of data.errors) {
        console.log(`  Error: ${err.reason}`);
      }
    }
    if (data.busy.length === 0) {
      console.log('  (no busy periods)');
    } else {
      for (const b of data.busy) {
        console.log(`  Busy: ${b.start} - ${b.end}`);
      }
    }
    console.log('');
  }
}
