package gcal

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/vault"
)

// product drives New() through the shared Google test harness.
var product = googletest.For(New)

func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"access_token":  "at-old",
		"refresh_token": "rt-old",
		"expiry_date":   expiry,
		"token_type":    "Bearer",
		"scope":         "https://www.googleapis.com/auth/calendar",
		"email":         "me@example.com",
	}
}

// The command table is the Bun surface: `bun run src/index.ts gcal --help`
// and each leaf's --help. A renamed flag, a lost default, an alias, or a write
// that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		aliases, args, flags, access, op, input string
	}
	want := map[string]row{
		"calendars": {"", "", "--limit <n>=100", "read", "", ""},
		"events": {"list", "[calendar-id]",
			"--limit <n>=10 --from <datetime> --to <datetime> --today --tomorrow --days <n> --query <q>", "read", "", ""},
		"get": {"event", "<calendar-id> <event-id>", "", "read", "", ""},
		"create": {"", "[calendar-id]",
			"--summary <title> --from <datetime> --to <datetime> --description <text> --location <place> --all-day --attendee <email>* --rrule <rule>* --reminder <spec>* --color <id> --visibility <v> --show-as <v> --send-updates <mode>=all --with-meet",
			"write", "create event", "text"},
		"update": {"", "<calendar-id> <event-id>",
			"--summary <title> --from <datetime> --to <datetime> --description <text> --location <place> --all-day --attendee <email>* --add-attendee <email>* --color <id> --visibility <v> --show-as <v> --send-updates <mode>=all",
			"write", "update event", "text"},
		"delete":   {"", "<calendar-id> <event-id>", "--send-updates <mode>=all", "write", "delete event", ""},
		"search":   {"", "<query>", "--calendar <id>=primary --limit <n>=25 --from <datetime> --to <datetime>", "read", "", ""},
		"respond":  {"", "<calendar-id> <event-id>", "--status <status> --comment <text>", "write", "respond to event", ""},
		"freebusy": {"", "<calendar-ids>", "--from <datetime> --to <datetime>", "read", "", ""},
	}
	p := New()
	if p.ID != "gcal" || p.DisplayName != "Google Calendar" || p.Description != "Use when interacting with Google Calendar via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	// Bun help order.
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, " ") != "calendars events get create update delete search respond freebusy" {
		t.Fatalf("order %v", order)
	}
	for _, c := range p.Commands {
		w, ok := want[c.Path]
		if !ok {
			t.Fatalf("unexpected command %q", c.Path)
		}
		var args, flags []string
		for _, a := range c.Arguments {
			if a.Required {
				args = append(args, "<"+a.Name+">")
			} else {
				args = append(args, "["+a.Name+"]")
			}
		}
		for _, o := range c.Options {
			f := o.Flags
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			if o.Repeatable {
				f += "*"
			}
			flags = append(flags, f)
		}
		got := row{strings.Join(c.Aliases, ","), strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refresh_token" {
		t.Fatal("gcal is a snake_case Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email"})
		case "/userinfo":
			if h.Auth != "Bearer at-1" {
				w.WriteHeader(401)
				return
			}
			googletest.WriteJSON(w, 200, map[string]any{"email": "user@example.com"})
		default:
			w.WriteHeader(404)
		}
	})
	var opts plugins.OAuthSetupOptions
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	if err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if opts.Port != 0 || opts.ServiceName != "Google" || opts.ExpectedState != "" {
		t.Fatalf("oauth opts %#v", opts)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:3001/callback"))
	q := authURL.Query()
	if authURL.Host != "accounts.google.com" || authURL.Path != "/o/oauth2/v2/auth" || q.Get("access_type") != "offline" ||
		q.Get("prompt") != "consent" || q.Get("scope") != "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email" ||
		q.Get("redirect_uri") != "http://localhost:3001/callback" || q.Get("response_type") != "code" || !strings.HasSuffix(q.Get("client_id"), ".apps.googleusercontent.com") {
		t.Fatalf("authorize url %s", authURL)
	}
	token := fake.Recorded()[0].Form
	if token.Get("grant_type") != "authorization_code" || token.Get("code") != "code-1" || token.Get("redirect_uri") != "http://localhost:3001/callback" || token.Get("client_secret") == "" {
		t.Fatalf("token request %v", token)
	}
	// The suggested name is the email, and the host saved it under Bun's keys.
	stored := product.LoadCreds(t, "user@example.com")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "access_token,email,expiry_date,refresh_token,scope,token_type" {
		t.Fatalf("keys %v", keys)
	}
	if stored["access_token"] != "at-1" || stored["refresh_token"] != "rt-1" || stored["email"] != "user@example.com" || stored["token_type"] != "Bearer" {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiry_date"].(json.Number)
	if !ok {
		t.Fatalf("expiry_date is %T, want a JSON number", stored["expiry_date"])
	}
	if n, _ := exp.Int64(); n < before+3599_000 || n > time.Now().UnixMilli()+3599_000 {
		t.Fatalf("expiry %d", n)
	}
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\n" {
		t.Fatalf("%q", out.String())
	}
}

