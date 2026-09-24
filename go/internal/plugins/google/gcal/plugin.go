// Package gcal is the Google Calendar service.
package gcal

import (
	"context"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "gcal",
		DisplayName: "Google Calendar",
		Description: "Use when interacting with Google Calendar via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          setup,
			Validate:       validate,
			Reauthenticate: google.Reauthenticate("gcal", google.Snake),
			Refresh:        google.Snake.RefreshSpec(),
			ListInfo:       listInfo,
		},
		Commands: []plugins.CommandSpec{
			calendarsCmd(), eventsCmd(), getCmd(), createCmd(), updateCmd(),
			deleteCmd(), searchCmd(), respondCmd(), freebusyCmd(),
		},
	}
}

func setup(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("Starting OAuth flow for Google Calendar...\n")
	tokens, err := google.PerformOAuth(ctx, setup, "gcal")
	if err != nil {
		return nil, err
	}
	email, err := google.FetchUserEmail(ctx, setup.Fetch, tokens.AccessToken)
	if err != nil {
		return nil, setup.Fail("AUTH_FAILED", "Could not fetch email from Calendar", "Try again or specify --profile manually")
	}
	creds := google.Snake.Merge(nil, tokens)
	creds["email"] = email
	return &plugins.SetupResult{Credentials: creds, SuggestedProfileName: email, Info: "Email: " + email}, nil
}

// validate is GCalClient.validate: the primary calendar's id is the account.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	svc, err := service(ctx, run)
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	entry, err := svc.CalendarList.Get("primary").Context(ctx).Do()
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	info := entry.Id
	if info == "" {
		info = "me"
	}
	return plugins.ValidationResult{Valid: true, Info: info}, nil
}

func listInfo(creds map[string]any) string {
	if email, _ := creds["email"].(string); email != "" {
		return " - " + email
	}
	return ""
}

func opt(in plugins.CommandInput, name string) string {
	s, _ := in.Options[name].(string)
	return s
}

func flag(in plugins.CommandInput, name string) bool {
	b, _ := in.Options[name].(bool)
	return b
}

func list(in plugins.CommandInput, name string) []string {
	values, _ := in.Options[name].([]string)
	return values
}

func arg(in plugins.CommandInput, name string) string {
	s, _ := in.Args[name].(string)
	return s
}

// piped is Bun `options.description` falling back to trimmed stdin.
func piped(value string, stdin any) string {
	if value != "" {
		return value
	}
	text, _ := stdin.(string)
	return strings.TrimSpace(text)
}

// transparency is Bun's --show-as mapping.
func transparency(showAs string) string {
	switch showAs {
	case "free":
		return "transparent"
	case "busy":
		return "opaque"
	default:
		return ""
	}
}

func orPrimary(id string) string {
	if id == "" {
		return "primary"
	}
	return id
}

func calendarsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "calendars",
		Description: "List available calendars",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Max results", DefaultValue: "100"},
		},
		Examples: []string{
			"# all calendars you have access to",
			"agentio gcal calendars",
			"# cap the result count",
			"agentio gcal calendars --limit 25",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.listCalendars(google.ParseInt(opt(in, "limit"))))
		},
		Format: formatCalendars,
	}
}

func eventsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "events",
		Aliases:     []string{"list"},
		Description: "List events from a calendar",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "calendar-id", Description: "Calendar ID (default: primary)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Max results", DefaultValue: "10"},
			{Flags: "--from <datetime>", Description: "Start time (RFC3339 or YYYY-MM-DD)"},
			{Flags: "--to <datetime>", Description: "End time (RFC3339 or YYYY-MM-DD)"},
			{Flags: "--today", Description: "Show today's events only"},
			{Flags: "--tomorrow", Description: "Show tomorrow's events only"},
			{Flags: "--days <n>", Description: "Show events for next N days"},
			{Flags: "--query <q>", Description: "Free text search query"},
		},
		Examples: []string{
			"# next 10 events on primary calendar",
			"agentio gcal events",
			"# today's events only",
			"agentio gcal events --today",
			"# next 7 days, more results",
			"agentio gcal events --days 7 --limit 50",
			"# specific calendar, free-text filter",
			`agentio gcal events team@example.com --query "standup"`,
			"# explicit date range",
			"agentio gcal events --from 2024-04-01 --to 2024-04-30",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			timeMin, timeMax := timeRange(in)
			return google.Result(a.listEvents(orPrimary(arg(in, "calendar-id")), google.ParseInt(opt(in, "limit")), timeMin, timeMax, opt(in, "query")))
		},
		Format: formatEventList,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Aliases:     []string{"event"},
		Description: "Get a single event",
		Access:      "read",
		Arguments: []plugins.ArgumentSpec{
			{Name: "calendar-id", Description: "Calendar ID", Required: true},
			{Name: "event-id", Description: "Event ID", Required: true},
		},
		Examples: []string{
			"# event on primary calendar",
			"agentio gcal get primary abc123def456",
			"# event on a shared calendar",
			"agentio gcal get team@example.com abc123def456",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.getEvent(arg(in, "calendar-id"), arg(in, "event-id")))
		},
		Format: formatEvent,
	}
}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a new event",
		Access:      "write",
		Operation:   "create event",
		Input:       "text",
		Arguments:   []plugins.ArgumentSpec{{Name: "calendar-id", Description: "Calendar ID (default: primary)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--summary <title>", Description: "Event title/summary"},
			{Flags: "--from <datetime>", Description: "Start time (RFC3339 or YYYY-MM-DD for all-day)"},
			{Flags: "--to <datetime>", Description: "End time (RFC3339 or YYYY-MM-DD for all-day)"},
			{Flags: "--description <text>", Description: "Event description (or pipe via stdin)"},
			{Flags: "--location <place>", Description: "Event location"},
			{Flags: "--all-day", Description: "Create as all-day event"},
			{Flags: "--attendee <email>", Description: "Attendee email (repeatable)", Repeatable: true},
			{Flags: "--rrule <rule>", Description: "Recurrence rule (repeatable, e.g., RRULE:FREQ=WEEKLY;BYDAY=MO)", Repeatable: true},
			{Flags: "--reminder <spec>", Description: "Reminder as method:minutes (repeatable, e.g., popup:30, email:1440)", Repeatable: true},
			{Flags: "--color <id>", Description: "Color ID (1-11)"},
			{Flags: "--visibility <v>", Description: "Visibility: default, public, private, confidential"},
			{Flags: "--show-as <v>", Description: "Show as: busy, free"},
			{Flags: "--send-updates <mode>", Description: "Send notifications: all, externalOnly, none", DefaultValue: "all"},
			{Flags: "--with-meet", Description: "Create Google Meet link"},
		},
		Examples: []string{
			"# 1-hour timed meeting on primary calendar",
			`agentio gcal create --summary "Sync" --from 2024-04-15T14:00:00-07:00 --to 2024-04-15T15:00:00-07:00`,
			"# all-day event with location and attendees",
			`agentio gcal create --summary "Offsite" --from 2024-05-10 --to 2024-05-11 --all-day \`,
			`  --location "Lake Tahoe" --attendee alice@example.com --attendee bob@example.com`,
			"# weekly recurring 30-min standup with a Meet link and a 10-min popup reminder",
			`agentio gcal create --summary "Standup" --from 2024-04-15T09:00:00-07:00 --to 2024-04-15T09:30:00-07:00 \`,
			`  --rrule "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR" --reminder popup:10 --with-meet`,
			"# private event on a specific calendar, no notifications",
			`agentio gcal create team@example.com --summary "1:1" --from 2024-04-15T10:00:00-07:00 \`,
			`  --to 2024-04-15T10:30:00-07:00 --visibility private --send-updates none`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := google.RequireOptions(in, run, "--summary <title>", "--from <datetime>", "--to <datetime>"); err != nil {
				return nil, err
			}
			reminders, err := parseReminders(list(in, "reminder"), run)
			if err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.createEvent(createOptions{
				calendarID:   orPrimary(arg(in, "calendar-id")),
				summary:      opt(in, "summary"),
				description:  piped(opt(in, "description"), in.Stdin),
				location:     opt(in, "location"),
				start:        opt(in, "from"),
				end:          opt(in, "to"),
				allDay:       flag(in, "all-day"),
				attendees:    list(in, "attendee"),
				recurrence:   list(in, "rrule"),
				reminders:    reminders,
				colorID:      opt(in, "color"),
				visibility:   opt(in, "visibility"),
				transparency: transparency(opt(in, "show-as")),
				sendUpdates:  opt(in, "send-updates"),
				withMeet:     flag(in, "with-meet"),
			}))
		},
		Format: formatEventCreated,
	}
}

func updateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "update",
		Description: "Update an existing event",
		Access:      "write",
		Operation:   "update event",
		Input:       "text",
		Arguments: []plugins.ArgumentSpec{
			{Name: "calendar-id", Description: "Calendar ID", Required: true},
			{Name: "event-id", Description: "Event ID", Required: true},
		},
		Options: []plugins.OptionSpec{
			{Flags: "--summary <title>", Description: "New event title/summary"},
			{Flags: "--from <datetime>", Description: "New start time"},
			{Flags: "--to <datetime>", Description: "New end time"},
			{Flags: "--description <text>", Description: "New description (or pipe via stdin)"},
			{Flags: "--location <place>", Description: "New location"},
			{Flags: "--all-day", Description: "Convert to all-day event"},
			{Flags: "--attendee <email>", Description: "Replace attendees (repeatable)", Repeatable: true},
			{Flags: "--add-attendee <email>", Description: "Add attendee (repeatable)", Repeatable: true},
			{Flags: "--color <id>", Description: "New color ID (1-11)"},
			{Flags: "--visibility <v>", Description: "Visibility: default, public, private, confidential"},
			{Flags: "--show-as <v>", Description: "Show as: busy, free"},
			{Flags: "--send-updates <mode>", Description: "Send notifications: all, externalOnly, none", DefaultValue: "all"},
		},
		Examples: []string{
			"# rename an event",
			`agentio gcal update primary abc123def456 --summary "Renamed sync"`,
			"# reschedule",
			`agentio gcal update primary abc123def456 \`,
			`  --from 2024-04-15T15:00:00-07:00 --to 2024-04-15T16:00:00-07:00`,
			"# add an attendee without dropping existing ones (silent)",
			"agentio gcal update primary abc123def456 --add-attendee carol@example.com --send-updates none",
			"# mark as free time",
			"agentio gcal update primary abc123def456 --show-as free",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if len(list(in, "attendee")) > 0 && len(list(in, "add-attendee")) > 0 {
				return nil, run.Fail("INVALID_PARAMS", "Cannot use both --attendee and --add-attendee", "")
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.updateEvent(updateOptions{
				calendarID:   arg(in, "calendar-id"),
				eventID:      arg(in, "event-id"),
				summary:      opt(in, "summary"),
				description:  piped(opt(in, "description"), in.Stdin),
				location:     opt(in, "location"),
				start:        opt(in, "from"),
				end:          opt(in, "to"),
				allDay:       flag(in, "all-day"),
				attendees:    list(in, "attendee"),
				addAttendees: list(in, "add-attendee"),
				colorID:      opt(in, "color"),
				visibility:   opt(in, "visibility"),
				transparency: transparency(opt(in, "show-as")),
				sendUpdates:  opt(in, "send-updates"),
			}))
		},
		Format: formatEvent,
	}
}

func deleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "delete",
		Description: "Delete an event",
		Access:      "write",
		Operation:   "delete event",
		Arguments: []plugins.ArgumentSpec{
			{Name: "calendar-id", Description: "Calendar ID", Required: true},
			{Name: "event-id", Description: "Event ID", Required: true},
		},
		Options: []plugins.OptionSpec{
			{Flags: "--send-updates <mode>", Description: "Send notifications: all, externalOnly, none", DefaultValue: "all"},
		},
		Examples: []string{
			"# delete and notify all attendees",
			"agentio gcal delete primary abc123def456",
			"# delete silently (no email)",
			"agentio gcal delete primary abc123def456 --send-updates none",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			calendarID, eventID := arg(in, "calendar-id"), arg(in, "event-id")
			if err := a.deleteEvent(calendarID, eventID, opt(in, "send-updates")); err != nil {
				return nil, err
			}
			return deleted{CalendarID: calendarID, EventID: eventID}, nil
		},
		Format: formatDeleted,
	}
}

func searchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "search",
		Description: "Search events",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "query", Description: "Search query", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--calendar <id>", Description: "Calendar ID", DefaultValue: "primary"},
			{Flags: "--limit <n>", Description: "Max results", DefaultValue: "25"},
			{Flags: "--from <datetime>", Description: "Start time (RFC3339)"},
			{Flags: "--to <datetime>", Description: "End time (RFC3339)"},
		},
		Examples: []string{
			"# search primary calendar (default range: -30d to +90d)",
			`agentio gcal search "standup"`,
			"# search a specific calendar with a custom range",
			`agentio gcal search "interview" --calendar team@example.com \`,
			`  --from 2024-04-01T00:00:00Z --to 2024-05-01T00:00:00Z`,
			"# broaden the result count",
			`agentio gcal search "1:1" --limit 100`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			// Default search range: 30 days past to 90 days future.
			t := now()
			timeMin, timeMax := opt(in, "from"), opt(in, "to")
			if timeMin == "" {
				timeMin = google.ISOString(addDays(t, -30))
			}
			if timeMax == "" {
				timeMax = google.ISOString(addDays(t, 90))
			}
			return google.Result(a.listEvents(opt(in, "calendar"), google.ParseInt(opt(in, "limit")), timeMin, timeMax, arg(in, "query")))
		},
		Format: formatEventList,
	}
}

func respondCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "respond",
		Description: "Respond to an event invitation",
		Access:      "write",
		Operation:   "respond to event",
		Arguments: []plugins.ArgumentSpec{
			{Name: "calendar-id", Description: "Calendar ID", Required: true},
			{Name: "event-id", Description: "Event ID", Required: true},
		},
		Options: []plugins.OptionSpec{
			{Flags: "--status <status>", Description: "Response: accepted, declined, tentative"},
			{Flags: "--comment <text>", Description: "Optional comment"},
		},
		Examples: []string{
			"# accept an invitation",
			"agentio gcal respond primary abc123def456 --status accepted",
			"# decline with a comment",
			`agentio gcal respond primary abc123def456 --status declined --comment "Out of office"`,
			"# tentative",
			"agentio gcal respond primary abc123def456 --status tentative",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := google.RequireOptions(in, run, "--status <status>"); err != nil {
				return nil, err
			}
			status := strings.ToLower(opt(in, "status"))
			switch status {
			case "accepted", "declined", "tentative":
			default:
				return nil, run.Fail("INVALID_PARAMS", "Invalid status: "+opt(in, "status"), "Use: accepted, declined, or tentative")
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			ev, err := a.respond(arg(in, "calendar-id"), arg(in, "event-id"), status, opt(in, "comment"))
			if err != nil {
				return nil, err
			}
			return responded{Status: status, Event: *ev}, nil
		},
		Format: formatResponded,
	}
}

func freebusyCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "freebusy",
		Description: "Get free/busy information",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "calendar-ids", Description: "Comma-separated calendar IDs", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--from <datetime>", Description: "Start time (RFC3339)"},
			{Flags: "--to <datetime>", Description: "End time (RFC3339)"},
		},
		Examples: []string{
			"# your own busy slots over a day",
			"agentio gcal freebusy primary --from 2024-04-15T00:00:00Z --to 2024-04-16T00:00:00Z",
			"# find a meeting slot across two attendees",
			`agentio gcal freebusy alice@example.com,bob@example.com \`,
			`  --from 2024-04-15T09:00:00-07:00 --to 2024-04-15T18:00:00-07:00`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := google.RequireOptions(in, run, "--from <datetime>", "--to <datetime>"); err != nil {
				return nil, err
			}
			var ids []string
			for _, id := range strings.Split(arg(in, "calendar-ids"), ",") {
				if id = strings.TrimSpace(id); id != "" {
					ids = append(ids, id)
				}
			}
			if len(ids) == 0 {
				return nil, run.Fail("INVALID_PARAMS", "At least one calendar ID is required", "")
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.freeBusy(ids, opt(in, "from"), opt(in, "to")))
		},
		Format: formatFreeBusy,
	}
}
