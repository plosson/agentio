import { Command } from 'commander';
import { calendar } from '@googleapis/calendar';
import { getValidTokens, createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { performOAuthFlow } from '../auth/oauth';
import { GCalClient } from '../services/gcal/client';
import { printGCalCalendarList, printGCalEventList, printGCalEvent, printGCalEventCreated, printGCalEventDeleted, printGCalFreeBusy } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';

async function getGCalClient(profileName?: string): Promise<{ client: GCalClient; profile: string }> {
  const { tokens, profile } = await getValidTokens('gcal', profileName);
  const auth = createGoogleAuth(tokens);
  return { client: new GCalClient(auth), profile };
}

function parseTimeRange(options: { from?: string; to?: string; today?: boolean; tomorrow?: boolean; days?: string }): { timeMin?: string; timeMax?: string } {
  const now = new Date();
  let timeMin: string | undefined;
  let timeMax: string | undefined;

  if (options.today) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    timeMin = start.toISOString();
    timeMax = end.toISOString();
  } else if (options.tomorrow) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    timeMin = start.toISOString();
    timeMax = end.toISOString();
  } else if (options.days) {
    const days = parseInt(options.days, 10);
    if (!isNaN(days) && days > 0) {
      timeMin = now.toISOString();
      const end = new Date(now);
      end.setDate(end.getDate() + days);
      timeMax = end.toISOString();
    }
  } else {
    if (options.from) timeMin = options.from;
    if (options.to) timeMax = options.to;
  }

  return { timeMin, timeMax };
}

