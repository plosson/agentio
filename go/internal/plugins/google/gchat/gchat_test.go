package gchat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugincache"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// product drives New() through the shared Google test harness.
var product = googletest.For(New)

func oauthCreds(expiry int64) map[string]any {
	return map[string]any{
		"type":         "oauth",
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"tokenType":    "Bearer",
		"scope":        "https://www.googleapis.com/auth/chat.messages.create",
		"email":        "me@example.com",
	}
}

func webhookCreds(target string) map[string]any {
	return map[string]any{"type": "webhook", "webhookUrl": target}
}

func freshOAuth() map[string]any {
	return oauthCreds(time.Now().Add(time.Hour).UnixMilli())
}

// captureStderr returns what fn wrote to os.Stderr (RunContext.Log).
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stderr
	os.Stderr = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	fn()
	os.Stderr = prev
	w.Close()
	return <-done
}

// useTLS sends the host's fetch (over http.DefaultTransport) through srv's
// transport, so an https:// webhook reaches the fake.
func useTLS(t *testing.T, srv *httptest.Server) {
	t.Helper()
	prev := http.DefaultTransport
	http.DefaultTransport = srv.Client().Transport
	t.Cleanup(func() { http.DefaultTransport = prev })
}

// The command table is the Bun surface: `bun run src/index.ts gchat --help`
// and each leaf's --help.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op, input string
	}
	want := map[string]row{
		"send":              {"[message]", "--space <id> --thread <id> --json [file] --attachment <path>*", "write", "send message", "text"},
		"list":              {"", "--space <id>! --limit <n>=10 --thread <id> --since <date> --until <date> --format <format>=text", "read", "", ""},
		"get":               {"<message-id>", "--space <id>! --format <format>=text", "read", "", ""},
		"spaces":            {"", "--filter <text> --with <user>", "read", "", ""},
		"members":           {"", "--space <id-or-name>!", "read", "", ""},
		"user":              {"<user-id>", "", "read", "", ""},
		"directory refresh": {"", "", "read", "", ""},
	}
	p := New()
	if p.ID != "gchat" || p.DisplayName != "Google Chat" ||
		p.Description != "Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, ",") != "send,list,get,spaces,members,user,directory refresh" {
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
			// The host's --profile, placed as in Bun; the docs parity test checks it.
			if o.Flags == plugins.ProfileFlags {
				continue
			}
			f := o.Flags
			if o.Required {
				f += "!" // requiredOption
			}
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			if o.Repeatable {
				f += "*"
			}
			flags = append(flags, f)
		}
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" {
		t.Fatal("gchat is a camelCase Google lifecycle")
	}
}

// scripted answers setup prompts and menus in order; an exhausted script is
// EOF, and a menu with no answer left is one asked off a terminal.
func scripted(sc *plugins.SetupContext, answers ...string) *[]string {
	var asked []string
	sc.Select = func(message string, choices []plugins.Choice) (int, error) {
		q := message
		for _, c := range choices {
			q += " | " + c.Name + " - " + c.Description
		}
		asked = append(asked, q)
		var in io.Reader = strings.NewReader("")
		if len(answers) > 0 {
			in = testbox.Terminal(strings.NewReader(answers[0] + "\n"))
			answers = answers[1:]
		}
		return host.NewSetupContext(host.Streams{In: in, Out: io.Discard, Err: io.Discard}).Select(message, choices)
	}
	sc.Prompt = func(q string, _ bool) (string, error) {
		asked = append(asked, q)
		if len(answers) == 0 {
			return "", io.EOF
		}
		a := answers[0]
		answers = answers[1:]
		return a, nil
	}
	return &asked
}

func setupContext(logs *[]string) *plugins.SetupContext {
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) {
		for _, p := range parts {
			*logs = append(*logs, p.(string))
		}
	}
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	return sc
}

func TestSetupOAuthUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "chat"})
		case "/userinfo":
			googletest.WriteJSON(w, 200, map[string]any{"email": "user@example.com"})
		case "/v1/spaces":
			if h.Auth != "Bearer at-1" || h.Query.Get("pageSize") != "1" {
				t.Errorf("chat check %q %v", h.Auth, h.Query)
			}
			googletest.WriteJSON(w, 200, map[string]any{"spaces": []any{}})
		default:
			w.WriteHeader(404)
		}
	})
	var logs []string
	sc := setupContext(&logs)
	var opts plugins.OAuthSetupOptions
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	asked := scripted(sc, "2")
	var out bytes.Buffer
	if err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if len(*asked) != 1 || (*asked)[0] != "Choose profile type: | Webhook - Simple incoming webhook URL | OAuth - Full API access with Google Workspace account" {
		t.Fatalf("prompts %q", *asked)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:3001/callback"))
	if got := authURL.Query().Get("scope"); got != strings.Join(google.Scopes["gchat"], " ") || opts.ServiceName != "Google" {
		t.Fatalf("scope %q", got)
	}
	stored := product.LoadCreds(t, "user@example.com")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,email,expiryDate,refreshToken,scope,tokenType,type" {
		t.Fatalf("keys %v", keys)
	}
	if stored["type"] != "oauth" || stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" || stored["email"] != "user@example.com" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate is %T", stored["expiryDate"])
	}
	if out.String() != "Profile \"user@example.com\" configured!\nOAuth profile (user@example.com)\nTest with: agentio gchat send \"Hello from agentio\"\n" {
		t.Fatalf("%q", out.String())
	}
	if strings.Join(logs, "|") != "\nGoogle Chat Setup\n|OAuth Setup\n|Starting OAuth flow for Google Chat profile...\n" {
		t.Fatalf("%q", logs)
	}
}

func TestSetupOAuthFailuresSaveNothing(t *testing.T) {
	product.SetupVault(t)
	var emailBody any
	var chatStatus int
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1"})
		case "/userinfo":
			googletest.WriteJSON(w, 200, emailBody)
		default:
			googletest.WriteAPIError(w, chatStatus, "Google Chat app not found.")
		}
	})
	cases := []struct {
		email   any
		status  int
		message string
		suggest string
	}{
		{map[string]any{"id": "1"}, 200, "Failed to fetch user email: No email returned from userinfo endpoint", "Ensure the account has an email address"},
		{map[string]any{"email": "me@gmail.example.com"}, 404, "Failed to validate Google Chat access: Google Chat app not found.",
			"Google Chat API requires a Google Workspace account. Personal Gmail accounts cannot use the Chat API."},
	}
	for _, c := range cases {
		emailBody, chatStatus = c.email, c.status
		var logs []string
		sc := setupContext(&logs)
		scripted(sc, "oauth")
		ce := googletest.CliErr(t, host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, io.Discard))
		if ce.Code != clierr.AuthFailed || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%#v", ce)
		}
	}
	if c, _ := vault.Load(); len(c.Credentials.Profiles("gchat")) != 0 {
		t.Fatal("a failed setup saved a profile")
	}
}