func TestSetupFailsWithBunsMessageWhenTheEmailIsMissing(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"id": "123"})
	})
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, io.Discard)
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.AuthFailed || ce.Message != "Could not fetch email from Calendar" || ce.Suggestion != "Try again or specify --profile manually" {
		t.Fatalf("%#v", ce)
	}
	if c, _ := vault.Load(); len(c.Credentials["gcal"]) != 0 {
		t.Fatal("a failed setup saved a profile")
	}
}

// Bun never rotates a Google refresh token: google-auth-library puts the
// stored one back on the result, so a rotated token in the response is dropped.
func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	creds := storedCreds(1)
	creds["legacy"] = "kept"
	product.SaveProfile(t, "acme", creds, false)
	var mu sync.Mutex
	refreshes := 0
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3599, "token_type": "Bearer"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"items": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gcal", "acme", auth.RefreshOptions{})
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if refreshes != 1 {
		t.Fatalf("%d refreshes, want 1", refreshes)
	}
	form := fake.Recorded()[0].Form
	if form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "rt-old" || form.Get("client_secret") == "" {
		t.Fatalf("refresh request %v", form)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["access_token"] != "at-new" || stored["refresh_token"] != "rt-old" || stored["email"] != "me@example.com" ||
		stored["legacy"] != "kept" || stored["scope"] != "https://www.googleapis.com/auth/calendar" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiry_date"].(json.Number); !ok {
		t.Fatalf("expiry_date %T", stored["expiry_date"])
	}
	// The command then calls the API with the refreshed token.
	if _, err := product.Exec(fake.Ctx(), t, reg, "calendars", product.Input(t, "calendars", nil, nil)); err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if last := all[len(all)-1]; last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(1), false)
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := product.Exec(fake.Ctx(), t, reg, "calendars", product.Input(t, "calendars", nil, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gcal profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gcal profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["access_token"] != "at-old" || stored["refresh_token"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if n := len(fake.Recorded()); n != 1 {
		t.Fatalf("%d requests", n)
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", storedCreds(time.Now().Add(24*time.Hour).UnixMilli()), true)
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"items": []any{}})
	})
	args := map[string]any{"calendar-id": "primary", "event-id": "e1"}
	for path, op := range map[string]string{"create": "create event", "update": "update event", "delete": "delete event", "respond": "respond to event"} {
		_, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, map[string]any{
			"summary": "S", "from": "2024-04-15", "to": "2024-04-16", "status": "accepted",
		}))
		ce := googletest.CliErr(t, err)
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio gcal profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	// Bun checks these inputs before enforceWriteAccess, so on a read-only
	// profile the input error wins; a status in another case is still valid.
	valid := map[string]any{"summary": "S", "from": "2024-04-15", "to": "2024-04-16", "status": "accepted"}
	for _, c := range []struct {
		path                string
		set                 map[string]any
		message, suggestion string
	}{
		{"create", map[string]any{"summary": nil}, "required option '--summary <title>' not specified", ""},
		{"create", map[string]any{"to": nil}, "required option '--to <datetime>' not specified", ""},
		{"create", map[string]any{"reminder": []string{"popup:10", "bogus"}}, "Invalid reminder format: bogus", "Use format: method:minutes (e.g., popup:30)"},
		{"update", map[string]any{"attendee": []string{"a@x.com"}, "add-attendee": []string{"b@x.com"}}, "Cannot use both --attendee and --add-attendee", ""},
		{"respond", map[string]any{"status": nil}, "required option '--status <status>' not specified", ""},
		{"respond", map[string]any{"status": "maybe"}, "Invalid status: maybe", "Use: accepted, declined, or tentative"},
		{"respond", map[string]any{"status": "ACCEPTED"}, `Cannot respond to event: profile "ro" is read-only`, "To modify this profile's access: agentio gcal profile update --profile ro --no-read-only"},
	} {
		set := map[string]any{}
		for k, v := range valid {
			set[k] = v
		}
		for k, v := range c.set {
			set[k] = v
		}
		_, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, args, set))
		ce := googletest.CliErr(t, err)
		code := clierr.InvalidParams
		if c.set["status"] == "ACCEPTED" {
			code = clierr.PermissionDenied
		}
		if ce.Code != code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s %v: %#v", c.path, c.set, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	for _, path := range []string{"calendars", "events", "search", "freebusy"} {
		in := product.Input(t, path, map[string]any{"query": "q", "calendar-ids": "primary"}, map[string]any{"from": "2024-04-15T00:00:00Z", "to": "2024-04-16T00:00:00Z"})
		if _, err := product.Exec(fake.Ctx(), t, reg, path, in); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if n := len(fake.Recorded()); n != 4 {
		t.Fatalf("reads did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	var status int
	var body any
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path != "/calendar/v3/users/me/calendarList/primary" || h.Auth != "Bearer at-old" {
			t.Errorf("validate called %s with %q", h.Path, h.Auth)
		}
		googletest.WriteJSON(w, status, body)
	})
	run := host.NewRunContext(storedCreds(1), "acme", fake.Ctx())
	status, body = 200, map[string]any{"id": "me@example.com"}
	v, err := New().Profile.Validate(fake.Ctx(), run)
	if err != nil || !v.Valid || v.Info != "me@example.com" {
		t.Fatalf("%#v %v", v, err)
	}
	status, body = 200, map[string]any{}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); !v.Valid || v.Info != "me" {
		t.Fatalf("%#v", v)
	}
	status, body = 401, map[string]any{"error": map[string]any{"code": 401, "message": "Request had invalid authentication credentials."}}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); v.Valid || v.Error != "Request had invalid authentication credentials." {
		t.Fatalf("%#v", v)
	}
	status, body = 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); v.Valid || v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(5)
	out := auth.RedactForRemote(reg, "gcal", creds)
	if _, ok := out["refresh_token"]; ok || out["access_token"] != "at-old" || out["email"] != "me@example.com" || out["expiry_date"] != int64(5) {
		t.Fatalf("%#v", out)
	}
	if creds["refresh_token"] != "rt-old" {
		t.Fatal("redaction changed the caller's map")
	}
}

