package google

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	calendar "google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"
)

// fakeGoogle records every request and answers with handle.
type fakeGoogle struct {
	mu     sync.Mutex
	hits   []*http.Request
	forms  []url.Values
	handle func(w http.ResponseWriter, r *http.Request, n int)
	srv    *httptest.Server
}

func newFake(t *testing.T, handle func(w http.ResponseWriter, r *http.Request, n int)) *fakeGoogle {
	t.Helper()
	f := &fakeGoogle{handle: handle}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(raw))
		f.mu.Lock()
		f.hits = append(f.hits, r)
		f.forms = append(f.forms, form)
		n := len(f.hits)
		f.mu.Unlock()
		f.handle(w, r, n)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGoogle) ctx() context.Context {
	return WithEndpoints(context.Background(), Endpoints{
		API: f.srv.URL + "/api/", Token: f.srv.URL + "/token", UserInfo: f.srv.URL + "/userinfo",
	})
}

func (f *fakeGoogle) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.hits)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func noSleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var waits []time.Duration
	prev := sleep
	sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	t.Cleanup(func() { sleep = prev })
	return &waits
}

func hostFetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	return http.DefaultClient.Do(req.WithContext(ctx))
}

func setupContext(code string) *plugins.SetupContext {
	return &plugins.SetupContext{
		Log: func(...any) {},
		OAuth: func(_ context.Context, opts plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
			redirect := "http://localhost:3000/callback"
			if opts.AuthorizationURL(redirect) == "" {
				return plugins.OAuthSetupResult{}, errors.New("no authorize URL")
			}
			return plugins.OAuthSetupResult{Code: code, RedirectURI: redirect}, nil
		},
		Fetch: hostFetch,
		Fail: func(code plugins.ErrorCode, message, suggestion string) error {
			return errors.New(code + ": " + message)
		},
	}
}

// Port of tests/plugins/google/shared.test.ts: both formats and their expiry fields.
func TestBothKeyCasingsApplyAndUseTheirOwnExpiry(t *testing.T) {
	snake := map[string]any{"access_token": "a", "refresh_token": "r", "expiry_date": int64(10_000), "token_type": "Bearer"}
	camel := map[string]any{"accessToken": "a", "refreshToken": "r", "expiryDate": json.Number("10000"), "tokenType": "Bearer"}
	if !Snake.Applies(snake) || !Snake.IsStale(snake, 4_000, 6_000) {
		t.Fatal("snake")
	}
	if !Camel.Applies(camel) || Camel.IsStale(camel, 3_999, 6_000) || !Camel.IsStale(camel, 4_000, 6_000) {
		t.Fatal("camel")
	}
	// The wrong casing is not a Google token for that product.
	if Snake.Applies(camel) || Camel.Applies(snake) {
		t.Fatal("a lifecycle applied to the other casing")
	}
	if Camel.Applies(map[string]any{"type": "webhook", "webhookUrl": "https://example.com/hook"}) {
		t.Fatal("webhook profile applies")
	}
	if Snake.Applies(map[string]any{"refresh_token": ""}) || Snake.Applies(map[string]any{"refresh_token": 5}) {
		t.Fatal("empty or non-string refresh token applies")
	}
	// No expiry never refreshes; a stored null is JavaScript 0 and always does.
	if Snake.IsStale(map[string]any{"refresh_token": "r"}, 1<<60, 0) {
		t.Fatal("missing expiry is stale")
	}
	if !Snake.IsStale(map[string]any{"expiry_date": nil}, 0, 0) {
		t.Fatal("null expiry is not stale")
	}
}

