package gtasks

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// hit is one request that reached the fake Google.
type hit struct {
	Method string
	Path   string
	Query  url.Values
	Auth   string
	Body   string
	Form   url.Values
}

type fakeGoogle struct {
	mu     sync.Mutex
	hits   []hit
	handle func(w http.ResponseWriter, h hit)
	srv    *httptest.Server
}

func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fakeGoogle {
	t.Helper()
	f := &fakeGoogle{handle: handle}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		h := hit{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Auth: r.Header.Get("Authorization")}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			// Compacted, keys sorted: the body as the API reads it.
			var v any
			if err := json.Unmarshal(raw, &v); err != nil {
				t.Errorf("non-JSON body %q", raw)
			}
			h.Body = jsonText(v)
		} else if len(raw) > 0 {
			h.Form, _ = url.ParseQuery(string(raw))
		}
		f.mu.Lock()
		f.hits = append(f.hits, h)
		f.mu.Unlock()
		f.handle(w, h)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGoogle) ctx() context.Context {
	return google.WithEndpoints(context.Background(), google.Endpoints{
		API: f.srv.URL + "/", Token: f.srv.URL + "/token", UserInfo: f.srv.URL + "/userinfo",
	})
}

func (f *fakeGoogle) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

func (f *fakeGoogle) last() hit {
	all := f.recorded()
	return all[len(all)-1]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func setupVault(t *testing.T) *plugins.Registry {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"access_token":  "at-old",
		"refresh_token": "rt-old",
		"expiry_date":   expiry,
		"token_type":    "Bearer",
		"scope":         "https://www.googleapis.com/auth/tasks",
		"email":         "me@example.com",
	}
}

func saveProfile(t *testing.T, name string, creds map[string]any, readOnly bool) {
	t.Helper()
	opts := profile.SaveOptions{}
	if readOnly {
		opts = profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}
	}
	if err := profile.Save("gtasks", name, creds, opts); err != nil {
		t.Fatal(err)
	}
}

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c.Credentials["gtasks"][name]
}

func spec(t *testing.T, path string) *plugins.CommandSpec {
	t.Helper()
	p := New()
	for i := range p.Commands {
		if p.Commands[i].Path == path {
			return &p.Commands[i]
		}
	}
	t.Fatalf("no command %q", path)
	return nil
}

// input fills the switches and the defaults the way the host does (an absent
// <value> option without a default stays absent), then applies set.
func input(t *testing.T, path string, args map[string]any, set map[string]any) plugins.CommandInput {
	t.Helper()
	in := plugins.CommandInput{Args: map[string]any{}, Options: map[string]any{}}
	for _, o := range spec(t, path).Options {
		name := strings.TrimPrefix(strings.Fields(o.Flags)[0], "--")
		switch d := o.DefaultValue.(type) {
		case bool:
			in.Options[name] = d
		case string:
			in.Options[name] = d
		default:
			if !strings.Contains(o.Flags, "<") {
				in.Options[name] = false
			}
		}
	}
	for k, v := range args {
		in.Args[k] = v
	}
	for k, v := range set {
		in.Options[k] = v
	}
	return in
}

func exec(ctx context.Context, t *testing.T, reg *plugins.Registry, path string, in plugins.CommandInput) (any, error) {
	t.Helper()
	return host.Execute(ctx, reg, reg.Find("gtasks"), spec(t, path), in)
}

func cliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	ce, ok := err.(*clierr.Error)
	if !ok {
		t.Fatalf("not a CLI error: %#v", err)
	}
	return ce
}

