package gcal

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins/google"
)

func when(d eventDateTime) string {
	if d.DateTime != "" {
		return d.DateTime
	}
	return d.Date
}

func title(e event) string {
	if e.Summary == "" {
		return "(no title)"
	}
	return e.Summary
}

// formatCalendars is printGCalCalendarList.
func formatCalendars(v any) string {
	calendars, _ := v.([]calendarEntry)
	if len(calendars) == 0 {
		return "No calendars found"
	}
	lines := []string{fmt.Sprintf("Calendars (%d)", len(calendars)), ""}
	for i, c := range calendars {
		badge := ""
		if c.Primary {
			badge = " [primary]"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s", i+1, c.Summary, badge), "    ID: "+c.ID, "    Role: "+c.AccessRole)
		if c.TimeZone != "" {
			lines = append(lines, "    Timezone: "+c.TimeZone)
		}
		if c.Description != "" {
			lines = append(lines, "    > "+google.Truncate(c.Description, 80))
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// formatEventList is printGCalEventList.
func formatEventList(v any) string {
	list, _ := v.(*eventList)
	if list == nil || len(list.Events) == 0 {
		return "No events found"
	}
	lines := []string{fmt.Sprintf("Events (%d)", len(list.Events)), ""}
	for i, e := range list.Events {
		lines = append(lines,
			fmt.Sprintf("[%d] %s", i+1, e.ID),
			"    "+title(e),
			"    Start: "+when(e.Start),
			"    End: "+when(e.End),
		)
		if e.Location != "" {
			lines = append(lines, "    Location: "+e.Location)
		}
		if e.Attendees != nil && len(*e.Attendees) > 0 {
			lines = append(lines, fmt.Sprintf("    Attendees: %d", len(*e.Attendees)))
		}
		if e.HangoutLink != "" {
			lines = append(lines, "    Meet: "+e.HangoutLink)
		}
		lines = append(lines, "")
	}
	if list.NextPageToken != "" {
		lines = append(lines, fmt.Sprintf("(more results available, use --page %s)", list.NextPageToken))
	}
	return strings.Join(lines, "\n")
}

// formatEvent is printGCalEvent.
func formatEvent(v any) string {
	e, _ := v.(*event)
	if e == nil {
		return ""
	}
	return strings.Join(eventLines(*e), "\n")
}

func eventLines(e event) []string {
	lines := []string{"ID: " + e.ID, "Summary: " + title(e)}
	if e.EventType != "" && e.EventType != "default" {
		lines = append(lines, "Type: "+e.EventType)
	}
	lines = append(lines, "Start: "+when(e.Start), "End: "+when(e.End))
	if e.Start.TimeZone != "" {
		lines = append(lines, "Timezone: "+e.Start.TimeZone)
	}
	if e.Location != "" {
		lines = append(lines, "Location: "+e.Location)
	}
	if e.Description != "" {
		lines = append(lines, "Description: "+e.Description)
	}
	if e.ColorID != "" {
		lines = append(lines, "Color: "+e.ColorID)
	}
	if e.Visibility != "" && e.Visibility != "default" {
		lines = append(lines, "Visibility: "+e.Visibility)
	}
	if e.Transparency == "transparent" {
		lines = append(lines, "Show as: free")
	}
	if e.Attendees != nil && len(*e.Attendees) > 0 {
		lines = append(lines, "", fmt.Sprintf("Attendees (%d):", len(*e.Attendees)))
		for _, a := range *e.Attendees {
			status := a.ResponseStatus
			if status == "" {
				status = "unknown"
			}
			var tags string
			if a.Optional {
				tags += " (optional)"
			}
			if a.Organizer {
				tags += " [organizer]"
			}
			if a.Self {
				tags += " [you]"
			}
			lines = append(lines, fmt.Sprintf("  %s - %s%s", a.Email, status, tags))
		}
	}
	if e.Recurrence != nil && len(*e.Recurrence) > 0 {
		lines = append(lines, "Recurrence: "+strings.Join(*e.Recurrence, "; "))
	}
	if e.Reminders != nil {
		if e.Reminders.UseDefault {
			lines = append(lines, "Reminders: (calendar default)")
		} else if e.Reminders.Overrides != nil && len(*e.Reminders.Overrides) > 0 {
			var parts []string
			for _, r := range *e.Reminders.Overrides {
				parts = append(parts, fmt.Sprintf("%s:%dm", r.Method, r.Minutes))
			}
			lines = append(lines, "Reminders: "+strings.Join(parts, ", "))
		}
	}
	if e.HangoutLink != "" {
		lines = append(lines, "Meet: "+e.HangoutLink)
	}
	if e.ConferenceData != nil && e.ConferenceData.EntryPoints != nil {
		for _, ep := range *e.ConferenceData.EntryPoints {
			if ep.EntryPointType == "video" {
				lines = append(lines, "Video: "+ep.URI)
			}
		}
	}
	if e.HTMLLink != "" {
		lines = append(lines, "Link: "+e.HTMLLink)
	}
	return lines
}

// formatEventCreated is printGCalEventCreated.
func formatEventCreated(v any) string {
	e, _ := v.(*event)
	if e == nil {
		return ""
	}
	lines := []string{"Event created", "ID: " + e.ID, "Summary: " + title(*e), "Start: " + when(e.Start), "End: " + when(e.End)}
	if e.HangoutLink != "" {
		lines = append(lines, "Meet: "+e.HangoutLink)
	}
	if e.HTMLLink != "" {
		lines = append(lines, "Link: "+e.HTMLLink)
	}
	return strings.Join(lines, "\n")
}

// formatDeleted is printGCalEventDeleted.
func formatDeleted(v any) string {
	d, _ := v.(deleted)
	return strings.Join([]string{"Event deleted", "Calendar: " + d.CalendarID, "Event ID: " + d.EventID}, "\n")
}

// formatResponded is the respond command's three console.log lines.
func formatResponded(v any) string {
	r, _ := v.(responded)
	lines := []string{"Response updated: " + r.Status, "Event: " + title(r.Event)}
	if r.Event.HTMLLink != "" {
		lines = append(lines, "Link: "+r.Event.HTMLLink)
	}
	return strings.Join(lines, "\n")
}

// formatFreeBusy is printGCalFreeBusy.
func formatFreeBusy(v any) string {
	fb, _ := v.(*freeBusy)
	if fb == nil || len(fb.Calendars) == 0 {
		return "No free/busy data"
	}
	lines := []string{"Free/Busy Information", ""}
	for _, c := range fb.Calendars {
		lines = append(lines, "Calendar: "+c.ID)
		if c.Errors != nil {
			for _, e := range *c.Errors {
				lines = append(lines, "  Error: "+e.Reason)
			}
		}
		if len(c.Busy) == 0 {
			lines = append(lines, "  (no busy periods)")
		}
		for _, b := range c.Busy {
			lines = append(lines, fmt.Sprintf("  Busy: %s - %s", b.Start, b.End))
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}