func TestRedactionDropsTheRightRefreshFieldPerCasing(t *testing.T) {
	stub := func(id string, keys Keys) *plugins.Plugin {
		return &plugins.Plugin{
			APIVersion: plugins.APIVersion, ID: id, DisplayName: id, Description: id,
			Profile: &plugins.ProfileSpec{
				Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
					return nil, nil
				},
				Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
					return plugins.ValidationResult{}, nil
				},
				Refresh: keys.RefreshSpec(),
			},
			Commands: []plugins.CommandSpec{},
		}
	}
	reg, err := plugins.NewRegistry(stub("gmail", Snake), stub("gdocs", Camel))
	if err != nil {
		t.Fatal(err)
	}
	snake := map[string]any{"access_token": "a", "refresh_token": "r", "email": "me@example.com"}
	camel := map[string]any{"accessToken": "a", "refreshToken": "r", "refresh_token": "not-a-google-field-here"}
	gotSnake := auth.RedactForRemote(reg, "gmail", snake)
	gotCamel := auth.RedactForRemote(reg, "gdocs", camel)
	if _, ok := gotSnake["refresh_token"]; ok || gotSnake["access_token"] != "a" || gotSnake["email"] != "me@example.com" {
		t.Fatalf("snake %#v", gotSnake)
	}
	if _, ok := gotCamel["refreshToken"]; ok || gotCamel["accessToken"] != "a" || gotCamel["refresh_token"] == nil {
		t.Fatalf("camel %#v", gotCamel)
	}
	if snake["refresh_token"] != "r" || camel["refreshToken"] != "r" {
		t.Fatal("redaction changed the caller's map")
	}
}

func TestAuthorizeURLIsTheOneGoogleAuthLibraryBuilds(t *testing.T) {
	// Printed by google-auth-library 10.5 generateAuthUrl for the gcal scopes.
	want := "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email&prompt=consent&response_type=code&client_id=931954287794-4rflctl8lotok5d6rnd4o6teuk02lked.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback"
	if got := AuthorizeURL(Scopes["gcal"], "http://localhost:3000/callback"); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	for _, id := range []string{"gmail", "gchat", "gdocs", "gdrive-readonly", "gdrive-full", "gcal", "gtasks", "gsheets", "gslides", "gscript"} {
		s := Scopes[id]
		if len(s) == 0 || s[len(s)-1] != "https://www.googleapis.com/auth/userinfo.email" {
			t.Fatalf("%s scopes %v", id, s)
		}
	}
	if len(Scopes) != 10 {
		t.Fatalf("%d scope sets", len(Scopes))
	}
}

// Port of the shared.test.ts reauth case: the stored map is kept, the token
// fields are replaced under each casing, and the email is added.
func TestReauthenticateMergesEachCasingAndSendsTheBunTokenRequest(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		switch r.URL.Path {
		case "/token":
			writeJSON(w, 200, map[string]any{"access_token": "access-new", "refresh_token": "refresh-new", "expires_in": 3600, "token_type": "Bearer", "scope": "scope"})
		case "/userinfo":
			if r.Header.Get("Authorization") != "Bearer access-new" {
				w.WriteHeader(401)
				return
			}
			writeJSON(w, 200, map[string]any{"email": "user@example.com"})
		default:
			w.WriteHeader(404)
		}
	})
	before := time.Now().UnixMilli()
	snake, err := Reauthenticate("gslides", Snake)(fake.ctx(), map[string]any{
		"access_token": "old", "refresh_token": "old-refresh", "token_type": "Bearer", "custom": true,
	}, "work", setupContext("code-1"))
	if err != nil {
		t.Fatal(err)
	}
	camel, err := Reauthenticate("gscript", Camel)(fake.ctx(), map[string]any{
		"accessToken": "old", "refreshToken": "old-refresh", "tokenType": "Bearer", "custom": true,
	}, "work", setupContext("code-2"))
	if err != nil {
		t.Fatal(err)
	}
	if snake["access_token"] != "access-new" || snake["refresh_token"] != "refresh-new" || snake["email"] != "user@example.com" || snake["custom"] != true || snake["scope"] != "scope" {
		t.Fatalf("snake %#v", snake)
	}
	if camel["accessToken"] != "access-new" || camel["refreshToken"] != "refresh-new" || camel["email"] != "user@example.com" || camel["custom"] != true || camel["tokenType"] != "Bearer" {
		t.Fatalf("camel %#v", camel)
	}
	if _, leaked := camel["access_token"]; leaked {
		t.Fatalf("camel got a snake key %#v", camel)
	}
	exp, _ := asInt64(snake["expiry_date"])
	if exp < before+3600_000 || exp > time.Now().UnixMilli()+3600_000 {
		t.Fatalf("expiry %d", exp)
	}
	raw, _ := json.Marshal(camel)
	if !strings.Contains(string(raw), `"expiryDate":`+jsonText(camel["expiryDate"])) || strings.Contains(string(raw), `"expiryDate":"`) {
		t.Fatalf("expiry is not a JSON number: %s", raw)
	}
	form := fake.forms[0]
	if fake.hits[0].Method != "POST" || form.Get("grant_type") != "authorization_code" || form.Get("code") != "code-1" ||
		form.Get("redirect_uri") != "http://localhost:3000/callback" || form.Get("client_id") != clientID || form.Get("client_secret") == "" {
		t.Fatalf("token request %v", form)
	}
	if fake.hits[0].Header.Get("Authorization") != "" {
		t.Fatal("client secret sent as basic auth; Bun posts it in the body")
	}
}

