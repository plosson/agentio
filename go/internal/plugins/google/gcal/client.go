package gcal

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	calendar "google.golang.org/api/calendar/v3"
)

// now is the clock behind --today, --tomorrow, --days and the search range.
var now = time.Now

type calendarEntry struct {
	ID          string `json:"id,omitempty"`
	Summary     string `json:"summary"`
	Description string `json:"description,omitempty"`
	AccessRole  string `json:"accessRole"`
	Primary     bool   `json:"primary"`
	TimeZone    string `json:"timeZone,omitempty"`
}

type eventDateTime struct {
	DateTime string `json:"dateTime,omitempty"`
	Date     string `json:"date,omitempty"`
	TimeZone string `json:"timeZone,omitempty"`
}

type person struct {
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

type attendee struct {
	Email          string `json:"email,omitempty"`
	DisplayName    string `json:"displayName,omitempty"`
	ResponseStatus string `json:"responseStatus,omitempty"`
	Optional       bool   `json:"optional,omitempty"`
	Organizer      bool   `json:"organizer,omitempty"`
	Self           bool   `json:"self,omitempty"`
	Comment        string `json:"comment,omitempty"`
}

type reminder struct {
	Method  string `json:"method,omitempty"`
	Minutes int64  `json:"minutes"`
}

type reminders struct {
	UseDefault bool        `json:"useDefault"`
	Overrides  *[]reminder `json:"overrides,omitempty"`
}

type entryPoint struct {
	EntryPointType string `json:"entryPointType,omitempty"`
	URI            string `json:"uri,omitempty"`
	Label          string `json:"label,omitempty"`
}

type conferenceData struct {
	EntryPoints *[]entryPoint `json:"entryPoints,omitempty"`
}

// event is GCalEvent. A pointer to a slice keeps Bun's difference between an
// absent list (omitted) and an empty one ([]).
type event struct {
	ID               string          `json:"id,omitempty"`
	Summary          string          `json:"summary,omitempty"`
	Description      string          `json:"description,omitempty"`
	Location         string          `json:"location,omitempty"`
	Start            eventDateTime   `json:"start"`
	End              eventDateTime   `json:"end"`
	Status           string          `json:"status,omitempty"`
	HTMLLink         string          `json:"htmlLink,omitempty"`
	Created          string          `json:"created,omitempty"`
	Updated          string          `json:"updated,omitempty"`
	ColorID          string          `json:"colorId,omitempty"`
	Creator          *person         `json:"creator,omitempty"`
	Organizer        *person         `json:"organizer,omitempty"`
	Attendees        *[]attendee     `json:"attendees,omitempty"`
	Recurrence       *[]string       `json:"recurrence,omitempty"`
	RecurringEventID string          `json:"recurringEventId,omitempty"`
	Transparency     string          `json:"transparency,omitempty"`
	Visibility       string          `json:"visibility,omitempty"`
	Reminders        *reminders      `json:"reminders,omitempty"`
	HangoutLink      string          `json:"hangoutLink,omitempty"`
	ConferenceData   *conferenceData `json:"conferenceData,omitempty"`
	EventType        string          `json:"eventType,omitempty"`
}

type eventList struct {
	Events        []event `json:"events"`
	NextPageToken string  `json:"nextPageToken,omitempty"`
}

type deleted struct {
	CalendarID string `json:"calendarId"`
	EventID    string `json:"eventId"`
}

type responded struct {
	Status string `json:"status"`
	Event  event  `json:"event"`
}

type busyPeriod struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type busyError struct {
	Domain string `json:"domain"`
	Reason string `json:"reason"`
}

type busyCalendar struct {
	ID     string       `json:"-"`
	Busy   []busyPeriod `json:"busy"`
	Errors *[]busyError `json:"errors,omitempty"`
}

// freeBusy is GCalFreeBusyResponse. Calendars keep the response order Bun's
// Object.entries walks: the requested ids first, then any other key.
type freeBusy struct {
	Calendars []busyCalendar
}

func (f freeBusy) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteString(`{"calendars":{`)
	for i, c := range f.Calendars {
		if i > 0 {
			b.WriteByte(',')
		}
		key, _ := json.Marshal(c.ID)
		value, err := json.Marshal(c)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteString("}}")
	return []byte(b.String()), nil
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

func (a *api) listCalendars(limit float64) ([]calendarEntry, error) {
	resp, err := a.svc.CalendarList.List().Context(a.Ctx).Do(google.MaxResults(limit, 250))
	if err != nil {
		return nil, a.APIError("Calendar API error", err)
	}
	out := []calendarEntry{}
	for _, c := range resp.Items {
		out = append(out, calendarEntry{
			ID: c.Id, Summary: c.Summary, Description: c.Description,
			AccessRole: c.AccessRole, Primary: c.Primary, TimeZone: c.TimeZone,
		})
	}
	return out, nil
}

func (a *api) listEvents(calendarID string, limit float64, timeMin, timeMax, query string) (*eventList, error) {
	call := a.svc.Events.List(calendarID).SingleEvents(true).OrderBy("startTime").Context(a.Ctx)
	if timeMin != "" {
		call.TimeMin(timeMin)
	}
	if timeMax != "" {
		call.TimeMax(timeMax)
	}
	if query != "" {
		call.Q(query)
	}
	resp, err := call.Do(google.MaxResults(limit, 250))
	if err != nil {
		return nil, a.APIError("Calendar API error", err)
	}
	out := &eventList{Events: []event{}, NextPageToken: resp.NextPageToken}
	for _, e := range resp.Items {
		out.Events = append(out.Events, parseEvent(e))
	}
	return out, nil
}

func (a *api) getEvent(calendarID, eventID string) (*event, error) {
	e, err := a.svc.Events.Get(calendarID, eventID).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.NotFoundOr("Event", eventID, "Calendar API error", err)
	}
	parsed := parseEvent(e)
	return &parsed, nil
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

func (a *api) createEvent(o createOptions) (*event, error) {
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
	call := a.svc.Events.Insert(o.calendarID, body).SendUpdates(o.sendUpdates).Context(a.Ctx)
	if o.withMeet {
		body.ConferenceData = &calendar.ConferenceData{CreateRequest: &calendar.CreateConferenceRequest{
			RequestId:             fmt.Sprintf("agentio-%d", now().UnixMilli()),
			ConferenceSolutionKey: &calendar.ConferenceSolutionKey{Type: "hangoutsMeet"},
		}}
		call.ConferenceDataVersion(1)
	}
	e, err := call.Do()
	if err != nil {
		return nil, a.APIError("Failed to create event", err)
	}
	parsed := parseEvent(e)
	return &parsed, nil
}

type updateOptions struct {
	given                                                           []string
	calendarID, eventID, summary, description, location, start, end string
	allDay                                                          bool
	attendees, addAttendees                                         []string
	colorID, visibility, transparency, sendUpdates                  string
}

func (a *api) updateEvent(o updateOptions) (*event, error) {
	var existing []*calendar.EventAttendee
	if len(o.addAttendees) > 0 {
		current, err := a.svc.Events.Get(o.calendarID, o.eventID).Context(a.Ctx).Do()
		if err != nil {
			return nil, a.NotFoundOr("Event", o.eventID, "Failed to update event", err)
		}
		existing = current.Attendees
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
			known[strings.ToLower(at.Email)] = true
		}
		patch.Attendees = append([]*calendar.EventAttendee{}, existing...)
		for _, email := range o.addAttendees {
			if !known[strings.ToLower(email)] {
				patch.Attendees = append(patch.Attendees, &calendar.EventAttendee{Email: email, ResponseStatus: "needsAction"})
			}
		}
	}
	e, err := a.svc.Events.Patch(o.calendarID, o.eventID, patch).SendUpdates(o.sendUpdates).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.NotFoundOr("Event", o.eventID, "Failed to update event", err)
	}
	parsed := parseEvent(e)
	return &parsed, nil
}