func TestSetupWebhookPostsATestMessage(t *testing.T) {
	product.SetupVault(t)
	var status int
	var got []googletest.Hit
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		got = append(got, googletest.Hit{Method: r.Method, Path: r.URL.Path, Type: r.Header.Get("Content-Type"), Raw: string(raw)})
		w.WriteHeader(status)
	}))
	defer srv.Close()
	hook := srv.URL + "/v1/spaces/W/messages?key=k"
	run := func(opts plugins.SetupOptions, answers ...string) (string, []string, error) {
		var logs []string
		sc := setupContext(&logs)
		sc.Fetch = func(ctx context.Context, req *http.Request) (*http.Response, error) {
			return srv.Client().Do(req.WithContext(ctx))
		}
		scripted(sc, answers...)
		var out bytes.Buffer
		err := host.AddProfile(context.Background(), New(), opts, sc, &out)
		return out.String(), logs, err
	}
	status = 200
	out, logs, err := run(plugins.SetupOptions{}, "1", "  "+hook+"  ")
	if err != nil {
		t.Fatal(err)
	}
	if out != "Profile \"webhook\" configured!\nWebhook profile\nTest with: agentio gchat send \"Hello from agentio\"\n" {
		t.Fatalf("%q", out)
	}
	if strings.Join(logs[1:], "|") != "Webhook Setup\n|1. In Google Chat, find or create a space|2. Go to Space Settings → Webhooks|3. Create a new webhook and copy the URL\n" {
		t.Fatalf("%q", logs)
	}
	if len(got) != 1 || got[0].Method != "POST" || got[0].Type != "application/json" || got[0].Raw != `{"text":"Test message from agentio"}` {
		t.Fatalf("%#v", got)
	}
	if stored := product.LoadCreds(t, "webhook"); googletest.JSONText(stored) != `{"type":"webhook","webhookUrl":"`+hook+`"}` {
		t.Fatalf("%s", googletest.JSONText(stored))
	}
	// --profile names a webhook profile.
	if out, _, err := run(plugins.SetupOptions{Profile: "team"}, "webhook", hook); err != nil || !strings.HasPrefix(out, "Profile \"team\" configured!") {
		t.Fatalf("%q %v", out, err)
	}
	status = 400
	cases := []struct {
		answers []string
		message string
		suggest string
	}{
		{[]string{"1", hook}, "Webhook validation failed: 400", "Check the webhook URL and try again"},
		{[]string{"1", "  "}, "Webhook URL is required", ""},
		// Bun's prompt() trims with String#trim, which strips U+FEFF.
		{[]string{"1", "\ufeff"}, "Webhook URL is required", ""},
		{[]string{"1", "::not a url"}, "", "Check that the URL is correct and accessible"},
		{nil, "Interactive input required but not running in terminal", "Run this command in an interactive terminal"},
	}
	for _, c := range cases {
		_, _, err := run(plugins.SetupOptions{Profile: "bad"}, c.answers...)
		ce := googletest.CliErr(t, err)
		if (c.message != "" && ce.Message != c.message) || ce.Suggestion != c.suggest {
			t.Errorf("%v: %#v", c.answers, ce)
		}
	}
	if c, _ := vault.Load(); testbox.Map(c.Credentials.Get("gchat", "bad")) != nil {
		t.Fatal("a failed setup saved a profile")
	}
}

// Bun never rotates a Google refresh token, and the rest of the map
// (type, email) survives the refresh.
func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", oauthCreds(1), false)
	var mu sync.Mutex
	refreshes := 0
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3599, "token_type": "Bearer"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"spaces": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gchat", "acme", auth.RefreshOptions{})
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
	if form := fake.Recorded()[0].Form; form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "rt-old" {
		t.Fatalf("refresh request %v", form)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-old" || stored["type"] != "oauth" ||
		stored["email"] != "me@example.com" || stored["scope"] != "https://www.googleapis.com/auth/chat.messages.create" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate %T", stored["expiryDate"])
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, nil)); err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if last := all[len(all)-1]; last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

// tests/auth/refresh.test.ts: a webhook profile has nothing to refresh, even
// when forced.
func TestWebhookProfileIsNeverRefreshed(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "hook", webhookCreds("https://chat.example.com/hook"), false)
	fresh, err := auth.GetFresh(context.Background(), reg, "gchat", "hook", auth.RefreshOptions{Force: true})
	if err != nil || fresh.Refreshed || fresh.Credentials.Value("type") != "webhook" {
		t.Fatalf("%#v %v", fresh, err)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", oauthCreds(1), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	got, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, nil))
	ce := googletest.CliErr(t, err)
	if got != nil || ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gchat profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gchat profile add --profile acme" {
		t.Fatalf("%#v %#v", got, ce)
	}
	if stored := product.LoadCreds(t, "acme"); stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

func TestReadOnlyProfileRefusesSendButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", freshOAuth(), true)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/S"})
	})
	_, err := product.Exec(fake.Ctx(), t, reg, "send", product.Input(t, "send", map[string]any{"message": "hi"}, map[string]any{"space": "S"}))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot send message: profile "ro" is read-only` ||
		ce.Suggestion != "To modify this profile's access: agentio gchat profile update --profile ro --no-read-only" {
		t.Fatalf("%#v", ce)
	}
	// Bun checks the message and --json input before enforceWriteAccess, so a
	// read-only profile gets the input error.
	missing := filepath.Join(t.TempDir(), "nope.json")
	for _, c := range []struct {
		args  map[string]any
		set   map[string]any
		stdin any
		msg   string
	}{
		{nil, nil, nil, "Message or --attachment is required. Provide as argument, pipe via stdin, or attach a file."},
		{nil, map[string]any{"json": missing}, nil, "Failed to read JSON file: " + missing},
		{map[string]any{"message": "hi"}, map[string]any{"json": true}, nil, "Cannot use both text message and --json option"},
		{nil, map[string]any{"json": true}, "{bad", "Invalid JSON: JSON Parse error: Expected '}'"},
		{nil, map[string]any{"json": true}, nil, "No JSON provided via stdin"},
	} {
		in := product.Input(t, "send", c.args, c.set)
		in.Stdin = c.stdin
		_, err := product.Exec(fake.Ctx(), t, reg, "send", in)
		if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != c.msg {
			t.Errorf("%v %v: %#v", c.args, c.set, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if n := len(fake.Recorded()); n != 1 {
		t.Fatalf("the read did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	var status int
	var body any
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path != "/v1/spaces" || h.Query.Get("pageSize") != "1" || h.Auth != "Bearer at-old" {
			t.Errorf("validate called %s %v with %q", h.Path, h.Query, h.Auth)
		}
		googletest.WriteJSON(w, status, body)
	})
	v, err := New().Profile.Validate(fake.Ctx(), host.NewRunContext(testbox.Object(webhookCreds("https://x.example.com")), "hook", fake.Ctx()))
	if err != nil || !v.Valid || v.Info != "webhook" || len(fake.Recorded()) != 0 {
		t.Fatalf("webhook %#v %v", v, err)
	}
	run := host.NewRunContext(testbox.Object(oauthCreds(freshExpiry)), "acme", fake.Ctx())
	status, body = 200, map[string]any{}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); !v.Valid || v.Info != "me@example.com" {
		t.Fatalf("%#v", v)
	}
	noEmail := oauthCreds(freshExpiry)
	delete(noEmail, "email")
	if v, _ := New().Profile.Validate(fake.Ctx(), host.NewRunContext(testbox.Object(noEmail), "acme", fake.Ctx())); !v.Valid || v.Info != "oauth" {
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
	creds := oauthCreds(5)
	out := auth.RedactForRemote(reg, "gchat", testbox.Object(creds))
	if _, ok := out.Get("refreshToken"); ok || out.Value("accessToken") != "at-old" || out.Value("type") != "oauth" || out.Value("expiryDate") != int64(5) {
		t.Fatalf("%#v", out)
	}
	if creds["refreshToken"] != "rt-old" {
		t.Fatal("redaction changed the caller's map")
	}
	hook := auth.RedactForRemote(reg, "gchat", testbox.Object(webhookCreds("https://x.example.com")))
	if hook.Value("webhookUrl") != "https://x.example.com" {
		t.Fatalf("%#v", hook)
	}
}

func TestListInfoAndReauthenticate(t *testing.T) {
	if listInfo(testbox.Object(webhookCreds("u"))) != " - webhook" || listInfo(testbox.Object(oauthCreds(1))) != " - oauth" || listInfo(testbox.Object(map[string]any{})) != " - oauth" {
		t.Fatal("list info")
	}
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"email": "me@example.com"})
	})
	var logs []string
	sc := setupContext(&logs)
	hook := webhookCreds("https://x.example.com")
	got, err := New().Profile.Reauthenticate(fake.Ctx(), testbox.Object(hook), "hook", sc)
	if err != nil || googletest.JSONText(got) != googletest.JSONText(hook) || len(fake.Recorded()) != 0 {
		t.Fatalf("%#v %v", got, err)
	}
	if strings.Join(logs, "|") != "\nSkipping gchat / hook: webhook profiles don't expire. Run 'agentio gchat profile add' to update." {
		t.Fatalf("%q", logs)
	}
	logs = nil
	legacy := oauthCreds(1)
	delete(legacy, "type")
	got, err = New().Profile.Reauthenticate(fake.Ctx(), testbox.Object(legacy), "work", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got.Value("type") != "oauth" || got.Value("accessToken") != "at-2" || got.Value("refreshToken") != "rt-2" || got.Value("email") != "me@example.com" {
		t.Fatalf("%#v", got)
	}
	if _, ok := testbox.Map(got)["scope"]; ok {
		t.Fatalf("scope kept %#v", got)
	}
	if strings.Join(logs, "|") != "\nRe-authenticating gchat / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

func TestSendViaWebhook(t *testing.T) {
	reg := product.SetupVault(t)
	var status int
	var reply string
	var got []googletest.Hit
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		got = append(got, googletest.Hit{Method: r.Method, Path: r.URL.Path, Type: r.Header.Get("Content-Type"), Raw: string(raw)})
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	defer srv.Close()
	useTLS(t, srv)
	product.SaveProfile(t, "hook", webhookCreds(srv.URL+"/v1/spaces/W/messages?key=k"), false)
	ctx := context.Background()
	status, reply = 200, `{"name":"spaces/W/messages/M1"}`
	res, err := product.Exec(ctx, t, reg, "send", product.Input(t, "send", map[string]any{"message": `Done\! <ok> & more`}, map[string]any{"thread": "ignored"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Method != "POST" || got[0].Type != "application/json" || got[0].Raw != `{"text":"Done! <ok> & more"}` {
		t.Fatalf("%#v", got)
	}
	if product.Spec(t, "send").Format(res) != "Message sent\nID: M1" || googletest.JSONText(res) != `{"messageId":"M1","text":"Done! \u003cok\u003e \u0026 more","isJsonPayload":false}` {
		t.Fatalf("%q %s", product.Spec(t, "send").Format(res), googletest.JSONText(res))
	}
	// Stdin text, trimmed; a body that is not JSON keeps the id "unknown".
	reply = "ok"
	in := product.Input(t, "send", nil, nil)
	in.Stdin = "  from stdin\n"
	if res, err = product.Exec(ctx, t, reg, "send", in); err != nil || got[1].Raw != `{"text":"from stdin"}` || product.Spec(t, "send").Format(res) != "Message sent\nID: unknown" {
		t.Fatalf("%q %v", got[1].Raw, err)
	}
	// A JSON file is posted as JSON.stringify(JSON.parse(file)) (checked with
	// Bun): key order kept, <, > and & as is, numbers as JavaScript reads them.
	card := filepath.Join(t.TempDir(), "card.json")
	_ = os.WriteFile(card, []byte(` {"cardsV2":[{"cardId":"c"}],"z":1,"a":"<&>","n":12345678901234567890} `), 0o600)
	reply = `{"name":"spaces/W/messages/M2"}`
	if res, err = product.Exec(ctx, t, reg, "send", product.Input(t, "send", nil, map[string]any{"json": card})); err != nil {
		t.Fatal(err)
	}
	if got[2].Raw != `{"cardsV2":[{"cardId":"c"}],"z":1,"a":"<&>","n":12345678901234567000}` || product.Spec(t, "send").Format(res) != "Message sent\nID: M2\nType: JSON payload" {
		t.Fatalf("%q %q", got[2].Raw, product.Spec(t, "send").Format(res))
	}
	status, reply = 403, "no bots"
	res, err = product.Exec(ctx, t, reg, "send", product.Input(t, "send", map[string]any{"message": "x"}, nil))
	if ce := googletest.CliErr(t, err); res != nil || ce.Code != clierr.APIError || ce.Message != "Failed to send message via webhook: 403 no bots" ||
		ce.Suggestion != "Check that the webhook URL is valid and the bot has permission to post" {
		t.Fatalf("%#v %#v", res, ce)
	}
	n := len(got)
	for _, c := range []struct {
		path    string
		in      plugins.CommandInput
		code    clierr.Code
		message string
	}{
		{"send", product.Input(t, "send", map[string]any{"message": "x"}, map[string]any{"attachment": []string{card}}), clierr.PermissionDenied, "File attachments are not supported for webhook profiles"},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "S"}), clierr.PermissionDenied, "Listing messages is not supported for webhook profiles"},
		{"get", product.Input(t, "get", map[string]any{"message-id": "M"}, map[string]any{"space": "S"}), clierr.PermissionDenied, "Getting messages is not supported for webhook profiles"},
		{"spaces", product.Input(t, "spaces", nil, nil), clierr.PermissionDenied, "Listing spaces is not supported for webhook profiles"},
		{"spaces", product.Input(t, "spaces", nil, map[string]any{"with": "a@example.com"}), clierr.PermissionDenied, "Finding direct message is not supported for webhook profiles"},
		{"members", product.Input(t, "members", nil, map[string]any{"space": "S"}), clierr.PermissionDenied, "Listing members is not supported for webhook profiles"},
		{"user", product.Input(t, "user", map[string]any{"user-id": "1"}, nil), clierr.PermissionDenied, "Getting user info is not supported for webhook profiles"},
		{"directory refresh", product.Input(t, "directory refresh", nil, nil), clierr.PermissionDenied, "Refreshing directory is not supported for webhook profiles"},
	} {
		res, err := product.Exec(ctx, t, reg, c.path, c.in)
		ce := googletest.CliErr(t, err)
		if res != nil || ce.Code != c.code || ce.Message != c.message {
			t.Errorf("%s: %#v", c.path, ce)
		}
	}
	if len(got) != n {
		t.Fatal("a refused webhook command made a request")
	}
	product.SaveProfile(t, "plain", webhookCreds("http://chat.example.com/hook"), false)
	_, err = product.Exec(ctx, t, reg, "send", product.Input(t, "send", map[string]any{"message": "x"}, map[string]any{"profile": "plain"}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "Invalid webhook URL - must be HTTPS" || ce.Suggestion != "Check the webhook URL configuration" {
		t.Fatalf("%#v", ce)
	}
}

func TestSendViaOAuth(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case h.Method == "GET" && h.Path == "/v1/spaces/AAAA":
			googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/AAAA"})
		case h.Method == "GET" && strings.HasPrefix(h.Path, "/v1/spaces/"):
			googletest.WriteAPIError(w, 404, "not found")
		case h.Method == "GET" && h.Path == "/v1/spaces":
			googletest.WriteJSON(w, 200, map[string]any{"spaces": []any{map[string]any{"name": "spaces/ENG1", "displayName": "Engineering"}}})
		case h.Method == "POST":
			googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/AAAA/messages/M9"})
		}
	})
	ctx := fake.Ctx()
	res, err := product.Exec(ctx, t, reg, "send", product.Input(t, "send", map[string]any{"message": "Status update"}, map[string]any{"space": "AAAA"}))
	if err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if strings.Join(fake.Paths(), ",") != "GET /v1/spaces/AAAA,POST /v1/spaces/AAAA/messages" || googletest.JSONText(all[1].JSON) != `{"text":"Status update"}` || all[1].Auth != "Bearer at-old" {
		t.Fatalf("%v %s", fake.Paths(), googletest.JSONText(all[1].JSON))
	}
	if product.Spec(t, "send").Format(res) != "Message sent\nID: M9\nSpace: AAAA" || googletest.JSONText(res) != `{"messageId":"M9","spaceId":"AAAA","text":"Status update","isJsonPayload":false}` {
		t.Fatalf("%q %s", product.Spec(t, "send").Format(res), googletest.JSONText(res))
	}
	// A display name resolves through the space list, case-insensitively.
	fake.Reset()
	if res, err = product.Exec(ctx, t, reg, "send", product.Input(t, "send", map[string]any{"message": "hi"}, map[string]any{"space": "engineering"})); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(fake.Paths(), ","); got != "GET /v1/spaces/engineering,GET /v1/spaces,POST /v1/spaces/ENG1/messages" {
		t.Fatalf("%s", got)
	}
	if product.Spec(t, "send").Format(res) != "Message sent\nID: M9\nSpace: ENG1" {
		t.Fatalf("%q", product.Spec(t, "send").Format(res))
	}
	// A --json payload is spread into the request body (Bun `{ ...payload }`)
	// and sent as is: key order, fields the Chat API may reject, an array's
	// or a string's indices. A falsy payload sends `{ text }`.
	for _, c := range []struct{ stdin, want, format string }{
		{`{"text":"card <&>","cardsV2":[{"cardId":"c"}],"unknownField":{"z":1,"a":2}}`, `{"text":"card <&>","cardsV2":[{"cardId":"c"}],"unknownField":{"z":1,"a":2}}`, "Message sent\nID: M9\nSpace: AAAA\nType: JSON payload"},
		{`{"text":5}`, `{"text":5}`, "Message sent\nID: M9\nSpace: AAAA\nType: JSON payload"},
		{`[1,2]`, `{"0":1,"1":2}`, "Message sent\nID: M9\nSpace: AAAA\nType: JSON payload"},
		{`"ab"`, `{"0":"a","1":"b"}`, "Message sent\nID: M9\nSpace: AAAA\nType: JSON payload"},
		// Bun reports `!!payload`, so a falsy payload is not a JSON payload.
		{`0`, `{}`, "Message sent\nID: M9\nSpace: AAAA"},
		{`false`, `{}`, "Message sent\nID: M9\nSpace: AAAA"},
	} {
		fake.Reset()
		in := product.Input(t, "send", nil, map[string]any{"space": "AAAA", "json": true})
		in.Stdin = c.stdin
		if res, err = product.Exec(ctx, t, reg, "send", in); err != nil {
			t.Fatal(err)
		}
		posted := fake.Recorded()[1]
		if posted.Raw != c.want || posted.Type != "application/json" || product.Spec(t, "send").Format(res) != c.format {
			t.Fatalf("%s: posted %s %q, %q", c.stdin, posted.Raw, posted.Type, product.Spec(t, "send").Format(res))
		}
	}
}

func TestSendUploadsAttachmentsBeforeTheMessage(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case h.Method == "GET":
			googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/AAAA"})
		case strings.HasPrefix(h.Path, "/upload/"):
			googletest.WriteJSON(w, 200, map[string]any{"attachmentDataRef": map[string]any{"resourceName": "ref-" + h.Query.Get("uploadType")}})
		default:
			googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/AAAA/messages/M1"})
		}
	})
	dir := t.TempDir()
	png := filepath.Join(dir, "Shot.PNG")
	notes := filepath.Join(dir, ".notes")
	_ = os.WriteFile(png, []byte("png-bytes"), 0o600)
	_ = os.WriteFile(notes, []byte("n"), 0o600)
	in := product.Input(t, "send", nil, map[string]any{"space": "AAAA", "json": true, "attachment": []string{png, notes}})
	in.Stdin = ` {"text":"card","attachment":[{"contentName":"old"}]} `
	res, err := product.Exec(fake.Ctx(), t, reg, "send", in)
	if err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if strings.Join(fake.Paths(), ",") != "GET /v1/spaces/AAAA,POST /upload/v1/spaces/AAAA/attachments:upload,POST /upload/v1/spaces/AAAA/attachments:upload,POST /v1/spaces/AAAA/messages" {
		t.Fatalf("%v", fake.Paths())
	}
	// The uploads run at once (Bun Promise.all): they arrive in either order.
	for i, want := range []string{"Content-Type: image/png", "Content-Type: application/octet-stream"} {
		name := `"filename":"` + filepath.Base([]string{png, notes}[i]) + `"`
		up := all[1]
		if !strings.Contains(up.Raw, name) {
			up = all[2]
		}
		if up.Query.Get("uploadType") != "multipart" || !strings.Contains(up.Raw, want) || !strings.Contains(up.Raw, name) {
			t.Fatalf("upload %d %v %q", i, up.Query, up.Raw)
		}
	}
	if got := all[3].Raw; got != `{"text":"card","attachment":[{"contentName":"old"},{"attachmentDataRef":{"resourceName":"ref-multipart"}},{"attachmentDataRef":{"resourceName":"ref-multipart"}}]}` {
		t.Fatalf("%s", got)
	}
	if product.Spec(t, "send").Format(res) != "Message sent\nID: M1\nSpace: AAAA\nType: JSON payload" {
		t.Fatalf("%q", product.Spec(t, "send").Format(res))
	}
}

func TestSendInputAndAPIErrorsMatchBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	var status int
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case h.Method == "GET":
			googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/AAAA"})
		case strings.HasPrefix(h.Path, "/upload/"):
			if status == 200 {
				googletest.WriteJSON(w, 200, map[string]any{})
				return
			}
			googletest.WriteAPIError(w, status, "upload refused")
		default:
			googletest.WriteAPIError(w, status, "Invalid argument")
		}
	})
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"text":`), 0o600)
	file := filepath.Join(dir, "a.txt")
	_ = os.WriteFile(file, []byte("a"), 0o600)
	missing := filepath.Join(dir, "missing.json")
	withStdin := func(in plugins.CommandInput, s string) plugins.CommandInput { in.Stdin = s; return in }
	cases := []struct {
		in      plugins.CommandInput
		code    clierr.Code
		message string
		suggest string
	}{
		{product.Input(t, "send", map[string]any{"message": "hi"}, map[string]any{"json": true}), clierr.InvalidParams, "Cannot use both text message and --json option",
			`Use either: agentio gchat send "text" OR agentio gchat send --json file.json`},
		{product.Input(t, "send", nil, map[string]any{"json": missing}), clierr.InvalidParams, "Failed to read JSON file: " + missing, "Check that the file exists and is readable"},
		{withStdin(product.Input(t, "send", nil, map[string]any{"json": true}), " \n"), clierr.InvalidParams, "No JSON provided via stdin", "Pipe JSON content: cat message.json | agentio gchat send --json"},
		// JSON.parse's wording, checked with Bun.
		{product.Input(t, "send", nil, map[string]any{"json": bad}), clierr.InvalidParams, "Invalid JSON: JSON Parse error: Unexpected EOF", "Check that the JSON is valid"},
		{withStdin(product.Input(t, "send", nil, map[string]any{"json": true}), `{"a":1,}`), clierr.InvalidParams, "Invalid JSON: JSON Parse error: Property name must be a string literal", "Check that the JSON is valid"},
		{withStdin(product.Input(t, "send", nil, map[string]any{"json": true}), `[1,2`), clierr.InvalidParams, "Invalid JSON: JSON Parse error: Expected ']'", "Check that the JSON is valid"},
		{withStdin(product.Input(t, "send", nil, map[string]any{"json": true}), `tru`), clierr.InvalidParams, `Invalid JSON: JSON Parse error: Unexpected identifier "tru"`, "Check that the JSON is valid"},
		{withStdin(product.Input(t, "send", nil, map[string]any{"json": true}), `{"z":1}{`), clierr.InvalidParams, "Invalid JSON: JSON Parse error: Unable to parse JSON string", "Check that the JSON is valid"},
		{withStdin(product.Input(t, "send", nil, nil), "  "), clierr.InvalidParams, "Message or --attachment is required. Provide as argument, pipe via stdin, or attach a file.", ""},
		{product.Input(t, "send", map[string]any{"message": "hi"}, nil), clierr.InvalidParams, "spaceId is required for OAuth profiles", "Specify with --space or configure default in profile"},
		{product.Input(t, "send", nil, map[string]any{"space": "AAAA", "attachment": []string{missing}}), clierr.InvalidParams, "Failed to read attachment: " + missing, "Check that the file exists and is readable"},
	}
	for _, c := range cases {
		res, err := product.Exec(fake.Ctx(), t, reg, "send", c.in)
		ce := googletest.CliErr(t, err)
		if res != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%#v", ce)
		}
	}
	for _, h := range fake.Recorded() {
		if h.Method != "GET" {
			t.Fatalf("an invalid send posted %s", h.Path)
		}
	}
	api := []struct {
		status  int
		in      plugins.CommandInput
		code    clierr.Code
		message string
		suggest string
	}{
		{403, product.Input(t, "send", map[string]any{"message": "hi"}, map[string]any{"space": "AAAA"}), clierr.PermissionDenied,
			"Failed to send message: Bot lacks permission for this operation", "Check that the space ID is valid and OAuth token is not expired"},
		{400, product.Input(t, "send", map[string]any{"message": "hi"}, map[string]any{"space": "AAAA"}), clierr.APIError,
			"Failed to send message: Invalid argument", "Check that the space ID is valid and OAuth token is not expired"},
		{400, product.Input(t, "send", nil, map[string]any{"space": "AAAA", "attachment": []string{file}}), clierr.APIError,
			`Failed to upload attachment "a.txt": upload refused`, "Check that the space ID is valid, OAuth scope includes chat.messages.create, and the file is under 200MB"},
		{200, product.Input(t, "send", nil, map[string]any{"space": "AAAA", "attachment": []string{file}}), clierr.APIError,
			`Upload of "a.txt" returned no attachmentDataRef`, "Retry, or check that the file size is under the Chat API limit (200MB)"},
	}
	for _, c := range api {
		status = c.status
		res, err := product.Exec(fake.Ctx(), t, reg, "send", c.in)
		ce := googletest.CliErr(t, err)
		if res != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%d: %#v", c.status, ce)
		}
	}
}