func jsonText(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// A reauth that returns no refresh token drops the stored one: Bun spreads
// `refresh_token: undefined` and JSON.stringify omits it.
func TestReauthenticateWithoutARefreshTokenDropsTheOldOne(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		if r.URL.Path == "/token" {
			writeJSON(w, 200, map[string]any{"access_token": "access-new"})
			return
		}
		writeJSON(w, 200, map[string]any{"email": "user@example.com"})
	})
	got, err := Reauthenticate("gcal", Snake)(fake.ctx(), map[string]any{
		"access_token": "old", "refresh_token": "old-refresh", "expiry_date": int64(5), "scope": "old-scope",
	}, "p", setupContext("c"))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"refresh_token", "expiry_date", "scope"} {
		if _, ok := got[k]; ok {
			t.Fatalf("%s kept: %#v", k, got)
		}
	}
	if got["token_type"] != "Bearer" {
		t.Fatalf("token_type %#v", got)
	}
}

// google-auth-library puts the stored refresh token back on every refresh, so
// Bun never rotates it, even when Google returns a new one.
func TestRefreshKeepsTheStoredRefreshTokenAndScope(t *testing.T) {
	var body map[string]any
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		writeJSON(w, 200, body)
	})
	stored := map[string]any{"accessToken": "old", "refreshToken": "rt-old", "expiryDate": json.Number("1"), "tokenType": "Bearer", "scope": "s-old", "email": "me@example.com", "accessLevel": "full"}
	body = map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 60, "token_type": "Bearer"}
	got, err := Camel.Refresh(fake.ctx(), stored)
	if err != nil {
		t.Fatal(err)
	}
	if got["accessToken"] != "at-new" || got["refreshToken"] != "rt-old" || got["scope"] != "s-old" || got["email"] != "me@example.com" || got["accessLevel"] != "full" {
		t.Fatalf("%#v", got)
	}
	if stored["accessToken"] != "old" {
		t.Fatal("refresh modified the stored map")
	}
	form := fake.forms[0]
	if form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "rt-old" || form.Get("client_id") != clientID || form.Get("client_secret") == "" {
		t.Fatalf("refresh request %v", form)
	}
	// A new scope wins; no expires_in drops the expiry; no token_type is Bearer.
	body = map[string]any{"access_token": "at-2", "scope": "s-new"}
	got, err = Snake.Refresh(fake.ctx(), map[string]any{"access_token": "a", "refresh_token": "rt", "expiry_date": int64(9), "token_type": "bearer", "scope": "s-old"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["expiry_date"]; ok || got["scope"] != "s-new" || got["token_type"] != "Bearer" || got["refresh_token"] != "rt" {
		t.Fatalf("%#v", got)
	}
}

func TestRefreshFailureHasGoogleAuthLibrarysMessage(t *testing.T) {
	waits := noSleep(t)
	var status int
	var body string
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	})
	creds := map[string]any{"access_token": "a", "refresh_token": "rt"}
	status, body = 400, `{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}`
	if _, err := Snake.Refresh(fake.ctx(), creds); err == nil || err.Error() != "invalid_grant" {
		t.Fatalf("%v", err)
	}
	status, body = 400, `{"error": "invalid_grant", "error_description": "reauth related error (invalid_rapt)", "error_subtype": "invalid_rapt"}`
	if _, err := Snake.Refresh(fake.ctx(), creds); err == nil || err.Error() != `{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)","error_subtype":"invalid_rapt"}` {
		t.Fatalf("%v", err)
	}
	if len(*waits) != 0 {
		t.Fatal("a 400 was retried")
	}
	// The token POST is retried on 5xx, three times, as RETRY_CONFIG does.
	status, body = 503, `{"error": "backend_error"}`
	n := fake.count()
	if _, err := Snake.Refresh(fake.ctx(), creds); err == nil || err.Error() != "backend_error" {
		t.Fatalf("%v", err)
	}
	if fake.count()-n != 4 || len(*waits) != 3 || (*waits)[0] != 100*time.Millisecond || (*waits)[1] != 500*time.Millisecond || (*waits)[2] != 1500*time.Millisecond {
		t.Fatalf("%d requests, waits %v", fake.count()-n, *waits)
	}
	if _, err := Snake.Refresh(fake.ctx(), map[string]any{"access_token": "a"}); err == nil || err.Error() != "no refresh token stored" {
		t.Fatalf("%v", err)
	}
}

