package gcal

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	calendar "google.golang.org/api/calendar/v3"
)

// now is the clock behind --today, --tomorrow, --days and the search range.
var now = time.Now

// The models are the Bun client's objects (GCalCalendar, GCalEvent, the
// event list and GCalFreeBusyResponse), built from the answer as JavaScript
// reads it (google.Answer): a field the answer lacks is undefined, and a null
// item fails with Bun's TypeError.

type deleted struct {
	CalendarID string `json:"calendarId"`
	EventID    string `json:"eventId"`
}

type responded struct {
	Status string          `json:"status"`
	Event  *jsvalue.Object `json:"event"`
}

// calendarOf is the GCalCalendar Bun builds from cal.
func calendarOf(cal any) (any, error) {
	if jsvalue.Nullish(cal) {
		return nil, jsvalue.TypeError(cal, "cal.id")
	}
	get := func(k string) any { return jsvalue.Member(cal, k) }
	return jsvalue.ObjectOf(
		"id", get("id"),
		"summary", jsvalue.Or(get("summary"), ""),
		"description", jsvalue.Or(get("description"), jsvalue.Undefined),
		"accessRole", jsvalue.Or(get("accessRole"), ""),
		"primary", jsvalue.Or(get("primary"), false),
		"timeZone", jsvalue.Or(get("timeZone"), jsvalue.Undefined),
	), nil
}

// optionalMap is `v?.map(f)`: undefined when v is null or undefined.
func optionalMap(v any, text string, f func(any) (any, error)) (any, error) {
	if jsvalue.Nullish(v) {
		return jsvalue.Undefined, nil
	}
	return jsvalue.Map(v, text+"?", f)
}

// or is `v || undefined`.
func or(v any) any { return jsvalue.Or(v, jsvalue.Undefined) }

// parseEvent is Bun parseEvent.
func parseEvent(event any) (any, error) {
	if jsvalue.Nullish(event) {
		return nil, jsvalue.TypeError(event, "event.id")
	}
	get := func(k string) any { return jsvalue.Member(event, k) }
	when := func(k string) *jsvalue.Object {
		d := get(k)
		return jsvalue.ObjectOf(
			"dateTime", or(jsvalue.Optional(d, "dateTime")),
			"date", or(jsvalue.Optional(d, "date")),
			"timeZone", or(jsvalue.Optional(d, "timeZone")),
		)
	}
	person := func(k string) any {
		p := get(k)
		if !jsvalue.Truthy(p) {
			return jsvalue.Undefined
		}
		return jsvalue.ObjectOf("email", jsvalue.Member(p, "email"), "displayName", or(jsvalue.Member(p, "displayName")))
	}
	attendees, err := optionalMap(get("attendees"), "event.attendees", func(a any) (any, error) {
		if jsvalue.Nullish(a) {
			return nil, jsvalue.TypeError(a, "a.email")
		}
		m := func(k string) any { return jsvalue.Member(a, k) }
		return jsvalue.ObjectOf(
			"email", m("email"),
			"displayName", or(m("displayName")),
			"responseStatus", or(m("responseStatus")),
			"optional", or(m("optional")),
			"organizer", or(m("organizer")),
			"self", or(m("self")),
			"comment", or(m("comment")),
		), nil
	})
	if err != nil {
		return nil, err
	}
	reminders := jsvalue.Undefined
	if r := get("reminders"); jsvalue.Truthy(r) {
		overrides, err := optionalMap(jsvalue.Member(r, "overrides"), "event.reminders.overrides", func(o any) (any, error) {
			if jsvalue.Nullish(o) {
				return nil, jsvalue.TypeError(o, "r.method")
			}
			return jsvalue.ObjectOf("method", jsvalue.Member(o, "method"), "minutes", jsvalue.Member(o, "minutes")), nil
		})
		if err != nil {
			return nil, err
		}
		reminders = jsvalue.ObjectOf("useDefault", jsvalue.Or(jsvalue.Member(r, "useDefault"), false), "overrides", overrides)
	}
	conference := jsvalue.Undefined
	if c := get("conferenceData"); jsvalue.Truthy(c) {
		entryPoints, err := optionalMap(jsvalue.Member(c, "entryPoints"), "event.conferenceData.entryPoints", func(ep any) (any, error) {
			if jsvalue.Nullish(ep) {
				return nil, jsvalue.TypeError(ep, "ep.entryPointType")
			}
			return jsvalue.ObjectOf(
				"entryPointType", jsvalue.Member(ep, "entryPointType"),
				"uri", jsvalue.Member(ep, "uri"),
				"label", or(jsvalue.Member(ep, "label")),
			), nil
		})
		if err != nil {
			return nil, err
		}
		conference = jsvalue.ObjectOf("entryPoints", entryPoints)
	}
	return jsvalue.ObjectOf(
		"id", get("id"),
		"summary", or(get("summary")),
		"description", or(get("description")),
		"location", or(get("location")),
		"start", when("start"),
		"end", when("end"),
		"status", or(get("status")),
		"htmlLink", or(get("htmlLink")),
		"created", or(get("created")),
		"updated", or(get("updated")),
		"colorId", or(get("colorId")),
		"creator", person("creator"),
		"organizer", person("organizer"),
		"attendees", attendees,
		"recurrence", or(get("recurrence")),
		"recurringEventId", or(get("recurringEventId")),
		"transparency", or(get("transparency")),
		"visibility", or(get("visibility")),
		"reminders", reminders,
		"hangoutLink", or(get("hangoutLink")),
		"conferenceData", conference,
		"eventType", or(get("eventType")),
	), nil
}