func TestListInfoAndReauthenticate(t *testing.T) {
	if google.EmailListInfo(map[string]any{"email": "me@example.com"}) != " - me@example.com" || google.EmailListInfo(map[string]any{}) != "" {
		t.Fatal("list info")
	}
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"email": "me@example.com"})
	})
	var logs []string
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) {
		for _, p := range parts {
			logs = append(logs, p.(string))
		}
	}
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	got, err := New().Profile.Reauthenticate(fake.Ctx(), storedCreds(1), "work", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["access_token"] != "at-2" || got["refresh_token"] != "rt-2" || got["email"] != "me@example.com" {
		t.Fatalf("%#v", got)
	}
	// No scope in the response: Bun spreads scope: undefined over the old one.
	if _, ok := got["scope"]; ok {
		t.Fatalf("scope kept %#v", got)
	}
	if strings.Join(logs, "|") != "\nRe-authenticating gcal / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

// withClock pins now and the local zone (Los Angeles, UTC-7 in April).
func withClock(t *testing.T, at string) {
	t.Helper()
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Skip("no tzdata")
	}
	prevLocal, prevNow := time.Local, now
	time.Local = la
	fixed, _ := time.ParseInLocation("2006-01-02T15:04:05.000", at, la)
	now = func() time.Time { return fixed }
	t.Cleanup(func() { time.Local, now = prevLocal, prevNow })
}