// chatFake answers the Chat and People calls the read commands make.
type chatFake struct {
	messages   []map[string]any // served newest first, two per page
	directory  []any
	people     map[string]map[string]any
	dirStatus  int
	listStatus int
}

func (c *chatFake) handle(w http.ResponseWriter, h googletest.Hit) {
	switch {
	case h.Path == "/v1/spaces/S" || h.Path == "/v1/spaces/ENG1":
		googletest.WriteJSON(w, 200, map[string]any{"name": strings.TrimPrefix(h.Path, "/v1/")})
	case h.Path == "/v1/spaces":
		if h.Query.Get("pageToken") == "" {
			googletest.WriteJSON(w, 200, map[string]any{"spaces": []any{
				map[string]any{"name": "spaces/ENG1", "displayName": "Engineering", "type": "ROOM", "spaceDetails": map[string]any{"description": "Eng team"}},
				map[string]any{"name": "spaces/DM1", "type": "ROOM", "spaceType": "DIRECT_MESSAGE"},
			}, "nextPageToken": "p2"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"spaces": []any{map[string]any{"name": "spaces/G1", "displayName": "Group", "spaceType": "GROUP_CHAT"}}})
	case strings.HasPrefix(h.Path, "/v1/spaces/") && strings.HasSuffix(h.Path, "/messages"):
		if c.listStatus != 0 {
			googletest.WriteAPIError(w, c.listStatus, "denied")
			return
		}
		start := 0
		if tok := h.Query.Get("pageToken"); tok != "" {
			start = int(tok[0] - '0')
		}
		end := start + 2
		if size, _ := strconv.Atoi(h.Query.Get("pageSize")); size >= 0 && size < 2 {
			end = start + size
		}
		if end > len(c.messages) {
			end = len(c.messages)
		}
		reply := map[string]any{"messages": c.messages[start:end]}
		if end < len(c.messages) {
			reply["nextPageToken"] = string(rune('0' + end))
		}
		googletest.WriteJSON(w, 200, reply)
	case strings.HasPrefix(h.Path, "/v1/spaces/") && strings.Contains(h.Path, "/messages/"):
		for _, m := range c.messages {
			if "/v1/"+m["name"].(string) == h.Path {
				googletest.WriteJSON(w, 200, m)
				return
			}
		}
		googletest.WriteAPIError(w, 404, "Message not found")
	case strings.HasSuffix(h.Path, "/members"):
		googletest.WriteJSON(w, 200, map[string]any{"memberships": []any{
			map[string]any{"name": "spaces/S/members/1", "role": "ROLE_MANAGER", "state": "JOINED", "member": map[string]any{"name": "users/1", "type": "HUMAN"}},
			map[string]any{"name": "spaces/S/members/2", "state": "INVITED", "member": map[string]any{"name": "users/2", "displayName": "Chat Two"}},
			map[string]any{"name": "spaces/S/members/3", "member": map[string]any{"name": "users/3", "type": "BOT", "displayName": "Bot"}},
			map[string]any{"name": "spaces/S/members/4", "role": "ROLE_MEMBER", "state": "JOINED"},
		}})
	case h.Path == "/v1/people:listDirectoryPeople":
		if c.dirStatus != 0 {
			googletest.WriteAPIError(w, c.dirStatus, "directory off")
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"people": c.directory, "nextSyncToken": "sync-1"})
	case h.Path == "/v1/people/503":
		googletest.WriteAPIError(w, 503, "busy")
	case strings.HasPrefix(h.Path, "/v1/people/"):
		if p, ok := c.people[strings.TrimPrefix(h.Path, "/v1/people/")]; ok {
			googletest.WriteJSON(w, 200, p)
			return
		}
		googletest.WriteAPIError(w, 404, "Requested entity was not found.")
	case h.Path == "/v1/spaces:findDirectMessage":
		switch h.Query.Get("name") {
		case "users/7":
			googletest.WriteJSON(w, 200, map[string]any{"name": "spaces/DM7"})
		case "users/8":
			googletest.WriteAPIError(w, 403, "scope")
		case "users/5":
			googletest.WriteAPIError(w, 503, "busy")
		case "users/6":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, "<html>")
		default:
			googletest.WriteAPIError(w, 404, "none")
		}
	default:
		googletest.WriteAPIError(w, 404, "unexpected "+h.Path)
	}
}