// The product client sends the stored access token and never goes to the
// token endpoint by itself, even with an expired expiry.
func TestNewServiceUsesTheStoredTokenAndNeverRefreshes(t *testing.T) {
	noSleep(t)
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, n int) {
		if r.URL.Path == "/token" {
			t.Error("the API client refreshed on its own")
		}
		if n == 1 {
			writeJSON(w, 503, map[string]any{"error": map[string]any{"code": 503, "message": "busy"}})
			return
		}
		writeJSON(w, 200, map[string]any{"id": "me@example.com"})
	})
	run := &plugins.RunContext{
		Credentials: map[string]any{"access_token": "at-stored", "refresh_token": "rt", "expiry_date": int64(1), "token_type": "Bearer"},
		Fetch:       hostFetch,
	}
	svc, err := NewService(fake.ctx(), run, Snake, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := svc.CalendarList.Get("primary").Do()
	if err != nil {
		t.Fatal(err)
	}
	if entry.Id != "me@example.com" || fake.count() != 2 {
		t.Fatalf("%#v %d", entry, fake.count())
	}
	for _, h := range fake.hits {
		if h.Header.Get("Authorization") != "Bearer at-stored" || h.URL.Path != "/api/users/me/calendarList/primary" {
			t.Fatalf("%s %s", h.URL.Path, h.Header.Get("Authorization"))
		}
	}
}

func TestPatchIsNotRetriedAndErrorsKeepGaxiosFields(t *testing.T) {
	waits := noSleep(t)
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		writeJSON(w, 500, map[string]any{"error": map[string]any{"code": 500, "message": "Backend Error", "errors": []any{map[string]any{"message": "inner"}}}})
	})
	run := &plugins.RunContext{Credentials: map[string]any{"accessToken": "a"}, Fetch: hostFetch}
	svc, err := NewService(fake.ctx(), run, Camel, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Events.Patch("primary", "e1", &calendar.Event{}).Do()
	if err == nil || Message(err) != "Backend Error" || Code(err) != 500 || ErrorCode(err) != "API_ERROR" {
		t.Fatalf("%v %q %d", err, Message(err), Code(err))
	}
	if fake.count() != 1 || len(*waits) != 0 {
		t.Fatalf("PATCH retried: %d", fake.count())
	}
}