// items is `(<data>.items || []).map(parse)`, data the expression Bun reports
// for response.data.
func items(raw any, data string, parse func(any) (any, error)) ([]any, error) {
	list, err := google.AnswerItems(raw, data, "items")
	if err != nil {
		return nil, err
	}
	return jsvalue.Map(list, "", parse)
}

// eventAnswer is `this.parseEvent(response.data)` inside a client method's
// try: a failure, the call's or parseEvent's, goes to fail.
func eventAnswer[C google.Call[C, *calendar.Event]](a *api, call C, fail func(error) error) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, call)
	if err != nil {
		return nil, fail(err)
	}
	e, err := parseEvent(raw)
	if err != nil {
		return nil, fail(err)
	}
	return e.(*jsvalue.Object), nil
}

// typedAttendees is the attendee list Bun sends back as it read it, as the
// SDK's type.
func typedAttendees(list []any) ([]*calendar.EventAttendee, error) {
	out := []*calendar.EventAttendee{}
	if err := json.Unmarshal(jsvalue.Stringify(list), &out); err != nil {
		return nil, err
	}
	return out, nil
}

type api struct {
	google.API
	svc *calendar.Service
}

func service(ctx context.Context, run *plugins.RunContext) (*calendar.Service, error) {
	return google.NewService(ctx, run, google.Snake, calendar.NewService)
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	svc, err := service(ctx, run)
	if err != nil {
		return nil, err
	}
	return &api{API: google.API{Ctx: ctx, RunContext: run}, svc: svc}, nil
}

// calendarListData is how Bun's build reports response.data in
// listCalendars, where the transpiler inlined the single-use response.
const calendarListData = "(await this.calendar.calendarList.list({\n        maxResults: Math.min(limit, 250)\n      })).data"

func (a *api) listCalendars(limit float64) ([]any, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.CalendarList.List(), google.MaxResults(limit, 250))
	if err == nil {
		var out []any
		if out, err = items(raw, calendarListData, calendarOf); err == nil {
			return out, nil
		}
	}
	return nil, a.APIError("Calendar API error", err)
}

func (a *api) listEvents(calendarID string, limit float64, timeMin, timeMax, query string) (*jsvalue.Object, error) {
	call := a.svc.Events.List(calendarID).SingleEvents(true).OrderBy("startTime")
	if timeMin != "" {
		call.TimeMin(timeMin)
	}
	if timeMax != "" {
		call.TimeMax(timeMax)
	}
	if query != "" {
		call.Q(query)
	}
	_, raw, err := google.Answer(a.Ctx, call, google.MaxResults(limit, 250))
	if err == nil {
		var events []any
		if events, err = items(raw, "response.data", parseEvent); err == nil {
			return jsvalue.ObjectOf("events", events, "nextPageToken", or(jsvalue.Member(raw, "nextPageToken"))), nil
		}
	}
	return nil, a.APIError("Calendar API error", err)
}