export function registerGCalCommands(program: Command): void {
  const gcal = program
    .command('gcal')
    .description('Google Calendar operations');

  // List calendars
  gcal
    .command('calendars')
    .description('List available calendars')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--limit <n>', 'Max results', '100')
    .action(async (options) => {
      try {
        const { client } = await getGCalClient(options.profile);
        const calendars = await client.listCalendars(parseInt(options.limit, 10));
        printGCalCalendarList(calendars);
      } catch (error) {
        handleError(error);
      }
    });

  // List events
  gcal
    .command('events')
    .alias('list')
    .description('List events from a calendar')
    .argument('[calendar-id]', 'Calendar ID (default: primary)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--limit <n>', 'Max results', '10')
    .option('--from <datetime>', 'Start time (RFC3339 or YYYY-MM-DD)')
    .option('--to <datetime>', 'End time (RFC3339 or YYYY-MM-DD)')
    .option('--today', 'Show today\'s events only')
    .option('--tomorrow', 'Show tomorrow\'s events only')
    .option('--days <n>', 'Show events for next N days')
    .option('--query <q>', 'Free text search query')
    .action(async (calendarId: string | undefined, options) => {
      try {
        const { client } = await getGCalClient(options.profile);
        const { timeMin, timeMax } = parseTimeRange(options);
        const result = await client.listEvents({
          calendarId: calendarId || 'primary',
          maxResults: parseInt(options.limit, 10),
          timeMin,
          timeMax,
          query: options.query,
        });
        printGCalEventList(result.events, result.nextPageToken);
      } catch (error) {
        handleError(error);
      }
    });

  // Get event
  gcal
    .command('get')
    .alias('event')
    .description('Get a single event')
    .argument('<calendar-id>', 'Calendar ID')
    .argument('<event-id>', 'Event ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (calendarId: string, eventId: string, options) => {
      try {
        const { client } = await getGCalClient(options.profile);
        const event = await client.getEvent(calendarId, eventId);
        printGCalEvent(event);
      } catch (error) {
        handleError(error);
      }
    });

  // Create event
  gcal
    .command('create')
    .description('Create a new event')
    .argument('[calendar-id]', 'Calendar ID (default: primary)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--summary <title>', 'Event title/summary')
    .requiredOption('--from <datetime>', 'Start time (RFC3339 or YYYY-MM-DD for all-day)')
    .requiredOption('--to <datetime>', 'End time (RFC3339 or YYYY-MM-DD for all-day)')
    .option('--description <text>', 'Event description (or pipe via stdin)')
    .option('--location <place>', 'Event location')
    .option('--all-day', 'Create as all-day event')
    .option('--attendee <email>', 'Attendee email (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--rrule <rule>', 'Recurrence rule (repeatable, e.g., RRULE:FREQ=WEEKLY;BYDAY=MO)', (val, acc: string[]) => [...acc, val], [])
    .option('--reminder <spec>', 'Reminder as method:minutes (repeatable, e.g., popup:30, email:1440)', (val, acc: string[]) => [...acc, val], [])
    .option('--color <id>', 'Color ID (1-11)')
    .option('--visibility <v>', 'Visibility: default, public, private, confidential')
    .option('--show-as <v>', 'Show as: busy, free')
    .option('--send-updates <mode>', 'Send notifications: all, externalOnly, none', 'all')
    .option('--with-meet', 'Create Google Meet link')
    .action(async (calendarId: string | undefined, options) => {
      try {
        let description = options.description;
        if (!description) {
          const stdin = await readStdin();
          if (stdin) description = stdin;
        }

        const reminders = options.reminder.map((r: string) => {
          const [method, minutes] = r.split(':');
          if (!method || !minutes || !['email', 'popup'].includes(method)) {
            throw new CliError('INVALID_PARAMS', `Invalid reminder format: ${r}`, 'Use format: method:minutes (e.g., popup:30)');
          }
          return { method: method as 'email' | 'popup', minutes: parseInt(minutes, 10) };
        });

        const { client, profile } = await getGCalClient(options.profile);
        await enforceWriteAccess('gcal', profile, 'create event');
        const event = await client.createEvent({
          calendarId: calendarId || 'primary',
          summary: options.summary,
          description,
          location: options.location,
          start: options.from,
          end: options.to,
          allDay: options.allDay,
          attendees: options.attendee.length ? options.attendee : undefined,
          recurrence: options.rrule.length ? options.rrule : undefined,
          reminders: reminders.length ? reminders : undefined,
          colorId: options.color,
          visibility: options.visibility,
          transparency: options.showAs === 'free' ? 'transparent' : options.showAs === 'busy' ? 'opaque' : undefined,
          sendUpdates: options.sendUpdates,
          withMeet: options.withMeet,
        });
        printGCalEventCreated(event);
      } catch (error) {
        handleError(error);
      }
    });

  // Update event
  gcal
    .command('update')
    .description('Update an existing event')
    .argument('<calendar-id>', 'Calendar ID')
    .argument('<event-id>', 'Event ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--summary <title>', 'New event title/summary')
    .option('--from <datetime>', 'New start time')
    .option('--to <datetime>', 'New end time')
    .option('--description <text>', 'New description (or pipe via stdin)')
    .option('--location <place>', 'New location')
    .option('--all-day', 'Convert to all-day event')
    .option('--attendee <email>', 'Replace attendees (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--add-attendee <email>', 'Add attendee (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--color <id>', 'New color ID (1-11)')
    .option('--visibility <v>', 'Visibility: default, public, private, confidential')
    .option('--show-as <v>', 'Show as: busy, free')
    .option('--send-updates <mode>', 'Send notifications: all, externalOnly, none', 'all')
    .action(async (calendarId: string, eventId: string, options) => {
      try {
        let description = options.description;
        if (description === undefined && !process.stdin.isTTY) {
          const stdin = await readStdin();
          if (stdin) description = stdin;
        }

        if (options.attendee.length && options.addAttendee.length) {
          throw new CliError('INVALID_PARAMS', 'Cannot use both --attendee and --add-attendee');
        }

        const { client, profile } = await getGCalClient(options.profile);
        await enforceWriteAccess('gcal', profile, 'update event');
        const event = await client.updateEvent({
          calendarId,
          eventId,
          summary: options.summary,
          description,
          location: options.location,
          start: options.from,
          end: options.to,
          allDay: options.allDay,
          attendees: options.attendee.length ? options.attendee : undefined,
          addAttendees: options.addAttendee.length ? options.addAttendee : undefined,
          colorId: options.color,
          visibility: options.visibility,
          transparency: options.showAs === 'free' ? 'transparent' : options.showAs === 'busy' ? 'opaque' : undefined,
          sendUpdates: options.sendUpdates,
        });
        printGCalEvent(event);
      } catch (error) {
        handleError(error);
      }
    });

  // Delete event
  gcal
    .command('delete')
    .description('Delete an event')
    .argument('<calendar-id>', 'Calendar ID')
    .argument('<event-id>', 'Event ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--send-updates <mode>', 'Send notifications: all, externalOnly, none', 'all')
    .action(async (calendarId: string, eventId: string, options) => {
      try {
        const { client, profile } = await getGCalClient(options.profile);
        await enforceWriteAccess('gcal', profile, 'delete event');
        await client.deleteEvent(calendarId, eventId, options.sendUpdates);
        printGCalEventDeleted(calendarId, eventId);
      } catch (error) {
        handleError(error);
      }
    });

  // Search events
  gcal
    .command('search')
    .description('Search events')
    .argument('<query>', 'Search query')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--calendar <id>', 'Calendar ID', 'primary')
    .option('--limit <n>', 'Max results', '25')
    .option('--from <datetime>', 'Start time (RFC3339)')
    .option('--to <datetime>', 'End time (RFC3339)')
    .action(async (query: string, options) => {
      try {
        const { client } = await getGCalClient(options.profile);

        // Default search range: 30 days past to 90 days future
        const now = new Date();
        const defaultFrom = new Date(now);
        defaultFrom.setDate(defaultFrom.getDate() - 30);
        const defaultTo = new Date(now);
        defaultTo.setDate(defaultTo.getDate() + 90);

        const result = await client.search(query, {
          calendarId: options.calendar,
          maxResults: parseInt(options.limit, 10),
          timeMin: options.from || defaultFrom.toISOString(),
          timeMax: options.to || defaultTo.toISOString(),
        });
        printGCalEventList(result.events, result.nextPageToken);
      } catch (error) {
        handleError(error);
      }
    });

  // Respond to event
  gcal
    .command('respond')
    .description('Respond to an event invitation')
    .argument('<calendar-id>', 'Calendar ID')
    .argument('<event-id>', 'Event ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--status <status>', 'Response: accepted, declined, tentative')
    .option('--comment <text>', 'Optional comment')
    .action(async (calendarId: string, eventId: string, options) => {
      try {
        const status = options.status.toLowerCase();
        if (!['accepted', 'declined', 'tentative'].includes(status)) {
          throw new CliError('INVALID_PARAMS', `Invalid status: ${options.status}`, 'Use: accepted, declined, or tentative');
        }

        const { client, profile } = await getGCalClient(options.profile);
        await enforceWriteAccess('gcal', profile, 'respond to event');
        const event = await client.respond({
          calendarId,
          eventId,
          status: status as 'accepted' | 'declined' | 'tentative',
          comment: options.comment,
        });
        console.log(`Response updated: ${status}`);
        console.log(`Event: ${event.summary || '(no title)'}`);
        if (event.htmlLink) console.log(`Link: ${event.htmlLink}`);
      } catch (error) {
        handleError(error);
      }
    });

  // Free/busy query
  gcal
    .command('freebusy')
    .description('Get free/busy information')
    .argument('<calendar-ids>', 'Comma-separated calendar IDs')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--from <datetime>', 'Start time (RFC3339)')
    .requiredOption('--to <datetime>', 'End time (RFC3339)')
    .action(async (calendarIds: string, options) => {
      try {
        const ids = calendarIds.split(',').map((id) => id.trim()).filter(Boolean);
        if (ids.length === 0) {
          throw new CliError('INVALID_PARAMS', 'At least one calendar ID is required');
        }

        const { client } = await getGCalClient(options.profile);
        const result = await client.freeBusy({
          calendarIds: ids,
          timeMin: options.from,
          timeMax: options.to,
        });
        printGCalFreeBusy(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<{ email?: string }>(gcal, {
    service: 'gcal',
    displayName: 'Google Calendar',
    getExtraInfo: (credentials) => credentials?.email ? ` - ${credentials.email}` : '',
  });

  profile
    .command('add')
    .description('Add a new Google Calendar profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        console.error('Starting OAuth flow for Google Calendar...\n');

        const tokens = await performOAuthFlow('gcal');

        // Fetch the user's email
        let email: string;
        try {
          email = await fetchGoogleUserEmail(tokens.access_token);
        } catch (error) {
          throw new CliError('AUTH_FAILED', 'Could not fetch email from Calendar', 'Try again or specify --profile manually');
        }

        // Determine profile name: use explicit --profile, or email, or email-readonly if conflict
        let profileName: string;
        if (options.profile) {
          profileName = options.profile;
        } else if (options.readOnly && await getProfile('gcal', email)) {
          // Profile with email already exists, use -readonly suffix
          profileName = `${email}-readonly`;
        } else {
          profileName = email;
        }

        await setProfile('gcal', profileName, { readOnly: options.readOnly });
        await setCredentials('gcal', profileName, { ...tokens, email });

        console.log(`\nSuccess! Profile "${profileName}" configured.`);
        console.log(`   Email: ${email}`);
        if (options.readOnly) {
          console.log(`   Access: read-only`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
