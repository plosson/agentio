package gcal

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// The printers read the Bun objects the client builds (see parseEvent), as
// Bun's template strings do: a missing field prints "undefined".

// when is getEventDateTime: dt.dateTime, else dt.date, else "".
func when(dt any) string {
	return jsvalue.String(jsvalue.Or(jsvalue.Or(jsvalue.Member(dt, "dateTime"), jsvalue.Member(dt, "date")), ""))
}

// title is `event.summary || '(no title)'`.
func title(e any) string {
	return jsvalue.String(jsvalue.Or(jsvalue.Member(e, "summary"), "(no title)"))
}

// length is `v?.length` read for a truthiness test and a count.
func length(v any) int {
	n, _ := jsvalue.Optional(v, "length").(float64)
	return int(n)
}

// formatCalendars is printGCalCalendarList.
func formatCalendars(v any) string {
	calendars, _ := v.([]any)
	if len(calendars) == 0 {
		return "No calendars found"
	}
	lines := []string{fmt.Sprintf("Calendars (%d)", len(calendars)), ""}
	for i, c := range calendars {
		badge := ""
		if google.Truthy(c, "primary") {
			badge = " [primary]"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s", i+1, google.Field(c, "summary"), badge),
			"    ID: "+google.Field(c, "id"), "    Role: "+google.Field(c, "accessRole"))
		if google.Truthy(c, "timeZone") {
			lines = append(lines, "    Timezone: "+google.Field(c, "timeZone"))
		}
		if google.Truthy(c, "description") {
			lines = append(lines, "    > "+jsvalue.Truncate(google.Field(c, "description"), 80))
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// formatEventList is printGCalEventList.
func formatEventList(v any) string {
	events, _ := jsvalue.Member(v, "events").([]any)
	if len(events) == 0 {
		return "No events found"
	}
	lines := []string{fmt.Sprintf("Events (%d)", len(events)), ""}
	for i, e := range events {
		lines = append(lines,
			fmt.Sprintf("[%d] %s", i+1, google.Field(e, "id")),
			"    "+title(e),
			"    Start: "+when(jsvalue.Member(e, "start")),
			"    End: "+when(jsvalue.Member(e, "end")),
		)
		if google.Truthy(e, "location") {
			lines = append(lines, "    Location: "+google.Field(e, "location"))
		}
		if n := length(jsvalue.Member(e, "attendees")); n > 0 {
			lines = append(lines, fmt.Sprintf("    Attendees: %d", n))
		}
		if google.Truthy(e, "hangoutLink") {
			lines = append(lines, "    Meet: "+google.Field(e, "hangoutLink"))
		}
		lines = append(lines, "")
	}
	if google.Truthy(v, "nextPageToken") {
		lines = append(lines, fmt.Sprintf("(more results available, use --page %s)", google.Field(v, "nextPageToken")))
	}
	return strings.Join(lines, "\n")
}

// formatEvent is printGCalEvent.
func formatEvent(v any) string {
	return strings.Join(eventLines(v), "\n")
}

func eventLines(e any) []string {
	get := func(k string) any { return jsvalue.Member(e, k) }
	lines := []string{"ID: " + google.Field(e, "id"), "Summary: " + title(e)}
	if google.Truthy(e, "eventType") && !jsvalue.StrictEqual(get("eventType"), "default") {
		lines = append(lines, "Type: "+google.Field(e, "eventType"))
	}
	lines = append(lines, "Start: "+when(get("start")), "End: "+when(get("end")))
	if google.Truthy(get("start"), "timeZone") {
		lines = append(lines, "Timezone: "+google.Field(get("start"), "timeZone"))
	}
	for _, f := range []struct{ label, key string }{{"Location", "location"}, {"Description", "description"}, {"Color", "colorId"}} {
		if google.Truthy(e, f.key) {
			lines = append(lines, f.label+": "+google.Field(e, f.key))
		}
	}
	if google.Truthy(e, "visibility") && !jsvalue.StrictEqual(get("visibility"), "default") {
		lines = append(lines, "Visibility: "+google.Field(e, "visibility"))
	}
	if jsvalue.StrictEqual(get("transparency"), "transparent") {
		lines = append(lines, "Show as: free")
	}
	if attendees, _ := get("attendees").([]any); len(attendees) > 0 {
		lines = append(lines, "", fmt.Sprintf("Attendees (%d):", len(attendees)))
		for _, a := range attendees {
			status := jsvalue.String(jsvalue.Or(jsvalue.Member(a, "responseStatus"), "unknown"))
			var tags string
			if google.Truthy(a, "optional") {
				tags += " (optional)"
			}
			if google.Truthy(a, "organizer") {
				tags += " [organizer]"
			}
			if google.Truthy(a, "self") {
				tags += " [you]"
			}
			lines = append(lines, fmt.Sprintf("  %s - %s%s", google.Field(a, "email"), status, tags))
		}
	}
	if recurrence, _ := get("recurrence").([]any); len(recurrence) > 0 {
		lines = append(lines, "Recurrence: "+jsvalue.Join(recurrence, "; "))
	}
	if r := get("reminders"); jsvalue.Truthy(r) {
		if google.Truthy(r, "useDefault") {
			lines = append(lines, "Reminders: (calendar default)")
		} else if overrides, _ := jsvalue.Member(r, "overrides").([]any); len(overrides) > 0 {
			var parts []any
			for _, o := range overrides {
				parts = append(parts, google.Field(o, "method")+":"+google.Field(o, "minutes")+"m")
			}
			lines = append(lines, "Reminders: "+jsvalue.Join(parts, ", "))
		}
	}
	if google.Truthy(e, "hangoutLink") {
		lines = append(lines, "Meet: "+google.Field(e, "hangoutLink"))
	}
	if entryPoints, _ := jsvalue.Optional(get("conferenceData"), "entryPoints").([]any); len(entryPoints) > 0 {
		for _, ep := range entryPoints {
			if jsvalue.StrictEqual(jsvalue.Member(ep, "entryPointType"), "video") {
				lines = append(lines, "Video: "+google.Field(ep, "uri"))
			}
		}
	}
	if google.Truthy(e, "htmlLink") {
		lines = append(lines, "Link: "+google.Field(e, "htmlLink"))
	}
	return lines
}

// formatEventCreated is printGCalEventCreated.
func formatEventCreated(e any) string {
	lines := []string{"Event created", "ID: " + google.Field(e, "id"), "Summary: " + title(e),
		"Start: " + when(jsvalue.Member(e, "start")), "End: " + when(jsvalue.Member(e, "end"))}
	if google.Truthy(e, "hangoutLink") {
		lines = append(lines, "Meet: "+google.Field(e, "hangoutLink"))
	}
	if google.Truthy(e, "htmlLink") {
		lines = append(lines, "Link: "+google.Field(e, "htmlLink"))
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
	if google.Truthy(r.Event, "htmlLink") {
		lines = append(lines, "Link: "+google.Field(r.Event, "htmlLink"))
	}
	return strings.Join(lines, "\n")
}

// formatFreeBusy is printGCalFreeBusy.
func formatFreeBusy(v any) string {
	calendars, _ := jsvalue.Member(v, "calendars").(*jsvalue.Object)
	if calendars.Len() == 0 {
		return "No free/busy data"
	}
	lines := []string{"Free/Busy Information", ""}
	for _, id := range calendars.Keys() {
		data := calendars.Value(id)
		lines = append(lines, "Calendar: "+id)
		if errs, _ := jsvalue.Member(data, "errors").([]any); len(errs) > 0 {
			for _, e := range errs {
				lines = append(lines, "  Error: "+google.Field(e, "reason"))
			}
		}
		busy, _ := jsvalue.Member(data, "busy").([]any)
		if len(busy) == 0 {
			lines = append(lines, "  (no busy periods)")
		}
		for _, b := range busy {
			lines = append(lines, fmt.Sprintf("  Busy: %s - %s", google.Field(b, "start"), google.Field(b, "end")))
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}