func TestGaxiosMessageAndCode(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{404, `{"error":{"code":404,"message":"Not Found","errors":[{"message":"m1"},{"message":"m2"}]}}`, "Not Found"},
		{404, `{"error":{"code":404,"errors":[{"message":"m1"},{"message":"m2"}]}}`, "m1\nm2"},
		{404, `{"error":{"message":"only"}}`, "only"},
		{400, `{"error":"invalid_grant","error_description":"x"}`, "invalid_grant"},
		{404, `plain text`, "plain text"},
		{404, `{"foo":1}`, "Request failed with status code 404"},
		{404, ``, ""},
	}
	for _, c := range cases {
		if got := gaxiosMessage(c.status, []byte(c.body)); got != c.want {
			t.Errorf("%s: got %q want %q", c.body, got, c.want)
		}
	}
	for status, want := range map[int]plugins.ErrorCode{401: "AUTH_FAILED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RATE_LIMITED", 500: "API_ERROR", 400: "API_ERROR"} {
		if StatusToErrorCode(status) != want {
			t.Errorf("%d", status)
		}
	}
	plain := errors.New("dial tcp: refused")
	if Message(plain) != "dial tcp: refused" || Code(plain) != 0 || IsNotFound(plain) || ErrorCode(plain) != "API_ERROR" {
		t.Fatal("non-HTTP error")
	}
}

func TestValidationFailureNamesAnExpiredGrant(t *testing.T) {
	if v := ValidationFailure(errors.New("invalid_grant")); v.Valid || v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
	if v := ValidationFailure(errors.New("Token has been expired or revoked.")); v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
	if v := ValidationFailure(errors.New("Request had insufficient authentication scopes.")); v.Valid || v.Error != "Request had insufficient authentication scopes." {
		t.Fatalf("%#v", v)
	}
}

func TestFormatBytesMatchesBun(t *testing.T) {
	// Printed by src/plugins/google/format.ts formatBytes.
	want := map[int64]string{
		0: "0 B", 1: "1 B", 1023: "1023 B", 1024: "1 KB", 1075: "1 KB", 1126: "1.1 KB", 1280: "1.3 KB",
		1331: "1.3 KB", 1536: "1.5 KB", 10239: "10 KB", 1048576: "1 MB", 1572864: "1.5 MB",
		1073741824: "1 GB", 5368709120: "5 GB", 1099511627776: "1 undefined",
	}
	for in, w := range want {
		if got := FormatBytes(in); got != w {
			t.Errorf("%d: got %q want %q", in, got, w)
		}
	}
}

// A failed call returning a typed nil must come back as an untyped nil, or the
// host would print "null" before the error.
func TestResultDropsTheTypedNilOnFailure(t *testing.T) {
	var none *calendar.Event
	v, err := Result(none, errors.New("boom"))
	if v != nil || err == nil {
		t.Fatalf("%#v %v", v, err)
	}
	// A value that came with an error is dropped too.
	v, _ = Result(&calendar.Event{Id: "x"}, errors.New("boom"))
	if v != nil {
		t.Fatalf("%#v", v)
	}
	if v, err := Result([]string{}, nil); err != nil || v == nil {
		t.Fatalf("%#v %v", v, err)
	}
}

func TestRequireOptionsReportsTheFirstMissingInDeclarationOrder(t *testing.T) {
	var got []string
	run := &plugins.RunContext{Fail: func(code plugins.ErrorCode, message, suggestion string) error {
		got = append(got, string(code)+"|"+message+"|"+suggestion)
		return errors.New(message)
	}}
	in := plugins.CommandInput{Options: map[string]any{"space": "", "limit": true, "query": "q"}}
	if err := RequireOptions(in, run, "--query <q>", "--limit <n>", "--space <id>"); err == nil {
		t.Fatal("a bool where a string is required passed")
	}
	if err := RequireOptions(in, run, "--space <id>"); err == nil {
		t.Fatal("an empty string passed")
	}
	if err := RequireOptions(in, run, "--missing <x>"); err == nil {
		t.Fatal("an absent option passed")
	}
	want := []string{
		"INVALID_PARAMS|required option '--limit <n>' not specified|",
		"INVALID_PARAMS|required option '--space <id>' not specified|",
		"INVALID_PARAMS|required option '--missing <x>' not specified|",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%q", got)
	}
	if err := RequireOptions(in, run, "--query <q>"); err != nil {
		t.Fatal(err)
	}
}

