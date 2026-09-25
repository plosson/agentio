package google

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/testbox"
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
		Fetch: plugins.Fetch,
		Fail: func(code plugins.ErrorCode, message, suggestion string) error {
			return errors.New(code + ": " + message)
		},
	}
}

// Port of tests/plugins/google/shared.test.ts: both formats and their expiry fields.
func TestBothKeyCasingsApplyAndUseTheirOwnExpiry(t *testing.T) {
	snake := map[string]any{"access_token": "a", "refresh_token": "r", "expiry_date": int64(10_000), "token_type": "Bearer"}
	camel := map[string]any{"accessToken": "a", "refreshToken": "r", "expiryDate": json.Number("10000"), "tokenType": "Bearer"}
	if !Snake.Applies(testbox.Object(snake)) || !Snake.IsStale(testbox.Object(snake), 4_000, 6_000) {
		t.Fatal("snake")
	}
	if !Camel.Applies(testbox.Object(camel)) || Camel.IsStale(testbox.Object(camel), 3_999, 6_000) || !Camel.IsStale(testbox.Object(camel), 4_000, 6_000) {
		t.Fatal("camel")
	}
	// The wrong casing is not a Google token for that product.
	if Snake.Applies(testbox.Object(camel)) || Camel.Applies(testbox.Object(snake)) {
		t.Fatal("a lifecycle applied to the other casing")
	}
	if Camel.Applies(testbox.Object(map[string]any{"type": "webhook", "webhookUrl": "https://example.com/hook"})) {
		t.Fatal("webhook profile applies")
	}
	if Snake.Applies(testbox.Object(map[string]any{"refresh_token": ""})) || Snake.Applies(testbox.Object(map[string]any{"refresh_token": 5})) {
		t.Fatal("empty or non-string refresh token applies")
	}
	// No expiry never refreshes; a stored null is JavaScript 0 and always does.
	if Snake.IsStale(testbox.Object(map[string]any{"refresh_token": "r"}), 1<<60, 0) {
		t.Fatal("missing expiry is stale")
	}
	if !Snake.IsStale(testbox.Object(map[string]any{"expiry_date": nil}), 0, 0) {
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
	gotSnake := auth.RedactForRemote(reg, "gmail", testbox.Object(snake))
	gotCamel := auth.RedactForRemote(reg, "gdocs", testbox.Object(camel))
	if _, ok := gotSnake.Get("refresh_token"); ok || gotSnake.Value("access_token") != "a" || gotSnake.Value("email") != "me@example.com" {
		t.Fatalf("snake %#v", gotSnake)
	}
	if _, ok := gotCamel.Get("refreshToken"); ok || gotCamel.Value("accessToken") != "a" || gotCamel.Value("refresh_token") == nil {
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
	snake, err := Reauthenticate("gslides", Snake)(fake.ctx(), testbox.Object(map[string]any{
		"access_token": "old", "refresh_token": "old-refresh", "token_type": "Bearer", "custom": true,
	}), "work", setupContext("code-1"))
	if err != nil {
		t.Fatal(err)
	}
	camel, err := Reauthenticate("gscript", Camel)(fake.ctx(), testbox.Object(map[string]any{
		"accessToken": "old", "refreshToken": "old-refresh", "tokenType": "Bearer", "custom": true,
	}), "work", setupContext("code-2"))
	if err != nil {
		t.Fatal(err)
	}
	if snake.Value("access_token") != "access-new" || snake.Value("refresh_token") != "refresh-new" || snake.Value("email") != "user@example.com" || snake.Value("custom") != true || snake.Value("scope") != "scope" {
		t.Fatalf("snake %#v", snake)
	}
	if camel.Value("accessToken") != "access-new" || camel.Value("refreshToken") != "refresh-new" || camel.Value("email") != "user@example.com" || camel.Value("custom") != true || camel.Value("tokenType") != "Bearer" {
		t.Fatalf("camel %#v", camel)
	}
	if _, leaked := camel.Get("access_token"); leaked {
		t.Fatalf("camel got a snake key %#v", camel)
	}
	exp, _ := asInt64(snake.Value("expiry_date"))
	if exp < before+3600_000 || exp > time.Now().UnixMilli()+3600_000 {
		t.Fatalf("expiry %d", exp)
	}
	raw, _ := json.Marshal(camel)
	if !strings.Contains(string(raw), `"expiryDate":`+jsonText(camel.Value("expiryDate"))) || strings.Contains(string(raw), `"expiryDate":"`) {
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
	got, err := Reauthenticate("gcal", Snake)(fake.ctx(), testbox.Object(map[string]any{
		"access_token": "old", "refresh_token": "old-refresh", "expiry_date": int64(5), "scope": "old-scope",
	}), "p", setupContext("c"))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"refresh_token", "expiry_date", "scope"} {
		if _, ok := testbox.Map(got)[k]; ok {
			t.Fatalf("%s kept: %#v", k, got)
		}
	}
	if got.Value("token_type") != "Bearer" {
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
	got, err := Camel.Refresh(fake.ctx(), testbox.Object(stored))
	if err != nil {
		t.Fatal(err)
	}
	if got.Value("accessToken") != "at-new" || got.Value("refreshToken") != "rt-old" || got.Value("scope") != "s-old" || got.Value("email") != "me@example.com" || got.Value("accessLevel") != "full" {
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
	got, err = Snake.Refresh(fake.ctx(), testbox.Object(map[string]any{"access_token": "a", "refresh_token": "rt", "expiry_date": int64(9), "token_type": "bearer", "scope": "s-old"}))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := testbox.Map(got)["expiry_date"]; ok || got.Value("scope") != "s-new" || got.Value("token_type") != "Bearer" || got.Value("refresh_token") != "rt" {
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
	if _, err := Snake.Refresh(fake.ctx(), testbox.Object(creds)); err == nil || err.Error() != "invalid_grant" {
		t.Fatalf("%v", err)
	}
	status, body = 400, `{"error": "invalid_grant", "error_description": "reauth related error (invalid_rapt)", "error_subtype": "invalid_rapt"}`
	if _, err := Snake.Refresh(fake.ctx(), testbox.Object(creds)); err == nil || err.Error() != `{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)","error_subtype":"invalid_rapt"}` {
		t.Fatalf("%v", err)
	}
	if len(*waits) != 0 {
		t.Fatal("a 400 was retried")
	}
	// The token POST is retried on 5xx, three times, as RETRY_CONFIG does.
	status, body = 503, `{"error": "backend_error"}`
	n := fake.count()
	if _, err := Snake.Refresh(fake.ctx(), testbox.Object(creds)); err == nil || err.Error() != "backend_error" {
		t.Fatalf("%v", err)
	}
	if fake.count()-n != 4 || len(*waits) != 3 || (*waits)[0] != 100*time.Millisecond || (*waits)[1] != 500*time.Millisecond || (*waits)[2] != 1500*time.Millisecond {
		t.Fatalf("%d requests, waits %v", fake.count()-n, *waits)
	}
	if _, err := Snake.Refresh(fake.ctx(), testbox.Object(map[string]any{"access_token": "a"})); err == nil || err.Error() != "no refresh token stored" {
		t.Fatalf("%v", err)
	}
}

// The product client sends the stored access token while it is not expiring
// and does not go to the token endpoint for it.
func TestNewServiceUsesTheStoredTokenWhileItIsFresh(t *testing.T) {
	noSleep(t)
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, n int) {
		if r.URL.Path == "/token" {
			t.Error("the API client refreshed a fresh token")
		}
		if n == 1 {
			writeJSON(w, 503, map[string]any{"error": map[string]any{"code": 503, "message": "busy"}})
			return
		}
		writeJSON(w, 200, map[string]any{"id": "me@example.com"})
	})
	run := &plugins.RunContext{
		Credentials: testbox.Object(map[string]any{"access_token": "at-stored", "refresh_token": "rt", "expiry_date": time.Now().Add(time.Hour).UnixMilli(), "token_type": "mac"}),
		Fetch:       plugins.Fetch,
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
		// createGoogleAuth sets no token_type: the library sends Bearer.
		if h.Header.Get("Authorization") != "Bearer at-stored" || h.URL.Path != "/api/users/me/calendarList/primary" {
			t.Fatalf("%s %s", h.URL.Path, h.Header.Get("Authorization"))
		}
	}
}

// The client is google-auth-library's OAuth2Client over the stored tokens:
// no token at all fails before any request with the library's message; an
// expiring token is refreshed in memory first; a 401 or 403 with both tokens
// and no expiry refreshes once and sends the request again. Nothing is
// written back (Bun does not listen for the refreshed tokens).
func TestTheClientRefreshesAsOAuth2ClientDoes(t *testing.T) {
	noSleep(t)
	type call struct{ path, auth string }
	cases := []struct {
		name  string
		creds map[string]any
		api   []int // statuses the API answers in turn
		token int   // token endpoint status
		calls []call
		err   string
	}{
		{"no tokens", map[string]any{"email": "x"}, nil, 200, nil,
			"No access, refresh token, API key or refresh handler callback is set."},
		{"refresh token only", map[string]any{"refresh_token": "rt"}, []int{200}, 200,
			[]call{{"/token", ""}, {"/api/users/me/calendarList/primary", "Bearer at-new"}}, ""},
		{"expiring", map[string]any{"access_token": "old", "refresh_token": "rt", "expiry_date": int64(1)}, []int{200}, 200,
			[]call{{"/token", ""}, {"/api/users/me/calendarList/primary", "Bearer at-new"}}, ""},
		{"expiring, no refresh token", map[string]any{"access_token": "old", "expiry_date": int64(1)}, nil, 200, nil,
			"No refresh token is set."},
		{"expiring, token endpoint 403", map[string]any{"access_token": "old", "refresh_token": "rt", "expiry_date": int64(1)}, nil, 403,
			[]call{{"/token", ""}}, "Could not refresh access token: denied"},
		{"401 without expiry", map[string]any{"access_token": "old", "refresh_token": "rt"}, []int{401, 200}, 200,
			[]call{{"/api/users/me/calendarList/primary", "Bearer old"}, {"/token", ""}, {"/api/users/me/calendarList/primary", "Bearer at-new"}}, ""},
		{"403 twice", map[string]any{"access_token": "old", "refresh_token": "rt"}, []int{403, 403}, 200,
			[]call{{"/api/users/me/calendarList/primary", "Bearer old"}, {"/token", ""}, {"/api/users/me/calendarList/primary", "Bearer at-new"}}, "nope"},
		{"401 with an expiry", map[string]any{"access_token": "old", "refresh_token": "rt", "expiry_date": time.Now().Add(time.Hour).UnixMilli()}, []int{401}, 200,
			[]call{{"/api/users/me/calendarList/primary", "Bearer old"}}, "nope"},
		{"401 without a refresh token", map[string]any{"access_token": "old"}, []int{401}, 200,
			[]call{{"/api/users/me/calendarList/primary", "Bearer old"}}, "nope"},
		{"401, refresh fails", map[string]any{"access_token": "old", "refresh_token": "rt"}, []int{401}, 403,
			[]call{{"/api/users/me/calendarList/primary", "Bearer old"}, {"/token", ""}}, "denied"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			api := 0
			fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
				if r.URL.Path == "/token" {
					if c.token != 200 {
						writeJSON(w, c.token, map[string]any{"error": "denied"})
						return
					}
					writeJSON(w, 200, map[string]any{"access_token": "at-new", "expires_in": 3600, "token_type": "Bearer"})
					return
				}
				status := c.api[api]
				api++
				if status != 200 {
					writeJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": "nope"}})
					return
				}
				writeJSON(w, 200, map[string]any{"id": "me@example.com"})
			})
			creds := map[string]any{}
			for k, v := range c.creds {
				creds[k] = v
			}
			svc, err := NewService(fake.ctx(), &plugins.RunContext{Credentials: testbox.Object(creds), Fetch: plugins.Fetch}, Snake, calendar.NewService)
			if err != nil {
				t.Fatal(err)
			}
			_, err = svc.CalendarList.Get("primary").Do()
			got := ""
			if err != nil {
				got = Message(err)
			}
			if got != c.err {
				t.Fatalf("error %q, want %q", got, c.err)
			}
			var calls []call
			for _, h := range fake.hits {
				calls = append(calls, call{h.URL.Path, h.Header.Get("Authorization")})
			}
			if fmt.Sprint(calls) != fmt.Sprint(c.calls) {
				t.Fatalf("calls %v, want %v", calls, c.calls)
			}
			if fmt.Sprint(creds) != fmt.Sprint(c.creds) {
				t.Fatalf("stored credentials changed: %v", creds)
			}
		})
	}
}