// The command table is the Bun surface: `bun run src/index.ts gtasks --help`
// and each leaf's --help. A renamed flag, a lost default, an alias, the
// `lists` default, or a write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		aliases, args, flags, access, op, input string
		def, accessFor                          bool
	}
	want := map[string]row{
		"lists list":   {"", "", "--limit <n>=100", "read", "", "", true, false},
		"lists create": {"", "<title>", "", "write", "create task list", "", false, false},
		"lists delete": {"", "<tasklist-id>", "", "write", "delete task list", "", false, false},
		"list": {"", "<tasklist-id>",
			"--limit <n>=20 --show-completed=true --no-show-completed --show-hidden --due-min <datetime> --due-max <datetime>", "read", "", "", false, false},
		"get": {"", "<tasklist-id> <task-id>", "", "read", "", "", false, false},
		"add": {"", "<tasklist-id>",
			"--title <title> --notes <text> --due <date> --parent <task-id> --previous <task-id>", "write", "create task", "text", false, true},
		"update": {"", "<tasklist-id> <task-id>",
			"--title <title> --notes <text> --due <date> --status <status>", "write", "update task", "text", false, true},
		"done":   {"complete", "<tasklist-id> <task-id>", "", "write", "complete task", "", false, false},
		"undo":   {"uncomplete", "<tasklist-id> <task-id>", "", "write", "uncomplete task", "", false, false},
		"delete": {"", "<tasklist-id> <task-id>", "", "write", "delete task", "", false, false},
		"clear":  {"", "<tasklist-id>", "", "write", "clear tasks", "", false, false},
		"move":   {"", "<tasklist-id> <task-id>", "--parent <task-id> --previous <task-id>", "write", "move task", "", false, true},
	}
	p := New()
	if p.ID != "gtasks" || p.DisplayName != "Google Tasks" || p.Description != "Use when interacting with Google Tasks via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	// Bun registration order.
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, ",") != "lists list,lists create,lists delete,list,get,add,update,done,undo,delete,clear,move" {
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
			switch d := o.DefaultValue.(type) {
			case string:
				f += "=" + d
			case bool:
				if d {
					f += "=true"
				}
			}
			flags = append(flags, f)
		}
		got := row{strings.Join(c.Aliases, ","), strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input, c.Default, c.AccessFor != nil}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refresh_token" {
		t.Fatal("gtasks is a snake_case Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/userinfo.email"})
		case "/userinfo":
			if h.Auth != "Bearer at-1" {
				w.WriteHeader(401)
				return
			}
			writeJSON(w, 200, map[string]any{"email": "user@example.com"})
		default:
			w.WriteHeader(404)
		}
	})
	var opts plugins.OAuthSetupOptions
	var logs []string
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) {
		for _, p := range parts {
			logs = append(logs, p.(string))
		}
	}
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	if err := host.AddProfile(fake.ctx(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Join(logs, "|") != "Starting OAuth flow for Google Tasks...\n" {
		t.Fatalf("%q", logs)
	}
	if opts.Port != 0 || opts.ServiceName != "Google" || opts.ExpectedState != "" {
		t.Fatalf("oauth opts %#v", opts)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:3001/callback"))
	q := authURL.Query()
	if authURL.Host != "accounts.google.com" || authURL.Path != "/o/oauth2/v2/auth" || q.Get("access_type") != "offline" ||
		q.Get("prompt") != "consent" || q.Get("scope") != "https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/userinfo.email" ||
		q.Get("redirect_uri") != "http://localhost:3001/callback" || q.Get("response_type") != "code" || !strings.HasSuffix(q.Get("client_id"), ".apps.googleusercontent.com") {
		t.Fatalf("authorize url %s", authURL)
	}
	token := fake.recorded()[0].Form
	if token.Get("grant_type") != "authorization_code" || token.Get("code") != "code-1" || token.Get("redirect_uri") != "http://localhost:3001/callback" || token.Get("client_secret") == "" {
		t.Fatalf("token request %v", token)
	}
	// The suggested name is the email, and the host saved it under Bun's keys.
	stored := loadCreds(t, "user@example.com")
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
	setupVault(t)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1"})
			return
		}
		writeJSON(w, 200, map[string]any{"id": "123"})
	})
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	err := host.AddProfile(fake.ctx(), New(), plugins.SetupOptions{}, sc, io.Discard)
	ce := cliErr(t, err)
	if ce.Code != clierr.AuthFailed || ce.Message != "Could not fetch email" || ce.Suggestion != "Try again or specify --profile manually" {
		t.Fatalf("%#v", ce)
	}
	if c, _ := vault.Load(); len(c.Credentials["gtasks"]) != 0 {
		t.Fatal("a failed setup saved a profile")
	}
}