func TestListingCommandsSendTheBunQueries(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	withClock(t, "2024-04-15T10:30:15.123")
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"items": []any{}})
	})
	run := func(path string, args, set map[string]any) url.Values {
		t.Helper()
		before := len(fake.Recorded())
		if _, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, set)); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		all := fake.Recorded()
		if len(all) != before+1 {
			t.Fatalf("%s: %d requests", path, len(all)-before)
		}
		return all[len(all)-1].Query
	}
	q := run("calendars", nil, map[string]any{"limit": "1000"})
	if fake.Recorded()[0].Path != "/calendar/v3/users/me/calendarList" || q.Get("maxResults") != "250" {
		t.Fatalf("calendars %v", q)
	}
	// parseInt("abc") is NaN, and googleapis sends it as such.
	if q = run("calendars", nil, map[string]any{"limit": "abc"}); q.Get("maxResults") != "NaN" {
		t.Fatalf("NaN limit %v", q)
	}
	q = run("events", nil, nil)
	if fake.Recorded()[2].Path != "/calendar/v3/calendars/primary/events" || q.Get("maxResults") != "10" ||
		q.Get("singleEvents") != "true" || q.Get("orderBy") != "startTime" || q.Has("timeMin") || q.Has("q") {
		t.Fatalf("events %v", q)
	}
	// Local midnight to local midnight, as UTC ISO strings.
	if q = run("events", map[string]any{"calendar-id": "team@example.com"}, map[string]any{"today": true, "query": "standup", "limit": "7.9"}); q.Get("timeMin") != "2024-04-15T07:00:00.000Z" ||
		q.Get("timeMax") != "2024-04-16T07:00:00.000Z" || q.Get("q") != "standup" || q.Get("maxResults") != "7" {
		t.Fatalf("today %v", q)
	}
	if p := fake.Recorded()[3].Path; p != "/calendar/v3/calendars/team@example.com/events" {
		t.Fatalf("path %s", p)
	}
	if q = run("events", nil, map[string]any{"tomorrow": true, "today": false}); q.Get("timeMin") != "2024-04-16T07:00:00.000Z" || q.Get("timeMax") != "2024-04-17T07:00:00.000Z" {
		t.Fatalf("tomorrow %v", q)
	}
	if q = run("events", nil, map[string]any{"days": "3"}); q.Get("timeMin") != "2024-04-15T17:30:15.123Z" || q.Get("timeMax") != "2024-04-18T17:30:15.123Z" {
		t.Fatalf("days %v", q)
	}
	// A non-positive --days gives no range at all, and --from/--to are ignored.
	if q = run("events", nil, map[string]any{"days": "0", "from": "2024-01-01"}); q.Has("timeMin") || q.Has("timeMax") {
		t.Fatalf("days 0 %v", q)
	}
	if q = run("events", nil, map[string]any{"from": "2024-04-01", "to": "2024-04-30"}); q.Get("timeMin") != "2024-04-01" || q.Get("timeMax") != "2024-04-30" {
		t.Fatalf("range %v", q)
	}
	// search: -30d to +90d across the DST change, primary, limit 25.
	q = run("search", map[string]any{"query": "1:1"}, nil)
	if q.Get("q") != "1:1" || q.Get("maxResults") != "25" || q.Get("timeMin") != "2024-03-16T17:30:15.123Z" || q.Get("timeMax") != "2024-07-14T17:30:15.123Z" {
		t.Fatalf("search %v", q)
	}
	if q = run("search", map[string]any{"query": "x"}, map[string]any{"calendar": "c@example.com", "from": "2024-01-01T00:00:00Z"}); q.Get("timeMin") != "2024-01-01T00:00:00Z" {
		t.Fatalf("search from %v", q)
	}
	if p := fake.Recorded()[len(fake.Recorded())-1].Path; p != "/calendar/v3/calendars/c@example.com/events" {
		t.Fatalf("search path %s", p)
	}
}