func (a *api) getEvent(calendarID, eventID string) (*jsvalue.Object, error) {
	return eventAnswer(a, a.svc.Events.Get(calendarID, eventID), func(err error) error {
		return a.NotFoundOr("Event", eventID, "Calendar API error", err)
	})
}

// createOptions and updateOptions carry in given the calendar.Event fields
// sent even when empty (givenFields).
type createOptions struct {
	given                                                  []string
	calendarID, summary, description, location, start, end string
	allDay                                                 bool
	attendees, recurrence                                  []string
	reminders                                              []*calendar.EventReminder
	colorID, visibility, transparency, sendUpdates         string
	withMeet                                               bool
}

func (a *api) createEvent(o createOptions) (*jsvalue.Object, error) {
	body := &calendar.Event{
		Summary:     o.summary,
		Description: o.description,
		Location:    o.location,
		Start:       dateTime(o.start, o.allDay),
		End:         dateTime(o.end, o.allDay),
		// Summary, Description and Location are sent even when empty.
		ForceSendFields: o.given,
	}
	for _, email := range o.attendees {
		body.Attendees = append(body.Attendees, &calendar.EventAttendee{Email: email})
	}
	if len(o.recurrence) > 0 {
		body.Recurrence = o.recurrence
	}
	if len(o.reminders) > 0 {
		body.Reminders = &calendar.EventReminders{Overrides: o.reminders, ForceSendFields: []string{"UseDefault"}}
	}
	body.ColorId = o.colorID
	body.Visibility = o.visibility
	body.Transparency = o.transparency
	call := a.svc.Events.Insert(o.calendarID, body).SendUpdates(o.sendUpdates)
	if o.withMeet {
		body.ConferenceData = &calendar.ConferenceData{CreateRequest: &calendar.CreateConferenceRequest{
			RequestId:             fmt.Sprintf("agentio-%d", now().UnixMilli()),
			ConferenceSolutionKey: &calendar.ConferenceSolutionKey{Type: "hangoutsMeet"},
		}}
		call.ConferenceDataVersion(1)
	}
	return eventAnswer(a, call, func(err error) error { return a.APIError("Failed to create event", err) })
}

type updateOptions struct {
	given                                                           []string
	calendarID, eventID, summary, description, location, start, end string
	allDay                                                          bool
	attendees, addAttendees                                         []string
	colorID, visibility, transparency, sendUpdates                  string
}

func (a *api) updateEvent(o updateOptions) (*jsvalue.Object, error) {
	fail := func(err error) error { return a.NotFoundOr("Event", o.eventID, "Failed to update event", err) }
	// existing.data.attendees || [], as Bun read it.
	existing := []any{}
	if len(o.addAttendees) > 0 {
		_, raw, err := google.Answer(a.Ctx, a.svc.Events.Get(o.calendarID, o.eventID))
		if err != nil {
			return nil, fail(err)
		}
		// Bun's build inlines the single-use `existing`.
		list, err := jsvalue.Path(raw, "(await this.calendar.events.get({ calendarId, eventId })).data", "attendees")
		if err != nil {
			return nil, fail(err)
		}
		if existing, err = jsvalue.Items(jsvalue.Or(list, []any{}), "existingAttendees"); err != nil {
			return nil, fail(err)
		}
	}
	patch := &calendar.Event{
		Summary:      o.summary,
		Description:  o.description,
		Location:     o.location,
		ColorId:      o.colorID,
		Visibility:   o.visibility,
		Transparency: o.transparency,
		// Summary, Description, Location and ColorId are sent even when empty.
		ForceSendFields: o.given,
	}
	if o.start != "" {
		patch.Start = dateTime(o.start, o.allDay)
	}
	if o.end != "" {
		patch.End = dateTime(o.end, o.allDay)
	}
	if len(o.attendees) > 0 {
		for _, email := range o.attendees {
			patch.Attendees = append(patch.Attendees, &calendar.EventAttendee{Email: email})
		}
	} else if len(o.addAttendees) > 0 {
		known := map[string]bool{}
		for _, at := range existing {
			if jsvalue.Nullish(at) {
				return nil, fail(jsvalue.TypeError(at, "a.email"))
			}
			if email := jsvalue.Member(at, "email"); !jsvalue.Nullish(email) {
				known[strings.ToLower(jsvalue.String(email))] = true
			}
		}
		kept, err := typedAttendees(existing)
		if err != nil {
			return nil, fail(err)
		}
		patch.Attendees = kept
		for _, email := range o.addAttendees {
			if !known[strings.ToLower(email)] {
				patch.Attendees = append(patch.Attendees, &calendar.EventAttendee{Email: email, ResponseStatus: "needsAction"})
			}
		}
	}
	return eventAnswer(a, a.svc.Events.Patch(o.calendarID, o.eventID, patch).SendUpdates(o.sendUpdates), fail)
}