// Bun never rotates a Google refresh token: google-auth-library puts the
// stored one back on the result, so a rotated token in the response is dropped.
func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := setupVault(t)
	creds := storedCreds(1)
	creds["legacy"] = "kept"
	saveProfile(t, "acme", creds, false)
	var mu sync.Mutex
	refreshes := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3599, "token_type": "Bearer"})
			return
		}
		writeJSON(w, 200, map[string]any{"items": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(fake.ctx(), reg, "gtasks", "acme", auth.RefreshOptions{})
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
	form := fake.recorded()[0].Form
	if form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "rt-old" || form.Get("client_secret") == "" {
		t.Fatalf("refresh request %v", form)
	}
	stored := loadCreds(t, "acme")
	if stored["access_token"] != "at-new" || stored["refresh_token"] != "rt-old" || stored["email"] != "me@example.com" ||
		stored["legacy"] != "kept" || stored["scope"] != "https://www.googleapis.com/auth/tasks" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiry_date"].(json.Number); !ok {
		t.Fatalf("expiry_date %T", stored["expiry_date"])
	}
	// The command then calls the API with the refreshed token.
	if _, err := exec(fake.ctx(), t, reg, "lists list", input(t, "lists list", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if last := fake.last(); last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := setupVault(t)
	saveProfile(t, "acme", storedCreds(1), false)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/token" {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := exec(fake.ctx(), t, reg, "list", input(t, "list", map[string]any{"tasklist-id": "L1"}, nil))
	ce := cliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gtasks profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gtasks profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := loadCreds(t, "acme")
	if stored["access_token"] != "at-old" || stored["refresh_token"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if n := len(fake.recorded()); n != 1 {
		t.Fatalf("%d requests", n)
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := setupVault(t)
	saveProfile(t, "ro", storedCreds(time.Now().Add(24*time.Hour).UnixMilli()), true)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"id": "T1", "items": []any{}})
	})
	args := map[string]any{"tasklist-id": "L1", "task-id": "T1", "title": "Groceries"}
	writes := map[string]string{
		"lists create": "create task list", "lists delete": "delete task list", "add": "create task", "update": "update task",
		"done": "complete task", "undo": "uncomplete task", "delete": "delete task", "clear": "clear tasks", "move": "move task",
	}
	for path, op := range writes {
		_, err := exec(fake.ctx(), t, reg, path, input(t, path, args, map[string]any{"title": "T", "parent": "P1"}))
		ce := cliErr(t, err)
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio gtasks profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	// Bun checks these inputs before enforceWriteAccess, so the input error wins.
	for path, set := range map[string]map[string]any{
		"add":    nil,
		"update": {"status": "done"},
		"move":   nil,
	} {
		_, err := exec(fake.ctx(), t, reg, path, input(t, path, args, set))
		if ce := cliErr(t, err); ce.Code != clierr.InvalidParams {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	for _, path := range []string{"lists list", "list", "get"} {
		if _, err := exec(fake.ctx(), t, reg, path, input(t, path, args, nil)); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if n := len(fake.recorded()); n != 3 {
		t.Fatalf("reads did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	var status int
	var body any
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path != "/tasks/v1/users/@me/lists" || h.Query.Get("maxResults") != "1" || h.Auth != "Bearer at-old" {
			t.Errorf("validate called %s %v with %q", h.Path, h.Query, h.Auth)
		}
		writeJSON(w, status, body)
	})
	run := host.NewRunContext(storedCreds(1), "acme", fake.ctx())
	status, body = 200, map[string]any{"items": []any{}}
	v, err := New().Profile.Validate(fake.ctx(), run)
	if err != nil || !v.Valid || v.Info != "tasks access ok" {
		t.Fatalf("%#v %v", v, err)
	}
	status, body = 401, map[string]any{"error": map[string]any{"code": 401, "message": "Request had invalid authentication credentials."}}
	if v, _ := New().Profile.Validate(fake.ctx(), run); v.Valid || v.Error != "Request had invalid authentication credentials." {
		t.Fatalf("%#v", v)
	}
	status, body = 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
	if v, _ := New().Profile.Validate(fake.ctx(), run); v.Valid || v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(5)
	out := auth.RedactForRemote(reg, "gtasks", creds)
	if _, ok := out["refresh_token"]; ok || out["access_token"] != "at-old" || out["email"] != "me@example.com" || out["expiry_date"] != int64(5) {
		t.Fatalf("%#v", out)
	}
	if creds["refresh_token"] != "rt-old" {
		t.Fatal("redaction changed the caller's map")
	}
}

func TestListInfoAndReauthenticate(t *testing.T) {
	p := New()
	if p.Profile.ListInfo(map[string]any{"email": "me@example.com"}) != " - me@example.com" || p.Profile.ListInfo(map[string]any{}) != "" {
		t.Fatal("list info")
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		writeJSON(w, 200, map[string]any{"email": "me@example.com"})
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
	got, err := p.Profile.Reauthenticate(fake.ctx(), storedCreds(1), "work", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["access_token"] != "at-2" || got["refresh_token"] != "rt-2" || got["email"] != "me@example.com" {
		t.Fatalf("%#v", got)
	}
	if strings.Join(logs, "|") != "\nRe-authenticating gtasks / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

func TestListingCommandsSendTheBunQueries(t *testing.T) {
	reg := setupVault(t)
	saveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"items": []any{}})
	})
	run := func(path string, args, set map[string]any) hit {
		t.Helper()
		before := len(fake.recorded())
		if _, err := exec(fake.ctx(), t, reg, path, input(t, path, args, set)); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if n := len(fake.recorded()) - before; n != 1 {
			t.Fatalf("%s: %d requests", path, n)
		}
		return fake.last()
	}
	h := run("lists list", nil, nil)
	if h.Method != "GET" || h.Path != "/tasks/v1/users/@me/lists" || h.Query.Get("maxResults") != "100" || h.Query.Has("pageToken") {
		t.Fatalf("lists %s %v", h.Path, h.Query)
	}
	// Math.min(parseInt(limit), 100), NaN passed through as googleapis sends it.
	for limit, want := range map[string]string{"1000": "100", "10.9": "10", "abc": "NaN", "-2": "-2"} {
		if h = run("lists list", nil, map[string]any{"limit": limit}); h.Query.Get("maxResults") != want {
			t.Fatalf("limit %s: %v", limit, h.Query)
		}
	}
	h = run("list", map[string]any{"tasklist-id": "L1"}, nil)
	if h.Path != "/tasks/v1/lists/L1/tasks" || h.Query.Get("maxResults") != "20" || h.Query.Get("showCompleted") != "true" ||
		h.Query.Get("showDeleted") != "false" || h.Query.Get("showHidden") != "false" || h.Query.Has("dueMin") || h.Query.Has("dueMax") {
		t.Fatalf("list %s %v", h.Path, h.Query)
	}
	h = run("list", map[string]any{"tasklist-id": "L1"}, map[string]any{
		"no-show-completed": true, "show-hidden": true, "limit": "500",
		"due-min": "2024-04-15T00:00:00Z", "due-max": "2024-04-22T00:00:00Z",
	})
	if h.Query.Get("showCompleted") != "false" || h.Query.Get("showHidden") != "true" || h.Query.Get("maxResults") != "100" ||
		h.Query.Get("dueMin") != "2024-04-15T00:00:00Z" || h.Query.Get("dueMax") != "2024-04-22T00:00:00Z" {
		t.Fatalf("filtered list %v", h.Query)
	}
	if h = run("get", map[string]any{"tasklist-id": "L1", "task-id": "T1"}, nil); h.Method != "GET" || h.Path != "/tasks/v1/lists/L1/tasks/T1" {
		t.Fatalf("get %s %s", h.Method, h.Path)
	}
}

func TestWriteCommandsSendTheBunBodies(t *testing.T) {
	reg := setupVault(t)
	saveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Method == "DELETE" || strings.HasSuffix(h.Path, "/clear") {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, map[string]any{"id": "T1", "title": "Buy milk", "status": "completed", "parent": "P1"})
	})
	ids := map[string]any{"tasklist-id": "L1", "task-id": "T1", "title": "Q4 Roadmap"}
	cases := []struct {
		name, path string
		set        map[string]any
		stdin      any
		method     string
		target     string
		query      string
		body       string
	}{
		{"lists create", "lists create", nil, nil, "POST", "/tasks/v1/users/@me/lists", "", `{"title":"Q4 Roadmap"}`},
		{"add minimal", "add", map[string]any{"title": "Buy milk"}, nil, "POST", "/tasks/v1/lists/L1/tasks", "", `{"title":"Buy milk"}`},
		{"add full", "add", map[string]any{"title": "Step", "notes": "n1", "due": "2024-04-20", "parent": "P9", "previous": "S1"}, nil,
			"POST", "/tasks/v1/lists/L1/tasks", "parent=P9&previous=S1", `{"due":"2024-04-20T00:00:00.000Z","notes":"n1","title":"Step"}`},
		{"add rfc3339 due kept", "add", map[string]any{"title": "x", "due": "2024-04-20T10:00:00Z"}, nil,
			"POST", "/tasks/v1/lists/L1/tasks", "", `{"due":"2024-04-20T10:00:00Z","title":"x"}`},
		{"add trims stdin notes", "add", map[string]any{"title": "x"}, "  piped \n\n", "POST", "/tasks/v1/lists/L1/tasks", "", `{"notes":"piped","title":"x"}`},
		{"add --notes wins over stdin", "add", map[string]any{"title": "x", "notes": "given"}, "piped", "POST", "/tasks/v1/lists/L1/tasks", "", `{"notes":"given","title":"x"}`},
		{"add empty --notes reads stdin", "add", map[string]any{"title": "x", "notes": ""}, "piped", "POST", "/tasks/v1/lists/L1/tasks", "", `{"notes":"piped","title":"x"}`},
		{"add empty --notes is sent", "add", map[string]any{"title": "x", "notes": ""}, nil, "POST", "/tasks/v1/lists/L1/tasks", "", `{"notes":"","title":"x"}`},
		{"add blank stdin ignored", "add", map[string]any{"title": "x"}, " \n ", "POST", "/tasks/v1/lists/L1/tasks", "", `{"title":"x"}`},
		{"update nothing", "update", nil, nil, "PATCH", "/tasks/v1/lists/L1/tasks/T1", "", `{}`},
		{"update fields", "update", map[string]any{"title": "New", "due": "2024-04-22", "status": "completed"}, nil,
			"PATCH", "/tasks/v1/lists/L1/tasks/T1", "", `{"due":"2024-04-22T00:00:00.000Z","status":"completed","title":"New"}`},
		{"update empty values are sent, empty due clears", "update", map[string]any{"title": "", "notes": "", "due": ""}, "ignored",
			"PATCH", "/tasks/v1/lists/L1/tasks/T1", "", `{"due":null,"notes":"","title":""}`},
		{"update notes from stdin", "update", nil, " from stdin\n", "PATCH", "/tasks/v1/lists/L1/tasks/T1", "", `{"notes":"from stdin"}`},
		{"done", "done", nil, nil, "PATCH", "/tasks/v1/lists/L1/tasks/T1", "", `{"status":"completed"}`},
		{"undo", "undo", nil, nil, "PATCH", "/tasks/v1/lists/L1/tasks/T1", "", `{"status":"needsAction"}`},
		{"move parent", "move", map[string]any{"parent": "P1"}, nil, "POST", "/tasks/v1/lists/L1/tasks/T1/move", "parent=P1", ""},
		{"move previous", "move", map[string]any{"previous": "S1"}, nil, "POST", "/tasks/v1/lists/L1/tasks/T1/move", "previous=S1", ""},
		{"delete", "delete", nil, nil, "DELETE", "/tasks/v1/lists/L1/tasks/T1", "", ""},
		{"lists delete", "lists delete", nil, nil, "DELETE", "/tasks/v1/users/@me/lists/L1", "", ""},
		{"clear", "clear", nil, nil, "POST", "/tasks/v1/lists/L1/clear", "", ""},
	}
	for _, c := range cases {
		in := input(t, c.path, ids, c.set)
		in.Stdin = c.stdin
		before := len(fake.recorded())
		if _, err := exec(fake.ctx(), t, reg, c.path, in); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if n := len(fake.recorded()) - before; n != 1 {
			t.Fatalf("%s: %d requests", c.name, n)
		}
		h := fake.last()
		q := url.Values{}
		for k, v := range h.Query {
			if k != "alt" && k != "prettyPrint" {
				q[k] = v
			}
		}
		if h.Method != c.method || h.Path != c.target || q.Encode() != c.query || h.Body != c.body {
			t.Errorf("%s: %s %s %s %s", c.name, h.Method, h.Path, q.Encode(), h.Body)
		}
	}
}

func TestInputAndAPIErrorsMatchBun(t *testing.T) {
	reg := setupVault(t)
	saveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	var status int
	var body any
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, status, body)
	})
	ids := map[string]any{"tasklist-id": "L9", "task-id": "T9", "title": "X"}
	inputs := []struct {
		path, message, suggest string
		set                    map[string]any
	}{
		{"add", "required option '--title <title>' not specified", "", nil},
		{"update", "Invalid status: done", "Use: needsAction or completed", map[string]any{"status": "done"}},
		{"move", "At least one of --parent or --previous is required", "", map[string]any{"parent": "", "previous": ""}},
	}
	for _, c := range inputs {
		_, err := exec(fake.ctx(), t, reg, c.path, input(t, c.path, ids, c.set))
		if ce := cliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%s: %#v", c.path, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("an invalid input reached the API %d times", n)
	}
	// 404 is NOT_FOUND where Bun checks it; everything else is API_ERROR with the Bun prefix.
	set := map[string]any{"title": "X", "parent": "P1"}
	status, body = 404, map[string]any{"error": map[string]any{"code": 404, "message": "Not Found"}}
	for path, want := range map[string]struct {
		code    clierr.Code
		message string
	}{
		"lists list":   {clierr.APIError, "Tasks API error: Not Found"},
		"lists create": {clierr.APIError, "Failed to create task list: Not Found"},
		"lists delete": {clierr.NotFound, "Task list not found: L9"},
		"list":         {clierr.NotFound, "Task list not found: L9"},
		"get":          {clierr.NotFound, "Task not found: T9"},
		"add":          {clierr.NotFound, "Task list not found: L9"},
		"update":       {clierr.NotFound, "Task not found: T9"},
		"done":         {clierr.NotFound, "Task not found: T9"},
		"undo":         {clierr.NotFound, "Task not found: T9"},
		"delete":       {clierr.NotFound, "Task not found: T9"},
		"clear":        {clierr.NotFound, "Task list not found: L9"},
		"move":         {clierr.NotFound, "Task not found: T9"},
	} {
		got, err := exec(fake.ctx(), t, reg, path, input(t, path, ids, set))
		ce := cliErr(t, err)
		if ce.Code != want.code || ce.Message != want.message || ce.Suggestion != "" {
			t.Errorf("%s: %#v", path, ce)
		}
		// Bun printed nothing before throwing; the host prints any non-nil value.
		if got != nil {
			t.Errorf("%s returned %#v with its error", path, got)
		}
	}
	status, body = 403, map[string]any{"error": map[string]any{"code": 403, "message": "Forbidden", "errors": []any{map[string]any{"message": "Forbidden"}}}}
	for path, message := range map[string]string{
		"lists list": "Tasks API error: Forbidden", "lists create": "Failed to create task list: Forbidden",
		"lists delete": "Failed to delete task list: Forbidden", "list": "Tasks API error: Forbidden",
		"get": "Tasks API error: Forbidden", "add": "Failed to create task: Forbidden",
		"update": "Failed to update task: Forbidden", "done": "Failed to update task: Forbidden",
		"undo": "Failed to update task: Forbidden", "delete": "Failed to delete task: Forbidden",
		"clear": "Failed to clear completed tasks: Forbidden", "move": "Failed to move task: Forbidden",
	} {
		_, err := exec(fake.ctx(), t, reg, path, input(t, path, ids, set))
		if ce := cliErr(t, err); ce.Code != clierr.APIError || ce.Message != message {
			t.Errorf("%s: %#v", path, ce)
		}
	}
}