func person(id, name, email string) map[string]any {
	p := map[string]any{"resourceName": "people/" + id}
	if name != "" {
		p["names"] = []any{map[string]any{"displayName": name}}
	}
	if email != "" {
		p["emailAddresses"] = []any{map[string]any{"value": email}}
	}
	return p
}

func TestListPagesToTheLimitAndNamesSenders(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	msg := func(n, sender string) map[string]any {
		return map[string]any{"name": "spaces/S/messages/" + n, "text": "text " + n, "createTime": "2026-04-0" + n + "T10:00:00Z",
			"lastUpdateTime": "2026-04-0" + n + "T11:00:00Z", "sender": map[string]any{"name": sender, "displayName": "Chat " + sender}, "thread": map[string]any{"name": "spaces/S/threads/t"}}
	}
	cf := &chatFake{
		messages:  []map[string]any{msg("5", "users/1"), msg("4", "users/2"), msg("3", "users/3"), msg("2", "users/1")},
		directory: []any{person("1", "Alice", "alice@example.com")},
		people:    map[string]map[string]any{"2": person("2", "Bob", "")},
	}
	fake := googletest.NewFake(t, cf.handle)
	var res any
	var err error
	stderr := captureStderr(t, func() {
		res, err = product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{
			"space": "S", "limit": "3", "thread": "t", "since": "2026-04-01", "until": "2026-05-01T10:00:00+02:00",
		}))
	})
	if err != nil {
		t.Fatal(err)
	}
	var lists []googletest.Hit
	for _, h := range fake.Recorded() {
		if h.Path == "/v1/spaces/S/messages" {
			lists = append(lists, h)
		}
	}
	filter := `thread.name = "spaces/S/threads/t" AND createTime > "2026-04-01T00:00:00.000Z" AND createTime < "2026-05-01T08:00:00.000Z"`
	if len(lists) != 2 || lists[0].Query.Get("pageSize") != "3" || lists[1].Query.Get("pageSize") != "1" ||
		lists[0].Query.Get("orderBy") != "createTime desc" || lists[0].Query.Get("filter") != filter || lists[1].Query.Get("pageToken") != "2" {
		t.Fatalf("%#v", lists)
	}
	if stderr != "Warning: reached --limit 3; more messages exist before 2026-04-03T10:00:00Z. Raise --limit or narrow the window with --since/--until.\n" {
		t.Fatalf("%q", stderr)
	}
	want := "Messages (3)\n\n[1] spaces/S/messages/5\n    From: Alice <alice@example.com>\n    > text 5\n    Date: 2026-04-05T10:00:00Z\n\n" +
		"[2] spaces/S/messages/4\n    From: Bob\n    > text 4\n    Date: 2026-04-04T10:00:00Z\n\n" +
		"[3] spaces/S/messages/3\n    From: Chat users/3\n    > text 3\n    Date: 2026-04-03T10:00:00Z\n"
	if got := product.Spec(t, "list").Format(res); got != want {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(res); !strings.HasPrefix(got, `[{"name":"spaces/S/messages/5","createTime":"2026-04-05T10:00:00Z","updateTime":"2026-04-05T11:00:00Z","text":"text 5","sender":{"name":"users/1","displayName":"Alice","email":"alice@example.com"},"thread":{"name":"spaces/S/threads/t"}}`) {
		t.Fatalf("%s", got)
	}
	// The directory was cached where Bun keeps it.
	path, _ := plugincache.Path("gchat", "me@example.com", "directory")
	if raw, err := os.ReadFile(path); err != nil || !strings.Contains(string(raw), `"users/1":{"displayName":"Alice","email":"alice@example.com"}`) || !strings.Contains(string(raw), `"syncToken":"sync-1"`) {
		t.Fatalf("%s %v", raw, err)
	}
	// --format json prints the array; no warning when the range is complete.
	stderr = captureStderr(t, func() {
		res, err = product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"space": "S", "limit": "abc", "format": "json"}))
	})
	if err != nil || stderr != "" {
		t.Fatalf("%v %q", err, stderr)
	}
	if got := product.Spec(t, "list").Format(res); !strings.HasPrefix(got, "[\n  {\n    \"name\": \"spaces/S/messages/5\",\n    \"createTime\"") || !strings.HasSuffix(got, "  }\n]") {
		t.Fatalf("%q", got)
	}
	if n := len(res.(shown[[]message]).Value); n != 4 {
		t.Fatalf("NaN limit is 10: %d", n)
	}
}

func TestListAndGetErrorsMatchBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	cf := &chatFake{messages: []map[string]any{{"name": "spaces/S/messages/1"}, {"name": "spaces/S/messages/2"}}}
	fake := googletest.NewFake(t, cf.handle)
	const listHint = "Check that the space ID is valid and OAuth token is not expired"
	cases := []struct {
		path    string
		in      plugins.CommandInput
		status  int
		code    clierr.Code
		message string
		suggest string
	}{
		{"list", product.Input(t, "list", nil, nil), 0, clierr.InvalidParams, "required option '--space <id>' not specified", ""},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "S", "format": "xml"}), 0, clierr.InvalidParams, "Unknown format: xml", "Use --format text or --format json"},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "  "}), 0, clierr.InvalidParams, "spaceId is required for listing messages", "Specify with --space or configure default in profile"},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "S", "since": "last week"}), 0, clierr.APIError, "Failed to list messages: Invalid Date", listHint},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "S", "until": "2026-02-32"}), 0, clierr.APIError, "Failed to list messages: Invalid Date", listHint},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "S", "limit": "-1"}), 0, clierr.APIError, "Failed to list messages: Invalid array length", listHint},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "S"}), 403, clierr.PermissionDenied, "Failed to list messages: Bot lacks permission for this operation", listHint},
		{"list", product.Input(t, "list", nil, map[string]any{"space": "Nowhere"}), 0, clierr.NotFound, `Space not found: "Nowhere"`, `Use "agentio gchat spaces" to list available spaces`},
		{"get", product.Input(t, "get", map[string]any{"message-id": "9"}, map[string]any{"space": "S"}), 0, clierr.NotFound, "Failed to get message: Space or message not found", "Check that the space ID and message ID are valid"},
		{"get", product.Input(t, "get", map[string]any{"message-id": " "}, map[string]any{"space": "S"}), 0, clierr.InvalidParams, "Both spaceId and messageId are required", "Specify with --space and message ID"},
		{"get", product.Input(t, "get", map[string]any{"message-id": "1"}, nil), 0, clierr.InvalidParams, "required option '--space <id>' not specified", ""},
	}
	for _, c := range cases {
		cf.listStatus = c.status
		res, err := product.Exec(fake.Ctx(), t, reg, c.path, c.in)
		ce := googletest.CliErr(t, err)
		if res != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%s %v: %#v", c.path, c.in.Options, ce)
		}
	}
}

func TestGetResolvesTheSpaceByNameAndPrintsTheMessage(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	cf := &chatFake{
		messages:  []map[string]any{{"name": "spaces/ENG1/messages/7", "text": "line1\nline2", "createTime": "2026-04-01T00:00:00Z", "sender": map[string]any{"name": "users/1"}, "thread": map[string]any{"name": "spaces/ENG1/threads/t"}}},
		dirStatus: 403,
		people:    map[string]map[string]any{"1": person("1", "Alice", "alice@example.com")},
	}
	fake := googletest.NewFake(t, cf.handle)
	res, err := product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"message-id": "7"}, map[string]any{"space": "engineering"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Spec(t, "get").Format(res); got != "ID: spaces/ENG1/messages/7\nFrom: Alice <alice@example.com>\nDate: 2026-04-01T00:00:00Z\nThread: spaces/ENG1/threads/t\n---\nline1\nline2" {
		t.Fatalf("%q", got)
	}
	// People fields asked for a sender are names and emails only.
	for _, h := range fake.Recorded() {
		if h.Path == "/v1/people/1" && h.Query.Get("personFields") != "names,emailAddresses" {
			t.Fatalf("%v", h.Query)
		}
	}
	res, _ = product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"message-id": "7"}, map[string]any{"space": "ENG1", "format": "json"}))
	if got := product.Spec(t, "get").Format(res); !strings.HasPrefix(got, "{\n  \"name\": \"spaces/ENG1/messages/7\",\n  \"createTime\": \"2026-04-01T00:00:00Z\",\n  \"updateTime\": \"") {
		t.Fatalf("%q", got)
	}
}