func TestPatchIsNotRetriedAndErrorsKeepGaxiosFields(t *testing.T) {
	waits := noSleep(t)
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		writeJSON(w, 500, map[string]any{"error": map[string]any{"code": 500, "message": "Backend Error", "errors": []any{map[string]any{"message": "inner"}}}})
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"accessToken": "a"}), Fetch: plugins.Fetch}
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
	// The body's error.code wins over the HTTP status, and both go through
	// Bun's httpStatusToErrorCode.
	for _, c := range []struct {
		status int
		body   string
		want   plugins.ErrorCode
	}{
		{401, "", "AUTH_FAILED"}, {403, "", "PERMISSION_DENIED"}, {404, "", "NOT_FOUND"}, {429, "", "RATE_LIMITED"},
		{500, "", "API_ERROR"}, {400, "", "API_ERROR"},
		{500, `{"error":{"code":404,"message":"gone"}}`, "NOT_FOUND"},
		{403, `{"error":{"code":"x","message":"odd"}}`, "API_ERROR"},
	} {
		if got := ErrorCode(&googleapi.Error{Code: c.status, Body: c.body}); got != c.want {
			t.Errorf("%d %s: %q, want %q", c.status, c.body, got, c.want)
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
	// Sizes as an answer may give them; printed by Bun's formatBytes.
	for _, c := range []struct {
		in   any
		want string
	}{
		{json.Number("0"), "0 B"}, {"0", "NaN undefined"}, {nil, "NaN undefined"}, {jsvalue.Undefined, "NaN undefined"},
		{-5.0, "NaN undefined"}, {0.5, "512 undefined"}, {math.NaN(), "NaN undefined"}, {"2048", "2 KB"},
		{"abc", "NaN undefined"}, {1.5, "1.5 B"}, {true, "1 B"}, {[]any{json.Number("3000")}, "2.9 KB"},
	} {
		if got := FormatBytes(c.in); got != c.want {
			t.Errorf("%#v: got %q want %q", c.in, got, c.want)
		}
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
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"accessToken": "at-stored"}), Fetch: plugins.Fetch}
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