func TestFormatMatchesBun(t *testing.T) {
	lists := &taskListPage{TaskLists: []taskList{
		{ID: "L1", Title: "My Tasks", Updated: "2024-04-15T10:00:00.000Z"},
		{ID: "L2"},
	}, NextPageToken: "more"}
	if got := formatTaskLists(lists); got != "Task Lists (2)\n\n[1] My Tasks\n    ID: L1\n    Updated: 2024-04-15T10:00:00.000Z\n\n[2] \n    ID: L2\n\n(more results available)" {
		t.Fatalf("%q", got)
	}
	if formatTaskLists(&taskListPage{TaskLists: []taskList{}}) != "No task lists found" || formatTasks(&taskPage{Tasks: []task{}}) != "No tasks found" {
		t.Fatal("empty")
	}
	// The notes preview is 60 UTF-16 units: a split surrogate pair is U+FFFD, as Bun prints it.
	page := &taskPage{Tasks: []task{
		{ID: "T1", Title: "Buy milk", Status: "needsAction", Due: "2024-04-20T00:00:00.000Z", Notes: strings.Repeat("x", 59) + "😀tail"},
		{ID: "T2", Status: "completed", Notes: strings.Repeat("y", 60)},
	}}
	want := "Tasks (2)\n\n[1] [ ] Buy milk (due: 2024-04-20)\n    ID: T1\n    Status: needsAction\n    > " + strings.Repeat("x", 59) + "\uFFFD...\n\n" +
		"[2] [x] \n    ID: T2\n    Status: completed\n    > " + strings.Repeat("y", 60) + "\n"
	if got := formatTasks(page); got != want {
		t.Fatalf("%q", got)
	}
	full := &task{ID: "T1", Title: "Buy milk", Status: "completed", Due: "2024-04-20T00:00:00.000Z", Completed: "2024-04-19T00:00:00.000Z",
		Updated: "2024-04-15T10:00:00.000Z", Parent: "P1", WebViewLink: "https://tasks.example.com/T1", Notes: "line1\nline2"}
	if got := formatTask(full); got != "ID: T1\nTitle: Buy milk\nStatus: completed\nDue: 2024-04-20T00:00:00.000Z\nCompleted: 2024-04-19T00:00:00.000Z\nUpdated: 2024-04-15T10:00:00.000Z\nParent: P1\nLink: https://tasks.example.com/T1\n---\nline1\nline2" {
		t.Fatalf("%q", got)
	}
	if got := formatTask(&task{ID: "T2", Status: "needsAction"}); got != "ID: T2\nTitle: \nStatus: needsAction" {
		t.Fatalf("%q", got)
	}
	if got := formatTaskCreated(full); got != "Task created\nID: T1\nTitle: Buy milk\nStatus: completed\nDue: 2024-04-20T00:00:00.000Z\nLink: https://tasks.example.com/T1" {
		t.Fatalf("%q", got)
	}
	if got := formatTaskListCreated(&taskList{ID: "L1", Title: "Groceries"}); got != "Task list created\nID: L1\nTitle: Groceries" {
		t.Fatalf("%q", got)
	}
	if got := formatTaskListDeleted(taskListRef{TasklistID: "L1"}); got != "Task list deleted\nID: L1" {
		t.Fatalf("%q", got)
	}
	if got := formatTaskDeleted(taskRef{TasklistID: "L1", TaskID: "T1"}); got != "Task deleted\nTask List: L1\nTask ID: T1" {
		t.Fatalf("%q", got)
	}
	if got := formatCleared(taskListRef{TasklistID: "L1"}); got != "Completed tasks cleared\nTask List: L1" {
		t.Fatalf("%q", got)
	}
	if got := formatStatusChange("completed")(full); got != "Task completed: Buy milk\nID: T1\nStatus: completed" {
		t.Fatalf("%q", got)
	}
	if got := formatStatusChange("uncompleted")(&task{ID: "T3", Title: "x", Status: "needsAction"}); got != "Task uncompleted: x\nID: T3\nStatus: needsAction" {
		t.Fatalf("%q", got)
	}
	if got := formatMoved(full); got != "Task moved: Buy milk\nID: T1\nParent: P1" {
		t.Fatalf("%q", got)
	}
	if got := formatMoved(&task{ID: "T4", Title: "top"}); got != "Task moved: top\nID: T4" {
		t.Fatalf("%q", got)
	}
}