func (a *api) deleteEvent(calendarID, eventID, sendUpdates string) error {
	if err := a.svc.Events.Delete(calendarID, eventID).SendUpdates(sendUpdates).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Event", eventID, "Failed to delete event", err)
	}
	return nil
}

func (a *api) respond(calendarID, eventID, status, comment string) (*event, error) {
	current, err := a.svc.Events.Get(calendarID, eventID).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.NotFoundOr("Event", eventID, "Failed to respond to event", err)
	}
	if len(current.Attendees) == 0 {
		return nil, a.Fail("INVALID_PARAMS", "Event has no attendees", "")
	}
	var self *calendar.EventAttendee
	for _, at := range current.Attendees {
		if at.Self {
			self = at
			break
		}
	}
	if self == nil {
		return nil, a.Fail("INVALID_PARAMS", "You are not an attendee of this event", "")
	}
	if self.Organizer {
		return nil, a.Fail("INVALID_PARAMS", "Cannot respond to your own event (you are the organizer)", "")
	}
	self.ResponseStatus = status
	if comment != "" {
		self.Comment = comment
	}
	e, err := a.svc.Events.Patch(calendarID, eventID, &calendar.Event{Attendees: current.Attendees}).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.NotFoundOr("Event", eventID, "Failed to respond to event", err)
	}
	parsed := parseEvent(e)
	return &parsed, nil
}