// Every Drive-backed product sends the Camel access token and Bun's capped,
// NaN-preserving pageSize.
func TestDriveServiceUsesCamelTokensAndPageSizeCapsLikeMathMin(t *testing.T) {
	var sizes []string
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, n int) {
		if r.Header.Get("Authorization") != "Bearer at-camel" || r.URL.Path != "/api/files" {
			t.Errorf("%s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		sizes = append(sizes, r.URL.Query().Get("pageSize"))
		writeJSON(w, 200, map[string]any{"files": []any{}})
	})
	run := &plugins.RunContext{
		// A Snake key must not be read by a Drive client.
		Credentials: testbox.Object(map[string]any{"accessToken": "at-camel", "access_token": "at-snake", "tokenType": "Bearer"}),
		Fetch:       plugins.Fetch,
	}
	svc, err := DriveService(fake.ctx(), run)
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []float64{1, 100, 101, 250, 0, -3, math.NaN()} {
		if _, err := svc.Files.List().Do(PageSize(limit)); err != nil {
			t.Fatal(err)
		}
	}
	if got := strings.Join(sizes, ","); got != "1,100,100,100,0,-3,NaN" {
		t.Fatalf("pageSize %s", got)
	}
}

// Setup is the gdocs/gsheets/gslides/gscript profile.setup: Camel keys, the
// product's scopes and log line, and Bun's email failure.
func TestSetupStoresCamelKeysAndNamesTheProduct(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		switch r.URL.Path {
		case "/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 60, "token_type": "Bearer"})
		case "/userinfo":
			writeJSON(w, 200, map[string]any{"email": "user@example.com"})
		}
	})
	sc := setupContext("code-1")
	var logs, scopes []string
	sc.Log = func(parts ...any) { logs = append(logs, fmt.Sprint(parts...)) }
	oauth := sc.OAuth
	sc.OAuth = func(ctx context.Context, opts plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		u, _ := url.Parse(opts.AuthorizationURL("http://localhost:3000/callback"))
		scopes = append(scopes, u.Query().Get("scope"))
		return oauth(ctx, opts)
	}
	res, err := Setup("gslides", "Google Slides")(fake.ctx(), plugins.SetupOptions{}, sc)
	if err != nil {
		t.Fatal(err)
	}
	if res.Credentials.Value("accessToken") != "at-1" || res.Credentials.Value("refreshToken") != "rt-1" || res.Credentials.Value("email") != "user@example.com" {
		t.Fatalf("%#v", res.Credentials)
	}
	if ok := res.Credentials.Has("access_token"); ok {
		t.Fatal("snake_case key")
	}
	if res.SuggestedProfileName != "user@example.com" || res.Info != "Email: user@example.com\nTest with: agentio gslides list" {
		t.Fatalf("%#v", res)
	}
	if strings.Join(logs, "|") != "Starting OAuth flow for Google Slides...\n" || scopes[0] != strings.Join(Scopes["gslides"], " ") {
		t.Fatalf("%q %q", logs, scopes)
	}
	fake.handle = func(w http.ResponseWriter, r *http.Request, _ int) {
		if r.URL.Path == "/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-1"})
			return
		}
		w.WriteHeader(500)
	}
	var failed []string
	sc.Fail = func(code plugins.ErrorCode, message, suggestion string) error {
		failed = append(failed, code+"|"+message+"|"+suggestion)
		return errors.New(message)
	}
	if _, err := Setup("gscript", "Google Apps Script")(fake.ctx(), plugins.SetupOptions{}, sc); err == nil ||
		strings.Join(failed, "") != "AUTH_FAILED|Failed to fetch user email: Failed to fetch user info: 500|Ensure the account has an email address" {
		t.Fatalf("%v %q", err, failed)
	}
	if EmailListInfo(testbox.Object(map[string]any{"email": "me@example.com"})) != " - me@example.com" || EmailListInfo(testbox.Object(map[string]any{"email": 1})) != "" {
		t.Fatal("list info")
	}
}