func TestWriteCommandsSendTheBunBodies(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	withClock(t, "2024-04-15T10:30:15.123")
	existing := map[string]any{
		"id": "e1", "summary": "Sync", "start": map[string]any{"dateTime": "2024-04-15T14:00:00-07:00"}, "end": map[string]any{"dateTime": "2024-04-15T15:00:00-07:00"},
		"attendees": []any{
			map[string]any{"email": "Alice@example.com", "responseStatus": "accepted"},
			map[string]any{"email": "me@example.com", "self": true, "responseStatus": "needsAction"},
		},
	}
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, existing)
	})
	last := func() googletest.Hit {
		all := fake.Recorded()
		return all[len(all)-1]
	}
	in := product.Input(t, "create", nil, map[string]any{
		"summary": "Standup", "from": " 2024-04-15T09:00:00-07:00 ", "to": "2024-04-15T09:30:00-07:00",
		"attendee": []string{"a@example.com", "b@example.com"}, "rrule": []string{"RRULE:FREQ=WEEKLY;BYDAY=MO"},
		"reminder": []string{"popup:0", "email:1440"}, "with-meet": true, "show-as": "free", "color": "5", "visibility": "private",
	})
	in.Stdin = "  from stdin \n"
	if _, err := product.Exec(fake.Ctx(), t, reg, "create", in); err != nil {
		t.Fatal(err)
	}
	h := last()
	want := `{"attendees":[{"email":"a@example.com"},{"email":"b@example.com"}],"colorId":"5","conferenceData":{"createRequest":{"conferenceSolutionKey":{"type":"hangoutsMeet"},"requestId":"agentio-1713202215123"}},"description":"from stdin","end":{"dateTime":"2024-04-15T09:30:00-07:00"},"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO"],"reminders":{"overrides":[{"method":"popup","minutes":0},{"method":"email","minutes":1440}],"useDefault":false},"start":{"dateTime":"2024-04-15T09:00:00-07:00"},"summary":"Standup","transparency":"transparent","visibility":"private"}`
	if h.Method != "POST" || h.Path != "/calendar/v3/calendars/primary/events" || h.Query.Get("sendUpdates") != "all" ||
		h.Query.Get("conferenceDataVersion") != "1" || googletest.JSONText(h.JSON) != want {
		t.Fatalf("create %s %s %v\n%s", h.Method, h.Path, h.Query, googletest.JSONText(h.JSON))
	}
	// All-day: a date without "T", or --all-day on a datetime.
	if _, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", map[string]any{"calendar-id": "team@example.com"}, map[string]any{
		"summary": "Offsite", "from": "2024-05-10", "to": "2024-05-11T00:00:00Z", "all-day": true, "send-updates": "none",
	})); err != nil {
		t.Fatal(err)
	}
	h = last()
	if h.Path != "/calendar/v3/calendars/team@example.com/events" || h.Query.Get("sendUpdates") != "none" || h.Query.Has("conferenceDataVersion") ||
		googletest.JSONText(h.JSON) != `{"end":{"date":"2024-05-11T00:00:00Z"},"start":{"date":"2024-05-10"},"summary":"Offsite"}` {
		t.Fatalf("all-day %v %s", h.Query, googletest.JSONText(h.JSON))
	}
	// --add-attendee reads the event, keeps everyone, skips a case-insensitive duplicate.
	n := len(fake.Recorded())
	if _, err := product.Exec(fake.Ctx(), t, reg, "update", product.Input(t, "update", map[string]any{"calendar-id": "primary", "event-id": "e1"}, map[string]any{
		"add-attendee": []string{"alice@EXAMPLE.com", "carol@example.com"}, "send-updates": "none", "from": "2024-04-16",
	})); err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()[n:]
	if len(all) != 2 || all[0].Method != "GET" || all[1].Method != "PATCH" || all[1].Path != "/calendar/v3/calendars/primary/events/e1" || all[1].Query.Get("sendUpdates") != "none" ||
		googletest.JSONText(all[1].JSON) != `{"attendees":[{"email":"Alice@example.com","responseStatus":"accepted"},{"email":"me@example.com","responseStatus":"needsAction","self":true},{"email":"carol@example.com","responseStatus":"needsAction"}],"start":{"date":"2024-04-16"}}` {
		t.Fatalf("update %s", googletest.JSONText(all[1].JSON))
	}
	// --attendee replaces without a read; an empty update sends {}.
	n = len(fake.Recorded())
	if _, err := product.Exec(fake.Ctx(), t, reg, "update", product.Input(t, "update", map[string]any{"calendar-id": "primary", "event-id": "e1"}, map[string]any{
		"attendee": []string{"z@example.com"}, "show-as": "busy", "summary": "Renamed",
	})); err != nil {
		t.Fatal(err)
	}
	all = fake.Recorded()[n:]
	if len(all) != 1 || all[0].Query.Get("sendUpdates") != "all" || googletest.JSONText(all[0].JSON) != `{"attendees":[{"email":"z@example.com"}],"summary":"Renamed","transparency":"opaque"}` {
		t.Fatalf("replace %s", googletest.JSONText(all[0].JSON))
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "update", product.Input(t, "update", map[string]any{"calendar-id": "primary", "event-id": "e1"}, nil)); err != nil {
		t.Fatal(err)
	}
	if googletest.JSONText(last().JSON) != `{}` {
		t.Fatalf("empty patch %s", googletest.JSONText(last().JSON))
	}
	// respond: read, set my status and comment, patch attendees without sendUpdates.
	n = len(fake.Recorded())
	got, err := product.Exec(fake.Ctx(), t, reg, "respond", product.Input(t, "respond", map[string]any{"calendar-id": "primary", "event-id": "e1"}, map[string]any{"status": "Declined", "comment": "Out of office"}))
	if err != nil {
		t.Fatal(err)
	}
	all = fake.Recorded()[n:]
	if len(all) != 2 || all[1].Method != "PATCH" || all[1].Query.Has("sendUpdates") ||
		googletest.JSONText(all[1].JSON) != `{"attendees":[{"email":"Alice@example.com","responseStatus":"accepted"},{"comment":"Out of office","email":"me@example.com","responseStatus":"declined","self":true}]}` {
		t.Fatalf("respond %v %s", all[1].Query, googletest.JSONText(all[1].JSON))
	}
	if formatResponded(got) != "Response updated: declined\nEvent: Sync" {
		t.Fatalf("%q", formatResponded(got))
	}
	// delete
	got, err = product.Exec(fake.Ctx(), t, reg, "delete", product.Input(t, "delete", map[string]any{"calendar-id": "primary", "event-id": "e1"}, map[string]any{"send-updates": "externalOnly"}))
	if err != nil {
		t.Fatal(err)
	}
	if h = last(); h.Method != "DELETE" || h.Path != "/calendar/v3/calendars/primary/events/e1" || h.Query.Get("sendUpdates") != "externalOnly" {
		t.Fatalf("delete %#v", h)
	}
	if formatDeleted(got) != "Event deleted\nCalendar: primary\nEvent ID: e1" {
		t.Fatalf("%q", formatDeleted(got))
	}
}