func TestISOStringIsUTCWithTruncatedMilliseconds(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 999_999_999, time.FixedZone("", -5*3600))
	if got := ISOString(at); got != "2026-01-02T08:04:05.999Z" {
		t.Fatal(got)
	}
	if got := ISOString(time.Date(1999, 12, 31, 23, 59, 59, 0, time.UTC)); got != "1999-12-31T23:59:59.000Z" {
		t.Fatal(got)
	}
}

func TestStatusMessageUsesTheProductTextFor403And404(t *testing.T) {
	apiErr := func(status int) error {
		return &googleapi.Error{Code: status, Body: fmt.Sprintf(`{"error":{"code":%d,"message":"server says"}}`, status)}
	}
	cases := map[int]string{
		401: "OAuth token expired or invalid",
		403: "no access",
		404: "gone",
		429: "Rate limit exceeded, please try again later",
		500: "server says",
		400: "server says",
	}
	for status, want := range cases {
		if got := StatusMessage(apiErr(status), "no access", "gone"); got != want {
			t.Errorf("%d: %q", status, got)
		}
	}
	// The body's error.code wins over the HTTP status, as error.code || error.status does.
	mixed := &googleapi.Error{Code: 400, Body: `{"error":{"code":404,"message":"x"}}`}
	if got := StatusMessage(mixed, "no access", "gone"); got != "gone" {
		t.Fatalf("%q", got)
	}
	if got := StatusMessage(errors.New("socket hang up"), "a", "b"); got != "socket hang up" {
		t.Fatalf("%q", got)
	}
}

func TestCallJSONSendsTheBodyVerbatimAndMapsErrors(t *testing.T) {
	waits := noSleep(t)
	var bodies []string
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, n int) {
		if r.Header.Get("Authorization") != "Bearer at-stored" {
			t.Errorf("auth %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/api/v1/docs/d1:batchUpdate":
			if r.Header.Get("Content-Type") != "application/json" {
				t.Errorf("content type %q", r.Header.Get("Content-Type"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"replies":[{}],"documentId":"d1"}`))
		case "/api/v1/docs/busy":
			writeJSON(w, 503, map[string]any{"error": map[string]any{"code": 503, "message": "busy"}})
		default:
			writeJSON(w, 404, map[string]any{"error": map[string]any{"code": 404, "message": "Requested entity was not found."}})
		}
	})
	fake.srv.Config.Handler = func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			bodies = append(bodies, string(raw))
			r.Body = io.NopCloser(strings.NewReader(string(raw)))
			next.ServeHTTP(w, r)
		})
	}(fake.srv.Config.Handler)
	run := &plugins.RunContext{Credentials: map[string]any{"accessToken": "at-stored"}, Fetch: hostFetch}
	base := fake.srv.URL + "/api/"
	body := `[{"updateTextStyle":{"textStyle":{"bold":false},"fields":"bold","unknownField":1}}]`
	v, err := CallJSON(context.Background(), run, Camel, "POST", base, "v1/docs/d1:batchUpdate", []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if bodies[0] != body {
		t.Fatalf("body rewritten: %s", bodies[0])
	}
	if out, _ := v.(*jsvalue.Object).MarshalJSON(); string(out) != `{"replies":[{}],"documentId":"d1"}` {
		t.Fatalf("%s", out)
	}
	// A failed POST is not retried (gaxios leaves POST alone).
	_, err = CallJSON(context.Background(), run, Camel, "POST", base, "v1/docs/busy", []byte(`[]`))
	if err == nil || Code(err) != 503 || Message(err) != "busy" || len(*waits) != 0 {
		t.Fatalf("%v %d waits", err, len(*waits))
	}
	// A GET is, and a 404 maps like any googleapis failure.
	_, err = CallJSON(context.Background(), run, Camel, "GET", base, "v1/docs/busy", nil)
	if err == nil || len(*waits) != 3 || bodies[len(bodies)-1] != "" {
		t.Fatalf("%v %d waits", err, len(*waits))
	}
	_, err = CallJSON(context.Background(), run, Camel, "GET", base, "v1/docs/nope", nil)
	if ErrorCode(err) != "NOT_FOUND" || StatusMessage(err, "f", "Document not found") != "Document not found" {
		t.Fatalf("%v", err)
	}
}