// ListDriveFiles, FormatDriveFiles and ValidateDriveFiles are the Drive list
// and validate the Drive-backed products share.
func TestDriveFilesListFormatAndValidate(t *testing.T) {
	var status int
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		if status != 200 {
			writeJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": "invalid_grant"}})
			return
		}
		writeJSON(w, 200, map[string]any{"files": []any{
			map[string]any{"id": "p1", "name": "Deck", "owners": []any{map[string]any{"displayName": "", "emailAddress": "ann@example.com"}}, "createdTime": "c", "modifiedTime": "m"},
			map[string]any{"id": "p2", "owners": []any{}, "webViewLink": "https://example.com/p2"},
		}})
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"accessToken": "at", "email": "me@example.com"}), Fetch: plugins.Fetch}
	svc, err := DriveService(fake.ctx(), run)
	if err != nil {
		t.Fatal(err)
	}
	status = 200
	files, err := ListDriveFiles(fake.ctx(), svc, "application/x-thing", "starred = true", 7, "https://example.com/d/")
	if err != nil {
		t.Fatal(err)
	}
	q := fake.hits[0].URL.Query()
	if q.Get("q") != "mimeType='application/x-thing' and trashed=false and starred = true" || q.Get("pageSize") != "7" ||
		q.Get("fields") != "files(id,name,owners,createdTime,modifiedTime,webViewLink)" || q.Get("orderBy") != "modifiedTime desc" {
		t.Fatalf("%v", q)
	}
	if got := jsonText(files); got != `[{"id":"p1","title":"Deck","owner":"ann@example.com","createdTime":"c","modifiedTime":"m","webViewLink":"https://example.com/d/p1"},{"id":"p2","title":"Untitled","webViewLink":"https://example.com/p2"}]` {
		t.Fatal(got)
	}
	want := "Things (2)\n\n[1] Deck\n    ID: p1\n    Owner: ann@example.com\n    Modified: m\n    Link: https://example.com/d/p1\n\n[2] Untitled\n    ID: p2\n    Link: https://example.com/p2\n"
	if got := FormatDriveFiles(files, "Things", "No things found"); got != want {
		t.Fatalf("%q", got)
	}
	if FormatDriveFiles([]any{}, "Things", "No things found") != "No things found" || FormatDriveFiles(nil, "Things", "none") != "none" {
		t.Fatal("empty list")
	}
	v, err := ValidateDriveFiles("application/x-thing")(fake.ctx(), run)
	if err != nil || !v.Valid || v.Info != "me@example.com" {
		t.Fatalf("%#v %v", v, err)
	}
	if q := fake.hits[1].URL.Query(); q.Get("pageSize") != "1" || q.Get("q") != "mimeType='application/x-thing'" {
		t.Fatalf("%v", q)
	}
	status = 400
	if v, _ := ValidateDriveFiles("application/x-thing")(fake.ctx(), run); v.Valid || v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
	if _, err := ListDriveFiles(fake.ctx(), svc, "application/x-thing", "", 10, ""); Code(err) != 400 {
		t.Fatalf("list error %v", err)
	}
}