func TestFreeBusyKeepsTheRequestOrder(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"calendars":{
			"zed@example.com":{"busy":[{"start":"2024-04-15T16:00:00Z","end":"2024-04-15T17:00:00Z"}]},
			"amy@example.com":{"busy":[],"errors":[{"domain":"global","reason":"notFound"}]}}}`)
	})
	got, err := product.Exec(fake.Ctx(), t, reg, "freebusy", product.Input(t, "freebusy", map[string]any{"calendar-ids": " zed@example.com, ,amy@example.com"},
		map[string]any{"from": "2024-04-15T00:00:00Z", "to": "2024-04-16T00:00:00Z"}))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Method != "POST" || h.Path != "/calendar/v3/freeBusy" ||
		googletest.JSONText(h.JSON) != `{"items":[{"id":"zed@example.com"},{"id":"amy@example.com"}],"timeMax":"2024-04-16T00:00:00Z","timeMin":"2024-04-15T00:00:00Z"}` {
		t.Fatalf("%s %s", h.Path, googletest.JSONText(h.JSON))
	}
	want := "Free/Busy Information\n\nCalendar: zed@example.com\n  Busy: 2024-04-15T16:00:00Z - 2024-04-15T17:00:00Z\n\nCalendar: amy@example.com\n  Error: notFound\n  (no busy periods)\n"
	if formatFreeBusy(got) != want {
		t.Fatalf("%q", formatFreeBusy(got))
	}
	raw, _ := json.Marshal(got)
	if string(raw) != `{"calendars":{"zed@example.com":{"busy":[{"start":"2024-04-15T16:00:00Z","end":"2024-04-15T17:00:00Z"}]},"amy@example.com":{"busy":[],"errors":[{"domain":"global","reason":"notFound"}]}}}` {
		t.Fatalf("%s", raw)
	}
	if formatFreeBusy(&freeBusy{}) != "No free/busy data" {
		t.Fatal("empty")
	}
}

func TestInputAndAPIErrorsMatchBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	var status int
	var body any
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, status, body)
	})
	ids := map[string]any{"calendar-id": "primary", "event-id": "e9", "calendar-ids": " , ", "query": "q"}
	cases := []struct {
		path    string
		set     map[string]any
		code    clierr.Code
		message string
		suggest string
	}{
		{"create", map[string]any{"from": "a", "to": "b"}, clierr.InvalidParams, "required option '--summary <title>' not specified", ""},
		{"create", map[string]any{"summary": "s", "to": "b"}, clierr.InvalidParams, "required option '--from <datetime>' not specified", ""},
		{"create", map[string]any{"summary": "s", "from": "a"}, clierr.InvalidParams, "required option '--to <datetime>' not specified", ""},
		{"create", map[string]any{"summary": "s", "from": "a", "to": "b", "reminder": []string{"popup:10", "sms:5"}}, clierr.InvalidParams, "Invalid reminder format: sms:5", "Use format: method:minutes (e.g., popup:30)"},
		{"create", map[string]any{"summary": "s", "from": "a", "to": "b", "reminder": []string{"popup"}}, clierr.InvalidParams, "Invalid reminder format: popup", "Use format: method:minutes (e.g., popup:30)"},
		{"update", map[string]any{"attendee": []string{"a@example.com"}, "add-attendee": []string{"b@example.com"}}, clierr.InvalidParams, "Cannot use both --attendee and --add-attendee", ""},
		{"respond", nil, clierr.InvalidParams, "required option '--status <status>' not specified", ""},
		{"respond", map[string]any{"status": "maybe"}, clierr.InvalidParams, "Invalid status: maybe", "Use: accepted, declined, or tentative"},
		{"freebusy", map[string]any{"from": "a"}, clierr.InvalidParams, "required option '--to <datetime>' not specified", ""},
		{"freebusy", map[string]any{"from": "a", "to": "b"}, clierr.InvalidParams, "At least one calendar ID is required", ""},
	}
	for _, c := range cases {
		_, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, ids, c.set))
		ce := googletest.CliErr(t, err)
		if ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%s %v: %#v", c.path, c.set, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("an invalid input reached the API %d times", n)
	}
	// 404 is NOT_FOUND where Bun checks it; everything else is API_ERROR with the Bun prefix.
	status, body = 404, map[string]any{"error": map[string]any{"code": 404, "message": "Not Found"}}
	api := []struct {
		path    string
		set     map[string]any
		code    clierr.Code
		message string
	}{
		{"get", nil, clierr.NotFound, "Event not found: e9"},
		{"update", nil, clierr.NotFound, "Event not found: e9"},
		{"update", map[string]any{"add-attendee": []string{"b@example.com"}}, clierr.NotFound, "Event not found: e9"},
		{"delete", nil, clierr.NotFound, "Event not found: e9"},
		{"respond", map[string]any{"status": "accepted"}, clierr.NotFound, "Event not found: e9"},
		{"create", map[string]any{"summary": "s", "from": "a", "to": "b"}, clierr.APIError, "Failed to create event: Not Found"},
		{"events", nil, clierr.APIError, "Calendar API error: Not Found"},
		{"calendars", nil, clierr.APIError, "Calendar API error: Not Found"},
	}
	for _, c := range api {
		got, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, ids, c.set))
		ce := googletest.CliErr(t, err)
		if ce.Code != c.code || ce.Message != c.message || ce.Suggestion != "" {
			t.Errorf("%s: %#v", c.path, ce)
		}
		// Bun printed nothing before throwing; the host prints any non-nil value.
		if got != nil {
			t.Errorf("%s returned %#v with its error", c.path, got)
		}
	}
	status, body = 403, map[string]any{"error": map[string]any{"code": 403, "message": "Forbidden", "errors": []any{map[string]any{"message": "Forbidden"}}}}
	for path, message := range map[string]string{
		"get": "Calendar API error: Forbidden", "update": "Failed to update event: Forbidden",
		"delete": "Failed to delete event: Forbidden", "respond": "Failed to respond to event: Forbidden",
	} {
		_, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, ids, map[string]any{"status": "accepted"}))
		if ce := googletest.CliErr(t, err); ce.Code != clierr.APIError || ce.Message != message {
			t.Errorf("%s: %#v", path, ce)
		}
	}
	// respond refuses events it cannot answer.
	status = 200
	for message, attendees := range map[string]any{
		"Event has no attendees":                                   []any{},
		"You are not an attendee of this event":                    []any{map[string]any{"email": "a@example.com"}},
		"Cannot respond to your own event (you are the organizer)": []any{map[string]any{"email": "me@example.com", "self": true, "organizer": true}},
	} {
		body = map[string]any{"id": "e9", "attendees": attendees}
		n := len(fake.Recorded())
		_, err := product.Exec(fake.Ctx(), t, reg, "respond", product.Input(t, "respond", ids, map[string]any{"status": "accepted"}))
		if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != message {
			t.Errorf("%#v", ce)
		}
		if len(fake.Recorded())-n != 1 {
			t.Error("respond patched an event it refused")
		}
	}
}

func TestFormatMatchesBun(t *testing.T) {
	cals := []calendarEntry{
		{ID: "me@example.com", Summary: "Me", AccessRole: "owner", Primary: true, TimeZone: "Europe/Paris", Description: strings.Repeat("é", 79) + "😀x"},
		{ID: "team@example.com", Summary: "Team", AccessRole: "reader"},
	}
	want := "Calendars (2)\n\n[1] Me [primary]\n    ID: me@example.com\n    Role: owner\n    Timezone: Europe/Paris\n    > " + strings.Repeat("é", 79) + "\uFFFD...\n\n[2] Team\n    ID: team@example.com\n    Role: reader\n"
	if got := formatCalendars(cals); got != want {
		t.Fatalf("%q", got)
	}
	if formatCalendars([]calendarEntry{}) != "No calendars found" || formatEventList(&eventList{Events: []event{}}) != "No events found" {
		t.Fatal("empty")
	}
	attendees := []attendee{{Email: "a@example.com", ResponseStatus: "accepted", Organizer: true}, {Email: "me@example.com", Optional: true, Self: true}}
	overrides := []reminder{{Method: "popup", Minutes: 10}, {Method: "email", Minutes: 0}}
	points := []entryPoint{{EntryPointType: "video", URI: "https://meet.google.com/abc"}, {EntryPointType: "phone", URI: "tel:+1"}}
	rec := []string{"RRULE:FREQ=WEEKLY", "EXDATE:20240422"}
	e := event{
		ID: "e1", Summary: "Sync", EventType: "focusTime", Start: eventDateTime{DateTime: "2024-04-15T14:00:00-07:00", TimeZone: "America/Los_Angeles"},
		End: eventDateTime{Date: "2024-04-16"}, Location: "Room 1", Description: "line1\nline2", ColorID: "5", Visibility: "private",
		Transparency: "transparent", Attendees: &attendees, Recurrence: &rec, Reminders: &reminders{Overrides: &overrides},
		HangoutLink: "https://meet.google.com/abc", ConferenceData: &conferenceData{EntryPoints: &points}, HTMLLink: "https://calendar.example.com/e1",
	}
	want = "ID: e1\nSummary: Sync\nType: focusTime\nStart: 2024-04-15T14:00:00-07:00\nEnd: 2024-04-16\nTimezone: America/Los_Angeles\nLocation: Room 1\nDescription: line1\nline2\nColor: 5\nVisibility: private\nShow as: free\n\nAttendees (2):\n  a@example.com - accepted [organizer]\n  me@example.com - unknown (optional) [you]\nRecurrence: RRULE:FREQ=WEEKLY; EXDATE:20240422\nReminders: popup:10m, email:0m\nMeet: https://meet.google.com/abc\nVideo: https://meet.google.com/abc\nLink: https://calendar.example.com/e1"
	if got := formatEvent(&e); got != want {
		t.Fatalf("%q", got)
	}
	bare := event{ID: "e2", EventType: "default", Visibility: "default", Reminders: &reminders{UseDefault: true}}
	if got := formatEvent(&bare); got != "ID: e2\nSummary: (no title)\nStart: \nEnd: \nReminders: (calendar default)" {
		t.Fatalf("%q", got)
	}
	list := &eventList{Events: []event{e, bare}, NextPageToken: "tok"}
	want = "Events (2)\n\n[1] e1\n    Sync\n    Start: 2024-04-15T14:00:00-07:00\n    End: 2024-04-16\n    Location: Room 1\n    Attendees: 2\n    Meet: https://meet.google.com/abc\n\n[2] e2\n    (no title)\n    Start: \n    End: \n\n(more results available, use --page tok)"
	if got := formatEventList(list); got != want {
		t.Fatalf("%q", got)
	}
	if got := formatEventCreated(&e); got != "Event created\nID: e1\nSummary: Sync\nStart: 2024-04-15T14:00:00-07:00\nEnd: 2024-04-16\nMeet: https://meet.google.com/abc\nLink: https://calendar.example.com/e1" {
		t.Fatalf("%q", got)
	}
	if got := formatResponded(responded{Status: "accepted", Event: e}); got != "Response updated: accepted\nEvent: Sync\nLink: https://calendar.example.com/e1" {
		t.Fatalf("%q", got)
	}
}

// parseEvent keeps Bun's undefined-versus-empty distinction in --json.
func TestEventJSONKeepsBunsShape(t *testing.T) {
	fake := googletest.NewFakeAt(t, "/calendar/v3/", func(w http.ResponseWriter, h googletest.Hit) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"e1","summary":"","start":{"date":"2024-04-15"},"end":{"date":"2024-04-16"},"attendees":[],
			"reminders":{"useDefault":false,"overrides":[{"method":"popup","minutes":0}]},"creator":{"email":"c@example.com"},
			"conferenceData":{"conferenceId":"x"},"unknownField":1}`)
	})
	a, err := apiFrom(fake.Ctx(), host.NewRunContext(storedCreds(1), "acme", fake.Ctx()))
	if err != nil {
		t.Fatal(err)
	}
	got, err := a.getEvent("primary", "e1")
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"e1","start":{"date":"2024-04-15"},"end":{"date":"2024-04-16"},"creator":{"email":"c@example.com"},"attendees":[],"reminders":{"useDefault":false,"overrides":[{"method":"popup","minutes":0}]},"conferenceData":{}}`
	if raw, _ := json.Marshal(got); string(raw) != want {
		t.Fatalf("%s", raw)
	}
}
