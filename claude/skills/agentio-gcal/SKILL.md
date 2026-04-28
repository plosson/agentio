---
name: agentio-gcal
description: Use when interacting with Google Calendar via the agentio CLI.
---

# Gcal via agentio

Auto-generated from `agentio skill gcal`. Do not edit by hand.

## agentio gcal calendars

List available calendars

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Max results (default: 100)

```
Examples:

  # all calendars you have access to
  agentio gcal calendars

  # cap the result count
  agentio gcal calendars --limit 25
```

## agentio gcal events [calendar-id]

List events from a calendar

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Max results (default: 10)
- `--from <datetime>`: Start time (RFC3339 or YYYY-MM-DD)
- `--to <datetime>`: End time (RFC3339 or YYYY-MM-DD)
- `--today`: Show today's events only
- `--tomorrow`: Show tomorrow's events only
- `--days <n>`: Show events for next N days
- `--query <q>`: Free text search query

```
Examples:

  # next 10 events on primary calendar
  agentio gcal events

  # today's events only
  agentio gcal events --today

  # next 7 days, more results
  agentio gcal events --days 7 --limit 50

  # specific calendar, free-text filter
  agentio gcal events team@example.com --query "standup"

  # explicit date range
  agentio gcal events --from 2024-04-01 --to 2024-04-30
```

## agentio gcal get <calendar-id> <event-id>

Get a single event

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # event on primary calendar
  agentio gcal get primary abc123def456

  # event on a shared calendar
  agentio gcal get team@example.com abc123def456
```

## agentio gcal create [calendar-id]

Create a new event

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--summary <title>`: Event title/summary
- `--from <datetime>`: Start time (RFC3339 or YYYY-MM-DD for all-day)
- `--to <datetime>`: End time (RFC3339 or YYYY-MM-DD for all-day)
- `--description <text>`: Event description (or pipe via stdin)
- `--location <place>`: Event location
- `--all-day`: Create as all-day event
- `--attendee <email>`: Attendee email (repeatable) (default: )
- `--rrule <rule>`: Recurrence rule (repeatable, e.g., RRULE:FREQ=WEEKLY;BYDAY=MO) (default: )
- `--reminder <spec>`: Reminder as method:minutes (repeatable, e.g., popup:30, email:1440) (default: )
- `--color <id>`: Color ID (1-11)
- `--visibility <v>`: Visibility: default, public, private, confidential
- `--show-as <v>`: Show as: busy, free
- `--send-updates <mode>`: Send notifications: all, externalOnly, none (default: all)
- `--with-meet`: Create Google Meet link

```
Examples:

  # 1-hour timed meeting on primary calendar
  agentio gcal create --summary "Sync" --from 2024-04-15T14:00:00-07:00 --to 2024-04-15T15:00:00-07:00

  # all-day event with location and attendees
  agentio gcal create --summary "Offsite" --from 2024-05-10 --to 2024-05-11 --all-day \
    --location "Lake Tahoe" --attendee alice@example.com --attendee bob@example.com

  # weekly recurring 30-min standup with a Meet link and a 10-min popup reminder
  agentio gcal create --summary "Standup" --from 2024-04-15T09:00:00-07:00 --to 2024-04-15T09:30:00-07:00 \
    --rrule "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR" --reminder popup:10 --with-meet

  # private event on a specific calendar, no notifications
  agentio gcal create team@example.com --summary "1:1" --from 2024-04-15T10:00:00-07:00 \
    --to 2024-04-15T10:30:00-07:00 --visibility private --send-updates none
```

## agentio gcal update <calendar-id> <event-id>

Update an existing event

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--summary <title>`: New event title/summary
- `--from <datetime>`: New start time
- `--to <datetime>`: New end time
- `--description <text>`: New description (or pipe via stdin)
- `--location <place>`: New location
- `--all-day`: Convert to all-day event
- `--attendee <email>`: Replace attendees (repeatable) (default: )
- `--add-attendee <email>`: Add attendee (repeatable) (default: )
- `--color <id>`: New color ID (1-11)
- `--visibility <v>`: Visibility: default, public, private, confidential
- `--show-as <v>`: Show as: busy, free
- `--send-updates <mode>`: Send notifications: all, externalOnly, none (default: all)

```
Examples:

  # rename an event
  agentio gcal update primary abc123def456 --summary "Renamed sync"

  # reschedule
  agentio gcal update primary abc123def456 \
    --from 2024-04-15T15:00:00-07:00 --to 2024-04-15T16:00:00-07:00

  # add an attendee without dropping existing ones (silent)
  agentio gcal update primary abc123def456 --add-attendee carol@example.com --send-updates none

  # mark as free time
  agentio gcal update primary abc123def456 --show-as free
```

## agentio gcal delete <calendar-id> <event-id>

Delete an event

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--send-updates <mode>`: Send notifications: all, externalOnly, none (default: all)

```
Examples:

  # delete and notify all attendees
  agentio gcal delete primary abc123def456

  # delete silently (no email)
  agentio gcal delete primary abc123def456 --send-updates none
```

## agentio gcal search <query>

Search events

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--calendar <id>`: Calendar ID (default: primary)
- `--limit <n>`: Max results (default: 25)
- `--from <datetime>`: Start time (RFC3339)
- `--to <datetime>`: End time (RFC3339)

```
Examples:

  # search primary calendar (default range: -30d to +90d)
  agentio gcal search "standup"

  # search a specific calendar with a custom range
  agentio gcal search "interview" --calendar team@example.com \
    --from 2024-04-01T00:00:00Z --to 2024-05-01T00:00:00Z

  # broaden the result count
  agentio gcal search "1:1" --limit 100
```

## agentio gcal respond <calendar-id> <event-id>

Respond to an event invitation

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--status <status>`: Response: accepted, declined, tentative
- `--comment <text>`: Optional comment

```
Examples:

  # accept an invitation
  agentio gcal respond primary abc123def456 --status accepted

  # decline with a comment
  agentio gcal respond primary abc123def456 --status declined --comment "Out of office"

  # tentative
  agentio gcal respond primary abc123def456 --status tentative
```

## agentio gcal freebusy <calendar-ids>

Get free/busy information

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--from <datetime>`: Start time (RFC3339)
- `--to <datetime>`: End time (RFC3339)

```
Examples:

  # your own busy slots over a day
  agentio gcal freebusy primary --from 2024-04-15T00:00:00Z --to 2024-04-16T00:00:00Z

  # find a meeting slot across two attendees
  agentio gcal freebusy alice@example.com,bob@example.com \
    --from 2024-04-15T09:00:00-07:00 --to 2024-04-15T18:00:00-07:00
```