// The Drive list and copy read the answer as Bun does: a missing id prints
// "undefined" (in the link too), a null owner is skipped by `?.`, a null file
// is Bun's TypeError. Expected text is the Bun CLI's for the same answers.
func TestDriveListAndCopyReadMissingFieldsAsBun(t *testing.T) {
	var body string
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"accessToken": "at"}), Fetch: plugins.Fetch}
	svc, err := DriveService(fake.ctx(), run)
	if err != nil {
		t.Fatal(err)
	}
	body = `{"files":[{"name":"","owners":[null,{"displayName":"x"}]},{"id":"b","owners":null,"modifiedTime":""}]}`
	files, err := ListDriveFiles(fake.ctx(), svc, "m", "", 10, "https://docs.google.com/document/d/")
	if err != nil {
		t.Fatal(err)
	}
	want := "Documents (2)\n\n[1] Untitled\n    ID: undefined\n    Link: https://docs.google.com/document/d/undefined\n\n[2] Untitled\n    ID: b\n    Link: https://docs.google.com/document/d/b\n"
	if got := FormatDriveFiles(files, "Documents", "No documents found"); got != want {
		t.Fatalf("%q", got)
	}
	body = `null`
	if _, err := ListDriveFiles(fake.ctx(), svc, "m", "", 10, ""); err == nil || err.Error() != "null is not an object (evaluating '(await this.drive.files.list({\n        pageSize: Math.min(limit, 100),\n        q,\n        fields: \"files(id,name,owners,createdTime,modifiedTime,webViewLink)\",\n        orderBy: \"modifiedTime desc\"\n      })).data.files')" {
		t.Fatalf("%v", err)
	}
	body = `{"files":[null]}`
	if _, err := ListDriveFiles(fake.ctx(), svc, "m", "", 10, ""); err == nil || err.Error() != "null is not an object (evaluating 'file.id')" {
		t.Fatalf("%v", err)
	}
	a := API{Ctx: fake.ctx(), RunContext: &plugins.RunContext{Credentials: run.Credentials, Fetch: plugins.Fetch,
		Fail: func(code plugins.ErrorCode, message, _ string) error { return errors.New(code + ": " + message) }},
		ErrorMessage: func(err error) string { return Message(err) }}
	body = `{}`
	c, err := a.CopyDriveFile(svc, "S1", "T", "", "copy spreadsheet", "https://docs.google.com/spreadsheets/d/")
	if err != nil {
		t.Fatal(err)
	}
	if got := FormatCreatedFile(c, "Spreadsheet created"); got != "Spreadsheet created\nID: undefined\nTitle: T\nURL: https://docs.google.com/spreadsheets/d/undefined" {
		t.Fatalf("%q", got)
	}
	body = `null`
	if _, err := a.CopyDriveFile(svc, "S1", "T", "", "copy spreadsheet", ""); err == nil || err.Error() != "API_ERROR: Failed to copy spreadsheet: null is not an object (evaluating 'response.data.id')" {
		t.Fatalf("%v", err)
	}
}