func TestSpacesAndDirectMessages(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	cf := &chatFake{directory: []any{person("7", "Grace", "Grace@Example.com"), person("8", "", "h@example.com")}}
	fake := googletest.NewFake(t, cf.handle)
	res, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Spec(t, "spaces").Format(res); got != "Spaces (3)\n\n[ROOM] ENG1  Engineering  - Eng team\n[DM] DM1  Unnamed\n[DM] G1  Group" {
		t.Fatalf("%q", got)
	}
	res, _ = product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"filter": "ENG"}))
	if got := product.Spec(t, "spaces").Format(res); got != "Spaces (1)\n\n[ROOM] ENG1  Engineering  - Eng team" {
		t.Fatalf("%q", got)
	}
	res, _ = product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"filter": "zzz"}))
	if got := product.Spec(t, "spaces").Format(res); got != "No spaces found" || googletest.JSONText(res) != "[]" {
		t.Fatalf("%q %s", got, googletest.JSONText(res))
	}
	// An email resolves through the directory; the DM name comes from it too.
	res, err = product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"with": "grace@example.COM"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Spec(t, "spaces").Format(res); got != "Spaces (1)\n\n[DM] DM7  Grace" {
		t.Fatalf("%q", got)
	}
	cases := []struct {
		with    string
		code    clierr.Code
		message string
		suggest string
	}{
		{"8", clierr.PermissionDenied, `findDirectMessage failed: 403 {"error":{"code":403,"message":"scope"}}` + "\n", "Check that the OAuth scope includes chat.spaces.readonly"},
		{"users/9", clierr.NotFound, "No direct message space exists with users/9", "Open the chat once in Google Chat to create the DM space"},
		// Bun's findDirectMessage is a plain fetch: a 503 is not retried.
		{"users/5", clierr.APIError, `findDirectMessage failed: 503 {"error":{"code":503,"message":"busy"}}` + "\n", "Check that the OAuth scope includes chat.spaces.readonly"},
		{"grace", clierr.InvalidParams, `Cannot resolve "grace" to a user`, "Provide an email address, numeric user ID, or users/<id> resource name"},
		{"nobody@example.com", clierr.NotFound, "Email not found in workspace directory: nobody@example.com", `Run "agentio gchat directory refresh" if the user was added recently`},
	}
	for _, c := range cases {
		res, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"with": c.with}))
		ce := googletest.CliErr(t, err)
		if res != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggest {
			t.Errorf("%s: %#v", c.with, ce)
		}
	}
	before := len(fake.Recorded())
	if _, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"with": "users/5"})); err == nil {
		t.Fatal("no error")
	}
	if n := len(fake.Recorded()) - before; n != 1 {
		t.Fatalf("findDirectMessage sent %d requests", n)
	}
	// An answer that is not JSON fails as res.json() does.
	if _, err := product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"with": "users/6"})); err == nil || err.Error() != "JSON Parse error: Unrecognized token '<'" {
		t.Fatalf("%v", err)
	}
	// A directory that cannot be fetched is reported when an email needs it.
	cf.dirStatus = 403
	if err := os.RemoveAll(filepath.Join(vault.ConfigDir(), "cache")); err != nil {
		t.Fatal(err)
	}
	_, err = product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"with": "grace@example.com"}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.APIError || !strings.HasPrefix(ce.Message, "Failed to refresh workspace directory: listDirectoryPeople failed: 403 {") ||
		ce.Suggestion != "Check OAuth scope and network connectivity" {
		t.Fatalf("%#v", ce)
	}
	noEmail := freshOAuth()
	delete(noEmail, "email")
	product.SaveProfile(t, "anon", noEmail, false)
	_, err = product.Exec(fake.Ctx(), t, reg, "spaces", product.Input(t, "spaces", nil, map[string]any{"with": "grace@example.com", "profile": "anon"}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.ConfigError || ce.Message != "Directory cache requires an OAuth profile with an email" {
		t.Fatalf("%#v", ce)
	}
}

func TestMembersAndUserUsePeopleThenTheDirectory(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	full := person("1", "Alice", "alice@example.com")
	full["phoneNumbers"] = []any{map[string]any{"value": "+1 555"}, map[string]any{}}
	full["organizations"] = []any{map[string]any{"title": "CTO", "name": "Acme"}, map[string]any{}}
	full["photos"] = []any{map[string]any{"url": "https://photo.example.com/a"}}
	full["locations"] = []any{map[string]any{"value": "Paris"}}
	cf := &chatFake{
		people:    map[string]map[string]any{"1": full, "2": {"resourceName": "people/2"}},
		directory: []any{person("2", "Bob Dir", "bob@example.com")},
	}
	fake := googletest.NewFake(t, cf.handle)
	res, err := product.Exec(fake.Ctx(), t, reg, "members", product.Input(t, "members", nil, map[string]any{"space": "S"}))
	if err != nil {
		t.Fatal(err)
	}
	want := "Members (4)\n\n[1] Alice <alice@example.com> [MANAGER]\n    User ID: users/1\n    CTO · Acme\n" +
		"[2] Bob Dir <bob@example.com> [INVITED]\n    User ID: users/2\n" +
		"[3] Bot [BOT] [MEMBERSHIP_STATE_UNSPECIFIED]\n    User ID: users/3\n" +
		"[4] (unknown)"
	if got := product.Spec(t, "members").Format(res); got != want {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(res.([]member)[3]); got != `{"name":"spaces/S/members/4","role":"ROLE_MEMBER","state":"JOINED","memberType":"HUMAN"}` {
		t.Fatalf("%s", got)
	}
	for _, h := range fake.Recorded() {
		if h.Path == "/v1/people/1" && h.Query.Get("personFields") != "names,emailAddresses,phoneNumbers,organizations,photos,locations" {
			t.Fatalf("%v", h.Query)
		}
	}
	res, err = product.Exec(fake.Ctx(), t, reg, "user", product.Input(t, "user", map[string]any{"user-id": "1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Spec(t, "user").Format(res); got != "ID: users/1\nName: Alice\nEmail: alice@example.com\nPhone: +1 555\nOrganizations:\n  - CTO · Acme\nLocation: Paris\nPhoto: https://photo.example.com/a" {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(res); got != `{"name":"users/1","displayName":"Alice","email":"alice@example.com","phoneNumbers":["+1 555"],"organizations":[{"name":"Acme","title":"CTO"},{}],"photoUrl":"https://photo.example.com/a","locations":["Paris"]}` {
		t.Fatalf("%s", got)
	}
	res, err = product.Exec(fake.Ctx(), t, reg, "user", product.Input(t, "user", map[string]any{"user-id": "users/2"}, nil))
	if err != nil || product.Spec(t, "user").Format(res) != "ID: users/2\nName: Bob Dir\nEmail: bob@example.com" {
		t.Fatalf("%v %q", err, product.Spec(t, "user").Format(res))
	}
	res, err = product.Exec(fake.Ctx(), t, reg, "user", product.Input(t, "user", map[string]any{"user-id": "404"}, nil))
	if ce := googletest.CliErr(t, err); res != nil || ce.Code != clierr.NotFound || ce.Message != `User not found: "404"` || ce.Suggestion != "Check the user ID is valid" {
		t.Fatalf("%#v", ce)
	}
	// Bun reads people with plain fetch: a 503 is not retried; it falls back
	// to the directory.
	before := len(fake.Recorded())
	_, err = product.Exec(fake.Ctx(), t, reg, "user", product.Input(t, "user", map[string]any{"user-id": "503"}, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.NotFound {
		t.Fatalf("%#v", ce)
	}
	n := 0
	for _, h := range fake.Recorded()[before:] {
		if h.Path == "/v1/people/503" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("people/503 requested %d times", n)
	}
	_, err = product.Exec(fake.Ctx(), t, reg, "members", product.Input(t, "members", nil, nil))
	if ce := googletest.CliErr(t, err); ce.Message != "required option '--space <id-or-name>' not specified" {
		t.Fatalf("%#v", ce)
	}
}

func TestDirectoryRefreshTTLAndIncrementalSync(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	var dirHits []googletest.Hit
	var incremental []any
	incrementalStatus := 200
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path != "/v1/people:listDirectoryPeople" {
			googletest.WriteAPIError(w, 404, "none")
			return
		}
		dirHits = append(dirHits, h)
		if h.Query.Get("syncToken") != "" {
			if incrementalStatus != 200 {
				googletest.WriteAPIError(w, incrementalStatus, "expired")
				return
			}
			googletest.WriteJSON(w, 200, map[string]any{"people": incremental})
			return
		}
		if h.Query.Get("pageToken") == "" {
			googletest.WriteJSON(w, 200, map[string]any{"people": []any{person("1", "Alice", "a@example.com"), person("", "Nobody", "")}, "nextPageToken": "p2"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"people": []any{person("2", "", "b@example.com"), person("3", "", "")}, "nextSyncToken": "sync-1"})
	})
	clock := time.Date(2026, 4, 1, 10, 0, 0, 0, time.UTC)
	prev := now
	now = func() time.Time { return clock }
	t.Cleanup(func() { now = prev })
	res, err := product.Exec(fake.Ctx(), t, reg, "directory refresh", product.Input(t, "directory refresh", nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	path, _ := plugincache.Path("gchat", "me@example.com", "directory")
	if got := product.Spec(t, "directory refresh").Format(res); got != "Refreshed: 2 users\nPath: "+path+"\nFetched at: 2026-04-01T10:00:00.000Z" {
		t.Fatalf("%q", got)
	}
	q := dirHits[0].Query
	if len(dirHits) != 2 || q.Get("readMask") != "names,emailAddresses" || q.Get("sources") != "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE" ||
		q.Get("pageSize") != "1000" || q.Get("requestSyncToken") != "true" || dirHits[1].Query.Get("pageToken") != "p2" {
		t.Fatalf("%#v", dirHits)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"fetchedAt":"2026-04-01T10:00:00.000Z","syncToken":"sync-1","users":{"users/1":{"displayName":"Alice","email":"a@example.com"},"users/2":{"displayName":"b@example.com","email":"b@example.com"}}}` {
		t.Fatalf("%s", raw)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	// Inside the TTL, resolving an email reads the cache only.
	a, err := apiFrom(fake.Ctx(), host.NewRunContext(testbox.Object(freshOAuth()), "acme", fake.Ctx()))
	if err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(23 * time.Hour)
	if id, err := a.resolveUserResourceName("B@example.com"); err != nil || id != "users/2" || len(dirHits) != 2 {
		t.Fatalf("%q %v %d", id, err, len(dirHits))
	}
	// After a day the sync token fetches only the changes.
	clock = clock.Add(2 * time.Hour)
	deleted := person("1", "", "")
	deleted["metadata"] = map[string]any{"deleted": true}
	incremental = []any{deleted, person("4", "Dan", "d@example.com")}
	a, _ = apiFrom(fake.Ctx(), host.NewRunContext(testbox.Object(freshOAuth()), "acme", fake.Ctx()))
	if id, err := a.resolveUserResourceName("d@example.com"); err != nil || id != "users/4" {
		t.Fatalf("%q %v", id, err)
	}
	if last := dirHits[len(dirHits)-1]; last.Query.Get("syncToken") != "sync-1" || len(dirHits) != 3 {
		t.Fatalf("%#v", last.Query)
	}
	if a.dir.lookup("users/1") != nil || a.dir.data.SyncToken != "sync-1" {
		t.Fatal("the incremental sync did not apply the deletion or lost the token")
	}
	// A rejected sync token falls back to a full fetch.
	clock = clock.Add(25 * time.Hour)
	incrementalStatus = 410
	a, _ = apiFrom(fake.Ctx(), host.NewRunContext(testbox.Object(freshOAuth()), "acme", fake.Ctx()))
	if id, err := a.resolveUserResourceName("a@example.com"); err != nil || id != "users/1" || len(dirHits) != 6 {
		t.Fatalf("%q %v %d", id, err, len(dirHits))
	}
	// A forced refresh surfaces the directory error as Bun's plain Error.
	fake.SetHandle(func(w http.ResponseWriter, h googletest.Hit) { googletest.WriteAPIError(w, 403, "no") })
	res, err = product.Exec(fake.Ctx(), t, reg, "directory refresh", product.Input(t, "directory refresh", nil, nil))
	var ce *clierr.Error
	if res != nil || err == nil || errors.As(err, &ce) || err.Error() != "listDirectoryPeople failed: 403 {\"error\":{\"code\":403,\"message\":\"no\"}}\n" {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestFormatMatchesBun(t *testing.T) {
	long := strings.Repeat("x", 100) + "yz"
	list := shown[[]message]{Value: []message{
		{Name: "spaces/S/messages/1", CreateTime: "T1", Text: long, Sender: &sender{Name: "users/1", DisplayName: "Ann", Email: "a@example.com"}},
		{Name: "spaces/S/messages/2", CreateTime: "T2", Sender: &sender{Name: "users/2"}},
		{Name: "spaces/S/messages/3", CreateTime: "T3"},
	}}
	want := "Messages (3)\n\n[1] spaces/S/messages/1\n    From: Ann <a@example.com>\n    > " + strings.Repeat("x", 100) + "...\n    Date: T1\n\n" +
		"[2] spaces/S/messages/2\n    From: Unknown\n    Date: T2\n\n[3] spaces/S/messages/3\n    Date: T3\n"
	if got := formatMessageList(list); got != want {
		t.Fatalf("%q", got)
	}
	if formatMessageList(shown[[]message]{Value: []message{}}) != "No messages found" || formatMessageList(shown[[]message]{Value: []message{}, JSON: true}) != "[]" {
		t.Fatal("empty")
	}
	if got := formatMessage(shown[*message]{Value: &message{Name: "m", CreateTime: "T"}}); got != "ID: m\nDate: T" {
		t.Fatalf("%q", got)
	}
	if got := formatSendResult(&sendResult{MessageID: "unknown"}); got != "Message sent\nID: unknown" {
		t.Fatalf("%q", got)
	}
	if formatMembers([]member{}) != "No members found" {
		t.Fatal("members")
	}
	if got := formatUser(&user{Name: "users/1", Organizations: []organization{{}}}); got != "ID: users/1\nOrganizations:" {
		t.Fatalf("%q", got)
	}
	// JSON output keeps <, > and & as Bun's JSON.stringify does.
	if got := formatMessage(shown[*message]{Value: &message{Name: "a<b>&c", CreateTime: "T", UpdateTime: "U"}, JSON: true}); got != "{\n  \"name\": \"a<b>&c\",\n  \"createTime\": \"T\",\n  \"updateTime\": \"U\"\n}" {
		t.Fatalf("%q", got)
	}
}

// Bun checks the space and message ids with String#trim, which strips U+FEFF
// and keeps U+0085; strings.TrimSpace does the opposite.
func TestIDChecksTrimLikeJavaScript(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteAPIError(w, 404, "nope")
	})
	for _, c := range []struct {
		path  string
		args  map[string]any
		space string
		msg   string
	}{
		{"list", nil, "\ufeff", "spaceId is required for listing messages"},
		{"get", map[string]any{"message-id": "M1"}, "\ufeff", "Both spaceId and messageId are required"},
		{"get", map[string]any{"message-id": "\ufeff"}, "S1", "Both spaceId and messageId are required"},
	} {
		_, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, c.args, map[string]any{"space": c.space}))
		if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != c.msg {
			t.Fatalf("%s %q: %#v", c.path, c.space, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("%d requests", n)
	}
	// U+0085 is not JavaScript whitespace: the ids pass the check and reach the API.
	for _, c := range []struct {
		path string
		args map[string]any
	}{{"list", nil}, {"get", map[string]any{"message-id": "\u0085"}}} {
		before := len(fake.Recorded())
		_, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, c.args, map[string]any{"space": "\u0085"}))
		if ce := googletest.CliErr(t, err); ce.Code == clierr.InvalidParams || len(fake.Recorded()) == before {
			t.Fatalf("%s: %#v", c.path, ce)
		}
	}
}

// Commander treats --space "" as present: list rejects it with Bun's client
// message before any request, members looks "" up as Bun does.
func TestEmptySpaceReachesTheClient(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", freshOAuth(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"spaces": []any{}})
	})
	_, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"space": ""}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "spaceId is required for listing messages" || len(fake.Recorded()) != 0 {
		t.Fatalf("%#v", ce)
	}
	_, err = product.Exec(fake.Ctx(), t, reg, "members", product.Input(t, "members", nil, map[string]any{"space": ""}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.NotFound || ce.Message != `Space not found: ""` || len(fake.Recorded()) == 0 {
		t.Fatalf("%#v", ce)
	}
}

// `--format json` is JSON.stringify(value, null, 2): U+2028 and U+2029 as
// they are.
func TestFormatJSONKeepsLineSeparators(t *testing.T) {
	if got, want := asJSON(map[string]any{"text": "a b <&>"}), "{\n  \"text\": \"a b <&>\"\n}"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// freshExpiry is a stored expiry far ahead: google-auth-library would
// refresh an expiring token on its own before the call.
const freshExpiry = 9_000_000_000_000

// The directory keeps the users object's order, as Bun does: a lookup by
// email takes the first match in that order (not in sorted id order), and a
// rewrite keeps it. Expectations are Bun's Object.entries and JSON.stringify.
func TestDirectoryKeepsTheUsersOrder(t *testing.T) {
	testbox.Isolate(t)
	path, err := plugincache.Path("gchat", "me@example.com", "directory")
	if err != nil {
		t.Fatal(err)
	}
	file := `{"fetchedAt":"2999-01-01T00:00:00.000Z","users":{"users/9":{"displayName":"Nine","email":"dup@example.com"},"users/1":{"displayName":"One","email":"DUP@example.com"}}}`
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	d := newDirectory(context.Background(), nil, "me@example.com")
	if err := d.ensureFresh(false); err != nil {
		t.Fatal(err)
	}
	if id, entry := d.lookupByEmail("dup@EXAMPLE.com"); id != "users/9" || entry.DisplayName != "Nine" {
		t.Fatalf("%q %#v", id, entry)
	}
	d.data.Users.set("users/1", directoryEntry{DisplayName: "Uno"})
	d.data.Users.set("users/5", directoryEntry{DisplayName: "Five"})
	d.data.Users.remove("users/9")
	if err := d.save(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"fetchedAt":"2999-01-01T00:00:00.000Z","users":{"users/1":{"displayName":"Uno"},"users/5":{"displayName":"Five"}}}` {
		t.Fatalf("%s", raw)
	}
}