// parseTask keeps Bun's shape in --json: falsy optional fields are dropped,
// an absent title is "" and an absent status is needsAction.
func TestTaskJSONKeepsBunsShape(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(h.Path, "/tasks") {
			_, _ = io.WriteString(w, `{"items":[{"id":"T1"},{"id":"T2","title":"t","status":"completed","completed":"2024-04-19T00:00:00.000Z","hidden":true,"deleted":false,"notes":"","links":[],"etag":"e","kind":"tasks#task"}],"nextPageToken":"n"}`)
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"id":"L1","title":"A","kind":"tasks#taskList","etag":"e"},{}]}`)
	})
	a, err := apiFrom(fake.ctx(), host.NewRunContext(storedCreds(1), "acme", fake.ctx()))
	if err != nil {
		t.Fatal(err)
	}
	page, err := a.listTasks(listOptions{tasklistID: "L1", limit: 20, showCompleted: true})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"tasks":[{"id":"T1","title":"","status":"needsAction"},{"id":"T2","title":"t","status":"completed","completed":"2024-04-19T00:00:00.000Z","hidden":true}],"nextPageToken":"n"}`
	if raw, _ := json.Marshal(page); string(raw) != want {
		t.Fatalf("%s", raw)
	}
	lists, err := a.listTaskLists(100)
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(lists); string(raw) != `{"taskLists":[{"id":"L1","title":"A"},{"title":""}]}` {
		t.Fatalf("%s", raw)
	}
}

func jsonText(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