// BatchRequests is the --requests-json / --file input of the batch escape
// hatches, rejected with Bun's messages before the profile is used.
func TestBatchRequestsReadsExactlyOneSourceAsAnArray(t *testing.T) {
	fail := func(code plugins.ErrorCode, message, suggestion string) error {
		return errors.New(code + "|" + message + "|" + suggestion)
	}
	file := filepath.Join(t.TempDir(), "requests.json")
	if err := os.WriteFile(file, []byte(`[{"b":1,"a":{"x":false}}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, opts := range []map[string]any{{"requests-json": `[{"b":1,"a":{"x":false}}]`, "file": ""}, {"file": file}} {
		got, err := BatchRequests(plugins.CommandInput{Options: opts}, fail)
		if err != nil || string(jsvalue.Stringify(got)) != `[{"b":1,"a":{"x":false}}]` {
			t.Fatalf("%v: %s %v", opts, jsvalue.Stringify(got), err)
		}
	}
	for _, c := range []struct {
		opts map[string]any
		want string
	}{
		{map[string]any{}, "INVALID_PARAMS|Provide --requests-json or --file|"},
		{map[string]any{"requests-json": "[]", "file": file}, "INVALID_PARAMS|--requests-json and --file are mutually exclusive|"},
		{map[string]any{"requests-json": "[1,"}, "INVALID_PARAMS|Invalid JSON: JSON Parse error: Unexpected EOF|"},
		// Bun `options.requestsJson ?? readFile(options.file)`: a given "" is
		// the source, even beside --file.
		{map[string]any{"requests-json": "", "file": file}, "INVALID_PARAMS|Invalid JSON: JSON Parse error: Unexpected EOF|"},
		{map[string]any{"requests-json": `{"a":1}`}, "INVALID_PARAMS|Input must be a JSON array of Request objects|"},
	} {
		in := plugins.CommandInput{Options: c.opts}
		if _, err := BatchRequests(in, fail); err == nil || err.Error() != c.want {
			t.Fatalf("%v: %v", c.opts, err)
		}
	}
	// Bun readFile's rejection, as Node words it.
	missing := filepath.Join(t.TempDir(), "missing.json")
	if _, err := BatchRequests(plugins.CommandInput{Options: map[string]any{"file": missing}}, fail); err == nil || err.Error() != "ENOENT: no such file or directory, open '"+missing+"'" {
		t.Fatalf("missing file: %v", err)
	}
}

// Math.min(limit, max) on the query string, NaN and negatives passed through.
func TestMaxResultsCapsLikeMathMin(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, n int) {
		writeJSON(w, 200, map[string]any{"items": []any{}})
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"access_token": "at"}), Fetch: plugins.Fetch}
	svc, err := NewService(fake.ctx(), run, Snake, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		limit float64
		want  string
	}{{1000, "100"}, {7, "7"}, {-3, "-3"}, {math.NaN(), "NaN"}} {
		if _, err := svc.CalendarList.List().Do(MaxResults(c.limit, 100)); err != nil {
			t.Fatal(err)
		}
		if got := fake.hits[len(fake.hits)-1].URL.Query().Get("maxResults"); got != c.want {
			t.Errorf("%v: %q, want %q", c.limit, got, c.want)
		}
	}
}

// Answer keeps what the typed struct loses: a missing field is undefined, an
// explicit null is null, and "" and 0 stay what was sent.
func TestAnswerReadsTheAnswerAsJavaScriptDoes(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"","summary":null,"primary":false,"items":[]}` + "\n"))
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"access_token": "a"}), Fetch: plugins.Fetch}
	svc, err := NewService(fake.ctx(), run, Snake, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	entry, raw, err := Answer(fake.ctx(), svc.CalendarList.Get("primary"))
	if err != nil {
		t.Fatal(err)
	}
	if entry.Id != "" || entry.Summary != "" {
		t.Fatalf("typed %#v", entry)
	}
	if got := string(jsvalue.Stringify(raw)); got != `{"id":"","summary":null,"primary":false,"items":[]}` {
		t.Fatalf("raw %s", got)
	}
	if v := jsvalue.Member(raw, "description"); v != jsvalue.Undefined {
		t.Fatalf("missing field %#v", v)
	}
	if v := jsvalue.Member(raw, "summary"); v != nil {
		t.Fatalf("null field %#v", v)
	}
}