func (a *api) freeBusy(ids []string, timeMin, timeMax string) (*freeBusy, error) {
	// Bun sends the times as given, "" included.
	req := &calendar.FreeBusyRequest{TimeMin: timeMin, TimeMax: timeMax, ForceSendFields: []string{"TimeMin", "TimeMax"}}
	for _, id := range ids {
		req.Items = append(req.Items, &calendar.FreeBusyRequestItem{Id: id})
	}
	resp, err := a.svc.Freebusy.Query(req).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.APIError("Calendar API error", err)
	}
	var order []string
	seen := map[string]bool{}
	for _, id := range ids {
		if _, ok := resp.Calendars[id]; ok && !seen[id] {
			order = append(order, id)
			seen[id] = true
		}
	}
	var rest []string
	for id := range resp.Calendars {
		if !seen[id] {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	out := &freeBusy{Calendars: []busyCalendar{}}
	for _, id := range append(order, rest...) {
		data := resp.Calendars[id]
		c := busyCalendar{ID: id, Busy: []busyPeriod{}}
		for _, b := range data.Busy {
			c.Busy = append(c.Busy, busyPeriod{Start: b.Start, End: b.End})
		}
		if data.Errors != nil {
			errs := []busyError{}
			for _, e := range data.Errors {
				errs = append(errs, busyError{Domain: e.Domain, Reason: e.Reason})
			}
			c.Errors = &errs
		}
		out.Calendars = append(out.Calendars, c)
	}
	return out, nil
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

func parseEvent(e *calendar.Event) event {
	out := event{
		ID: e.Id, Summary: e.Summary, Description: e.Description, Location: e.Location,
		Start: dt(e.Start), End: dt(e.End), Status: e.Status, HTMLLink: e.HtmlLink,
		Created: e.Created, Updated: e.Updated, ColorID: e.ColorId,
		RecurringEventID: e.RecurringEventId, Transparency: e.Transparency, Visibility: e.Visibility,
		HangoutLink: e.HangoutLink, EventType: e.EventType,
	}
	if e.Creator != nil {
		out.Creator = &person{Email: e.Creator.Email, DisplayName: e.Creator.DisplayName}
	}
	if e.Organizer != nil {
		out.Organizer = &person{Email: e.Organizer.Email, DisplayName: e.Organizer.DisplayName}
	}
	if e.Attendees != nil {
		list := []attendee{}
		for _, a := range e.Attendees {
			list = append(list, attendee{
				Email: a.Email, DisplayName: a.DisplayName, ResponseStatus: a.ResponseStatus,
				Optional: a.Optional, Organizer: a.Organizer, Self: a.Self, Comment: a.Comment,
			})
		}
		out.Attendees = &list
	}
	if e.Recurrence != nil {
		rec := append([]string{}, e.Recurrence...)
		out.Recurrence = &rec
	}
	if e.Reminders != nil {
		r := &reminders{UseDefault: e.Reminders.UseDefault}
		if e.Reminders.Overrides != nil {
			list := []reminder{}
			for _, o := range e.Reminders.Overrides {
				list = append(list, reminder{Method: o.Method, Minutes: o.Minutes})
			}
			r.Overrides = &list
		}
		out.Reminders = r
	}
	if e.ConferenceData != nil {
		c := &conferenceData{}
		if e.ConferenceData.EntryPoints != nil {
			list := []entryPoint{}
			for _, ep := range e.ConferenceData.EntryPoints {
				list = append(list, entryPoint{EntryPointType: ep.EntryPointType, URI: ep.Uri, Label: ep.Label})
			}
			c.EntryPoints = &list
		}
		out.ConferenceData = c
	}
	return out
}

func dt(v *calendar.EventDateTime) eventDateTime {
	if v == nil {
		return eventDateTime{}
	}
	return eventDateTime{DateTime: v.DateTime, Date: v.Date, TimeZone: v.TimeZone}
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
		return google.ISOString(start), google.ISOString(addDays(start, 1))
	case in.Option("days") != "":
		days := jsvalue.ParseInt(in.Option("days"))
		if math.IsNaN(days) || days <= 0 {
			return "", ""
		}
		return google.ISOString(t), google.ISOString(addDays(t, int(days)))
	default:
		return in.Option("from"), in.Option("to")
	}
}

// addDays is Date.setDate(getDate() + n): same local wall time n days later.
func addDays(t time.Time, n int) time.Time {
	t = t.In(time.Local)
	return time.Date(t.Year(), t.Month(), t.Day()+n, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.Local)
}