func (a *api) deleteEvent(calendarID, eventID, sendUpdates string) error {
	if err := a.svc.Events.Delete(calendarID, eventID).SendUpdates(sendUpdates).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Event", eventID, "Failed to delete event", err)
	}
	return nil
}

func (a *api) respond(calendarID, eventID, status, comment string) (*jsvalue.Object, error) {
	fail := func(err error) error { return a.NotFoundOr("Event", eventID, "Failed to respond to event", err) }
	_, raw, err := google.Answer(a.Ctx, a.svc.Events.Get(calendarID, eventID))
	if err != nil {
		return nil, fail(err)
	}
	attendees, err := jsvalue.Path(raw, "event.data", "attendees")
	if err != nil {
		return nil, fail(err)
	}
	list, _ := attendees.([]any)
	if len(list) == 0 {
		return nil, a.Fail("INVALID_PARAMS", "Event has no attendees", "")
	}
	var self *jsvalue.Object
	for _, at := range list {
		if jsvalue.Nullish(at) {
			return nil, fail(jsvalue.TypeError(at, "a.self"))
		}
		if jsvalue.Truthy(jsvalue.Member(at, "self")) {
			self, _ = at.(*jsvalue.Object)
			break
		}
	}
	if self == nil {
		return nil, a.Fail("INVALID_PARAMS", "You are not an attendee of this event", "")
	}
	if jsvalue.Truthy(self.Value("organizer")) {
		return nil, a.Fail("INVALID_PARAMS", "Cannot respond to your own event (you are the organizer)", "")
	}
	self.Set("responseStatus", status)
	if comment != "" {
		self.Set("comment", comment)
	}
	typed, err := typedAttendees(list)
	if err != nil {
		return nil, fail(err)
	}
	return eventAnswer(a, a.svc.Events.Patch(calendarID, eventID, &calendar.Event{Attendees: typed}), fail)
}

func (a *api) freeBusy(ids []string, timeMin, timeMax string) (*jsvalue.Object, error) {
	// CallJSON: Bun's requestBody { timeMin, timeMax, items } in that order,
	// the times as given; the SDK's FreeBusyRequest writes items first.
	body := jsvalue.NewObject()
	body.Set("timeMin", timeMin)
	body.Set("timeMax", timeMax)
	items := make([]any, len(ids))
	for i, id := range ids {
		item := jsvalue.NewObject()
		item.Set("id", id)
		items[i] = item
	}
	body.Set("items", items)
	raw, err := google.CallJSON(a.Ctx, a.RunContext, google.Snake, http.MethodPost, a.svc.BasePath, "freeBusy", jsvalue.Stringify(body))
	if err == nil {
		var out *jsvalue.Object
		if out, err = freeBusyOf(raw); err == nil {
			return out, nil
		}
	}
	return nil, a.APIError("Calendar API error", err)
}