// An answer the typed struct cannot hold is no error: Bun's gaxios parses the
// body when it is JSON and keeps its text when it is not.
func TestAnswerReadsWhatTheStructCannotHoldAsGaxiosDoes(t *testing.T) {
	var body string
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"access_token": "a"}), Fetch: plugins.Fetch}
	svc, err := NewService(fake.ctx(), run, Snake, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ body, want string }{
		{`{"id":5,"summary":"s"}`, `{"id":5,"summary":"s"}`},
		{`{"summary":"s"}` + strings.Repeat(" ", 5000) + "\n", `{"summary":"s"}`},
		{`null`, `null`},
		{``, `""`},
		{`not json`, `"not json"`},
		{`{"summary":"s"} trailing`, `"{\"summary\":\"s\"} trailing"`},
	} {
		body = c.body
		entry, raw, err := Answer(fake.ctx(), svc.CalendarList.Get("primary"))
		if err != nil {
			t.Fatalf("%q: %v", c.body, err)
		}
		if got := string(jsvalue.Stringify(raw)); got != c.want {
			t.Fatalf("%q: raw %s", c.body, got)
		}
		if strings.HasPrefix(c.body, `{"id":5`) && entry != nil {
			t.Fatalf("%q: typed %#v", c.body, entry)
		}
	}
	// A failure status is still the SDK's error.
	fake.handle = func(w http.ResponseWriter, r *http.Request, _ int) {
		writeJSON(w, 404, map[string]any{"error": map[string]any{"code": 404, "message": "gone"}})
	}
	if _, raw, err := Answer(fake.ctx(), svc.CalendarList.Get("primary")); Message(err) != "gone" || raw != nil {
		t.Fatalf("%v %v", err, raw)
	}
}

// Only the answer the SDK decodes is kept: not a retried 5xx, not the 401
// before a refresh, not a redirect.
func TestAnswerKeepsOnlyTheFinalResponse(t *testing.T) {
	noSleep(t)
	cases := []struct {
		name  string
		creds map[string]any
		api   []int
	}{
		{"retried 503", map[string]any{"access_token": "a"}, []int{503, 503, 200}},
		{"refreshed after 401", map[string]any{"access_token": "old", "refresh_token": "rt"}, []int{401, 200}},
		{"redirected", map[string]any{"access_token": "a"}, []int{302, 200}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			api := 0
			fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
				if r.URL.Path == "/token" {
					writeJSON(w, 200, map[string]any{"access_token": "at-new", "expires_in": 3600, "token_type": "Bearer"})
					return
				}
				status := c.api[api]
				api++
				switch status {
				case 200:
					writeJSON(w, 200, map[string]any{"id": "final"})
				case 302:
					w.Header().Set("Location", r.URL.Path+"?"+r.URL.RawQuery+"&hop=1")
					writeJSON(w, 302, map[string]any{"id": "redirect"})
				default:
					writeJSON(w, status, map[string]any{"id": "attempt", "error": map[string]any{"code": status, "message": "nope"}})
				}
			})
			run := &plugins.RunContext{Credentials: testbox.Object(c.creds), Fetch: plugins.Fetch}
			svc, err := NewService(fake.ctx(), run, Snake, calendar.NewService)
			if err != nil {
				t.Fatal(err)
			}
			_, raw, err := Answer(fake.ctx(), svc.CalendarList.Get("primary"))
			if err != nil {
				t.Fatal(err)
			}
			if got := string(jsvalue.Stringify(raw)); got != `{"id":"final"}` || api != len(c.api) {
				t.Fatalf("raw %s after %d answers", got, api)
			}
		})
	}
}

// Each Answer has its own recorder, even on contexts derived from one parent.
func TestAnswerCallsInParallelDoNotCrossRecord(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		time.Sleep(time.Millisecond)
		writeJSON(w, 200, map[string]any{"id": strings.TrimPrefix(r.URL.Path, "/api/users/me/calendarList/")})
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"access_token": "a"}), Fetch: plugins.Fetch}
	parent := fake.ctx()
	svc, err := NewService(parent, run, Snake, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprint("cal", i)
			entry, raw, err := Answer(parent, svc.CalendarList.Get(id))
			if err != nil {
				t.Error(err)
				return
			}
			if entry.Id != id || jsvalue.Member(raw, "id") != id {
				t.Errorf("%s: typed %q raw %v", id, entry.Id, jsvalue.Member(raw, "id"))
			}
		}()
	}
	wg.Wait()
}

// A body cut short fails Answer exactly as it fails the plain call.
func TestAnswerFailsACutBodyAsTheSDKDoes(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "100")
		_, _ = w.Write([]byte(`{"id":"cut`))
		w.(http.Flusher).Flush()
		conn, _, _ := w.(http.Hijacker).Hijack()
		_ = conn.Close()
	})
	run := &plugins.RunContext{Credentials: testbox.Object(map[string]any{"access_token": "a"}), Fetch: plugins.Fetch}
	svc, err := NewService(fake.ctx(), run, Snake, calendar.NewService)
	if err != nil {
		t.Fatal(err)
	}
	_, plain := svc.CalendarList.Get("primary").Context(fake.ctx()).Do()
	_, _, answered := Answer(fake.ctx(), svc.CalendarList.Get("primary"))
	if plain == nil || answered == nil || plain.Error() != answered.Error() {
		t.Fatalf("plain %v, Answer %v", plain, answered)
	}
}

type fixedBody struct{ body io.ReadCloser }

func (f fixedBody) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Body: f.body}, nil
}

// Outside Answer, and for a media download, the body is handed on untouched.
func TestRecordTransportLeavesOtherResponsesAlone(t *testing.T) {
	body := io.NopCloser(strings.NewReader("bytes"))
	tr := recordTransport{fixedBody{body}}
	rec := &recorder{}
	for _, c := range []struct {
		ctx context.Context
		url string
	}{
		{context.Background(), "https://example.invalid/x?alt=json"},
		{context.WithValue(context.Background(), recorderKey{}, rec), "https://example.invalid/x?alt=media"},
		{context.WithValue(context.Background(), recorderKey{}, rec), "https://example.invalid/x"},
	} {
		req, _ := http.NewRequestWithContext(c.ctx, "GET", c.url, nil)
		resp, _ := tr.RoundTrip(req)
		if resp.Body != body {
			t.Fatalf("%s: body wrapped", c.url)
		}
	}
	if status, got, _ := rec.answer(); status != 0 || got != nil {
		t.Fatalf("recorded %d %q", status, got)
	}
}