// freeBusyOf is Bun's GCalFreeBusyResponse built from response.data:
// Object.entries(response.data.calendars || {}), in the answer's order.
func freeBusyOf(raw any) (*jsvalue.Object, error) {
	calendars, err := jsvalue.Path(raw, "response.data", "calendars")
	if err != nil {
		return nil, err
	}
	entries := jsvalue.Spread(jsvalue.Or(calendars, jsvalue.NewObject()))
	out := jsvalue.NewObject()
	for _, id := range entries.Keys() {
		data := entries.Value(id)
		if jsvalue.Nullish(data) {
			return nil, jsvalue.TypeError(data, "data.busy")
		}
		busy, err := jsvalue.Map(jsvalue.Or(jsvalue.Member(data, "busy"), []any{}), "(data.busy || [])", func(b any) (any, error) {
			if jsvalue.Nullish(b) {
				return nil, jsvalue.TypeError(b, "b.start")
			}
			return jsvalue.ObjectOf("start", jsvalue.Member(b, "start"), "end", jsvalue.Member(b, "end")), nil
		})
		if err != nil {
			return nil, err
		}
		errs, err := optionalMap(jsvalue.Member(data, "errors"), "data.errors", func(e any) (any, error) {
			if jsvalue.Nullish(e) {
				return nil, jsvalue.TypeError(e, "e.domain")
			}
			return jsvalue.ObjectOf("domain", jsvalue.Or(jsvalue.Member(e, "domain"), ""), "reason", jsvalue.Or(jsvalue.Member(e, "reason"), "")), nil
		})
		if err != nil {
			return nil, err
		}
		out.Set(id, jsvalue.ObjectOf("busy", busy, "errors", errs))
	}
	return jsvalue.ObjectOf("calendars", out), nil
}

// parseReminders is Bun's `method:minutes` check for --reminder.
func parseReminders(specs []string, fail plugins.FailFunc) ([]*calendar.EventReminder, error) {
	var out []*calendar.EventReminder
	for _, spec := range specs {
		parts := strings.Split(spec, ":")
		method, minutes := parts[0], ""
		if len(parts) > 1 {
			minutes = parts[1]
		}
		if (method != "email" && method != "popup") || minutes == "" {
			return nil, fail("INVALID_PARAMS", "Invalid reminder format: "+spec, "Use format: method:minutes (e.g., popup:30)")
		}
		r := &calendar.EventReminder{Method: method, ForceSendFields: []string{"Minutes"}}
		if n := jsvalue.ParseInt(minutes); math.IsNaN(n) {
			// JSON.stringify(NaN) is null.
			r.ForceSendFields, r.NullFields = nil, []string{"Minutes"}
		} else {
			r.Minutes = int64(n)
		}
		out = append(out, r)
	}
	return out, nil
}

// dateTime is buildEventDateTime: a date without "T" (or --all-day) is all-day.
// The value is sent even when empty (date ""), as in Bun.
func dateTime(value string, allDay bool) *calendar.EventDateTime {
	trimmed := jsvalue.Trim(value)
	if allDay || !strings.Contains(trimmed, "T") {
		return &calendar.EventDateTime{Date: trimmed, ForceSendFields: []string{"Date"}}
	}
	return &calendar.EventDateTime{DateTime: trimmed, ForceSendFields: []string{"DateTime"}}
}

// timeRange is Bun parseTimeRange, in local time like JavaScript Date.
func timeRange(in plugins.CommandInput) (string, string) {
	t := now()
	switch {
	case in.Flag("today"), in.Flag("tomorrow"):
		offset := 0
		if !in.Flag("today") {
			offset = 1
		}
		start := time.Date(t.Year(), t.Month(), t.Day()+offset, 0, 0, 0, 0, time.Local)
		return jsvalue.ISOString(start), jsvalue.ISOString(addDays(start, 1))
	case in.Option("days") != "":
		days := jsvalue.ParseInt(in.Option("days"))
		if math.IsNaN(days) || days <= 0 {
			return "", ""
		}
		return jsvalue.ISOString(t), jsvalue.ISOString(addDays(t, int(days)))
	default:
		return in.Option("from"), in.Option("to")
	}
}

// addDays is Date.setDate(getDate() + n): same local wall time n days later.
func addDays(t time.Time, n int) time.Time {
	t = t.In(time.Local)
	return time.Date(t.Year(), t.Month(), t.Day()+n, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.Local)
}
