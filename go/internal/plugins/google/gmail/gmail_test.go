package gmail

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
		"scope":         "https://www.googleapis.com/auth/gmail.readonly",
		"email":         "me@example.com",
	}
}

// runDirect runs a command's handler with fresh credentials and captures
// what it logs to stderr.
func runDirect(t *testing.T, ctx context.Context, path string, in plugins.CommandInput) (any, error, []string) {
	t.Helper()
	var logs []string
	run := host.NewRunContext(storedCreds(time.Now().Add(time.Hour).UnixMilli()), "acme", ctx)
	run.Log = func(parts ...any) {
		for _, p := range parts {
			logs = append(logs, p.(string))
		}
	}
	v, err := product.Spec(t, path).Run(ctx, in, run)
	return v, err, logs
}

func wantErr(t *testing.T, err error, code clierr.Code, message, suggestion string) {
	t.Helper()
	ce := googletest.CliErr(t, err)
	if ce.Code != code || ce.Message != message || ce.Suggestion != suggestion {
		t.Fatalf("got %s %q %q\nwant %s %q %q", ce.Code, ce.Message, ce.Suggestion, code, message, suggestion)
	}
}

// rawMessage decodes the base64url RFC 822 text a send or draft carried.
func rawMessage(t *testing.T, raw any) string {
	t.Helper()
	s, _ := raw.(string)
	if strings.ContainsAny(s, "+/=") {
		t.Fatalf("raw is not unpadded base64url: %q", s)
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func pinBoundaries(t *testing.T) {
	t.Helper()
	prevNow, prevRand := now, randomBase
	now = func() time.Time { return time.UnixMilli(1700000000000) }
	randomBase = func() string { return "abc123xyz" }
	t.Cleanup(func() { now, randomBase = prevNow, prevRand })
}

// The command table is the Bun surface: `bun run src/index.ts gmail --help`
// and each leaf's --help. A renamed flag, a lost default, a missing leaf, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op, input string
	}
	compose := "--to <email>* --cc <email>* --bcc <email>* --subject <subject> --subject-file <path> --body <body> --body-file <path> --spec <path.json> --html --reply-to <thread-id> --attachment <path>* --inline <cid:path>*"
	chunks := "--chunk-size <n>=1000 --max-retries <n>=5 --dry-run"
	want := map[string]row{
		"list":           {"", "--limit <n>=10 --query <query> --label <label>*", "read", "", ""},
		"get":            {"<message-id>", "--format <format>=text --body-only", "read", "", ""},
		"search":         {"", "--query <query> --limit <n>=10 --ids-only", "read", "", ""},
		"send":           {"", compose, "write", "send email", "text"},
		"draft":          {"[draft-id]", compose, "write", "create draft", "text"},
		"draft delete":   {"<draft-id...>", "", "write", "delete draft", ""},
		"archive":        {"[message-id...]", chunks, "write", "archive email", "text"},
		"mark":           {"<message-id...>", "--read --unread", "write", "mark email", ""},
		"labels list":    {"", "", "read", "", ""},
		"labels create":  {"<name>", "", "write", "create label", ""},
		"labels delete":  {"<name-or-id>", "", "write", "delete label", ""},
		"labels rename":  {"<old> <new>", "", "write", "rename label", ""},
		"filters list":   {"", "", "read", "", ""},
		"filters get":    {"<id>", "", "read", "", ""},
		"filters create": {"", "--from <email> --to <email> --subject <text> --query <q> --negated-query <q> --has-attachment --exclude-chats --size <bytes> --size-comparison <cmp> --apply <label>* --remove <label>* --forward <email>", "write", "create filter", ""},
		"filters delete": {"<id...>", "", "write", "delete filter", ""},
		"label":          {"[id...]", "--apply <name>* --remove <name>* --thread " + chunks, "write", "modify labels", "text"},
		"attachment":     {"<message-id>", "--name <filename> --output <dir>=.", "read", "", ""},
		"export":         {"<message-id>", "--output <path>=message.pdf", "read", "", ""},
	}
	p := New()
	if p.ID != "gmail" || p.DisplayName != "Gmail" ||
		p.Description != "Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, ",") != "list,get,search,send,draft,draft delete,archive,mark,labels list,labels create,labels delete,labels rename,filters list,filters get,filters create,filters delete,label,attachment,export" {
		t.Fatalf("order %v", order)
	}
	for _, c := range p.Commands {
		w, ok := want[c.Path]
		if !ok {
			t.Fatalf("unexpected command %q", c.Path)
		}
		var args, flags []string
		for _, a := range c.Arguments {
			name := a.Name
			if a.Variadic {
				name += "..."
			}
			if a.Required {
				args = append(args, "<"+name+">")
			} else {
				args = append(args, "["+name+"]")
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
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refresh_token" {
		t.Fatal("gmail is a snake_case Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/gmail.readonly"})
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
	var logs []string
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) { logs = append(logs, parts[0].(string)) }
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	var out bytes.Buffer
	if err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:3001/callback"))
	scope := "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/userinfo.email"
	if opts.Port != 0 || opts.ServiceName != "Google" || authURL.Query().Get("scope") != scope || authURL.Query().Get("access_type") != "offline" {
		t.Fatalf("oauth %#v %s", opts, authURL)
	}
	if strings.Join(logs, "|") != "Starting OAuth flow for Gmail...\n" {
		t.Fatalf("logs %q", logs)
	}
	stored := product.LoadCreds(t, "user@example.com")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "access_token,email,expiry_date,refresh_token,scope,token_type" {
		t.Fatalf("keys %v", keys)
	}
	if stored["access_token"] != "at-1" || stored["refresh_token"] != "rt-1" || stored["email"] != "user@example.com" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiry_date"].(json.Number); !ok {
		t.Fatalf("expiry_date is %T, want a JSON number", stored["expiry_date"])
	}
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\n" {
		t.Fatalf("%q", out.String())
	}
}

func TestSetupFailsWithBunsMessageWhenTheEmailIsMissing(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1"})
			return
		}
		w.WriteHeader(500)
	})
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, io.Discard)
	wantErr(t, err, clierr.AuthFailed, "Could not fetch email from Gmail", "Try again or specify --profile manually")
	if c, _ := vault.Load(); len(c.Credentials["gmail"]) != 0 {
		t.Fatal("a failed setup saved a profile")
	}
}

// Bun never rotates a Google refresh token: the stored one is kept.
func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	creds := storedCreds(1)
	creds["legacy"] = "kept"
	product.SaveProfile(t, "acme", creds, false)
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
		googletest.WriteJSON(w, 200, map[string]any{"labels": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gmail", "acme", auth.RefreshOptions{})
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
	stored := product.LoadCreds(t, "acme")
	if stored["access_token"] != "at-new" || stored["refresh_token"] != "rt-old" || stored["legacy"] != "kept" ||
		stored["scope"] != "https://www.googleapis.com/auth/gmail.readonly" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiry_date"].(json.Number); !ok {
		t.Fatalf("expiry_date %T", stored["expiry_date"])
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "labels list", product.Input(t, "labels list", nil, nil)); err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if last := all[len(all)-1]; last.Auth != "Bearer at-new" || last.Path != "/gmail/v1/users/me/labels" || refreshes != 1 {
		t.Fatalf("auth %q path %s refreshes %d", last.Auth, last.Path, refreshes)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(1), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, nil))
	wantErr(t, err, clierr.TokenExpired, `Token refresh failed for gmail profile "acme": invalid_grant`,
		"Re-authenticate with: agentio gmail profile add --profile acme")
	stored := product.LoadCreds(t, "acme")
	if stored["access_token"] != "at-old" || stored["refresh_token"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

// Bun validates its input before enforceWriteAccess, so a read-only profile
// gets the input error; valid input is refused with Bun's operation, and a
// dry run is never a write.
func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", storedCreds(time.Now().Add(24*time.Hour).UnixMilli()), true)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"labels": []any{}, "filter": []any{}, "messages": []any{}})
	})
	compose := map[string]any{"to": []string{"a@example.com"}, "subject": "Hi", "body": "Hello"}
	cases := []struct {
		path string
		args map[string]any
		set  map[string]any
		op   string
	}{
		{"send", nil, compose, "send email"},
		{"draft", nil, compose, "create draft"},
		{"draft", map[string]any{"draft-id": "r-1"}, compose, "update draft"},
		{"draft delete", map[string]any{"draft-id": []string{"r-1"}}, nil, "delete draft"},
		{"archive", map[string]any{"message-id": []string{"m1"}}, nil, "archive email"},
		{"mark", map[string]any{"message-id": []string{"m1"}}, map[string]any{"read": true}, "mark email"},
		{"labels create", map[string]any{"name": "x"}, nil, "create label"},
		{"labels delete", map[string]any{"name-or-id": "x"}, nil, "delete label"},
		{"labels rename", map[string]any{"old": "x", "new": "y"}, nil, "rename label"},
		{"filters create", nil, map[string]any{"from": "a@example.com", "apply": []string{"X"}}, "create filter"},
		{"filters delete", map[string]any{"id": []string{"f1"}}, nil, "delete filter"},
		{"label", map[string]any{"id": []string{"m1"}}, map[string]any{"apply": []string{"X"}}, "modify labels"},
	}
	for _, c := range cases {
		_, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, c.args, c.set))
		wantErr(t, err, clierr.PermissionDenied, `Cannot `+c.op+`: profile "ro" is read-only`,
			"To modify this profile's access: agentio gmail profile update --profile ro --no-read-only")
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	// Input Bun rejects first answers with the input error, not the refusal.
	_, err := product.Exec(fake.Ctx(), t, reg, "send", product.Input(t, "send", nil, map[string]any{"subject": "Hi", "body": "x"}))
	wantErr(t, err, clierr.InvalidParams, "--to is required (unless using --reply-to)", "")
	_, err = product.Exec(fake.Ctx(), t, reg, "mark", product.Input(t, "mark", map[string]any{"message-id": []string{"m1"}}, nil))
	wantErr(t, err, clierr.InvalidParams, "Specify --read or --unread", "")
	_, err = product.Exec(fake.Ctx(), t, reg, "archive", product.Input(t, "archive", nil, nil))
	wantErr(t, err, clierr.InvalidParams, "No message IDs provided", "Pass IDs as args or pipe via stdin")
	_, err = product.Exec(fake.Ctx(), t, reg, "label", product.Input(t, "label", map[string]any{"id": []string{"m1"}}, nil))
	wantErr(t, err, clierr.InvalidParams, "Specify at least one --apply or --remove", "")
	_, err = product.Exec(fake.Ctx(), t, reg, "filters create", product.Input(t, "filters create", nil, map[string]any{"apply": []string{"X"}}))
	wantErr(t, err, clierr.InvalidParams, "At least one criterion is required",
		"Use --from, --to, --subject, --query, --negated-query, --has-attachment, --exclude-chats, or --size")
	// A dry run plans without the API, even on a read-only profile.
	v, err := product.Exec(fake.Ctx(), t, reg, "archive", product.Input(t, "archive", map[string]any{"message-id": []string{"a", "b"}}, map[string]any{"dry-run": true}))
	if err != nil || render(v) != "[dry-run] archive\n  ids: 2\n  chunk size: 1000\n  chunks: 1\n  remove labels: INBOX\n  no API calls made" {
		t.Fatalf("dry run %q %v", render(v), err)
	}
	for _, path := range []string{"list", "labels list", "filters list"} {
		if _, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, nil, nil)); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if n := len(fake.Recorded()); n == 0 {
		t.Fatal("reads did not run")
	}
}

// Bun archive and label print a dry-run plan before getGmailClient: no
// profile, two profiles and no --profile, an unknown --profile, or a token
// that cannot refresh offline all still print the plan. A real run does not.
func TestDryRunNeedsNoProfile(t *testing.T) {
	reg := product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteAPIError(w, 500, "offline")
	})
	archive := func(opts map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "archive", product.Input(t, "archive", map[string]any{"message-id": []string{"a", "b"}}, opts))
	}
	label := func(opts map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "label", product.Input(t, "label", map[string]any{"id": []string{"a"}}, opts))
	}
	plan := func(profileFlag string) {
		t.Helper()
		opts := map[string]any{"dry-run": true}
		if profileFlag != "" {
			opts["profile"] = profileFlag
		}
		v, err := archive(opts)
		if err != nil || render(v) != "[dry-run] archive\n  ids: 2\n  chunk size: 1000\n  chunks: 1\n  remove labels: INBOX\n  no API calls made" {
			t.Fatalf("archive --profile %q: %q %v", profileFlag, render(v), err)
		}
		opts["apply"] = []string{"X"}
		v, err = label(opts)
		if err != nil || render(v) != "[dry-run] label\n  ids: 1\n  chunk size: 1000\n  chunks: 1\n  add labels: X\n  no API calls made" {
			t.Fatalf("label --profile %q: %q %v", profileFlag, render(v), err)
		}
	}
	plan("")
	plan("nope")
	product.SaveProfile(t, "a", storedCreds(1), false)
	product.SaveProfile(t, "b", storedCreds(1), true)
	plan("")
	plan("a")
	plan("b")
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a dry run reached the network %d times", n)
	}
	if got := product.LoadCreds(t, "a")["access_token"]; got != "at-old" {
		t.Fatalf("a dry run refreshed the token: %v", got)
	}
	// Invalid input still fails, before any profile.
	_, err := label(map[string]any{"dry-run": true})
	wantErr(t, err, clierr.InvalidParams, "Specify at least one --apply or --remove", "")
	// Without --dry-run the profile is still required.
	_, err = archive(nil)
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || !strings.Contains(ce.Message, "Multiple gmail profiles") {
		t.Fatalf("real run: %#v", ce)
	}
}

// Bun parseChunkOpts is `parseInt(options.maxRetries ?? '5', 10) || 0`: a
// given "" is NaN, so no retries; an absent option is the default.
func TestChunkOptionsKeepAGivenEmptyValue(t *testing.T) {
	for _, c := range []struct {
		set           map[string]any
		size, retries int
	}{
		{nil, 1000, 5},
		{map[string]any{"chunk-size": "", "max-retries": ""}, 1000, 0},
		{map[string]any{"chunk-size": "7", "max-retries": "2"}, 7, 2},
	} {
		size, retries := chunkOptions(product.Input(t, "archive", nil, c.set))
		if size != c.size || retries != c.retries {
			t.Errorf("%v: %d %d", c.set, size, retries)
		}
	}
}

func TestValidate(t *testing.T) {
	var status int
	var body any
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path != "/gmail/v1/users/me/profile" || h.Auth != "Bearer at-old" {
			t.Errorf("validate called %s with %q", h.Path, h.Auth)
		}
		googletest.WriteJSON(w, status, body)
	})
	run := host.NewRunContext(storedCreds(1), "acme", fake.Ctx())
	status, body = 200, map[string]any{"emailAddress": "me@example.com"}
	if v, err := New().Profile.Validate(fake.Ctx(), run); err != nil || !v.Valid || v.Info != "me@example.com" {
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
	status, body = 400, map[string]any{"error": "invalid_grant"}
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
	out := auth.RedactForRemote(reg, "gmail", creds)
	if _, ok := out["refresh_token"]; ok || out["access_token"] != "at-old" || out["email"] != "me@example.com" {
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
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"email": "me@example.com"})
	})
	var logs []string
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) { logs = append(logs, parts[0].(string)) }
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
	if strings.Join(logs, "|") != "\nRe-authenticating gmail / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

// Ported from tests/plugins/google/gmail/compose-input.test.ts.
func TestAssertSubjectSane(t *testing.T) {
	fail := host.NewRunContext(nil, "", nil).Fail
	if err := assertSubjectSane("Weekly invoice reminder", fail); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("x", subjectMaxLength+1)
	wantErr(t, assertSubjectSane(long, fail), clierr.InvalidParams, "Subject is absurdly long (501 chars; max 500).",
		"Pass a short --subject, or use --subject-file / --spec with a UTF-8 file instead of shell-quoting a long string.")
	// Length is UTF-16 units, as subject.length counts them.
	if err := assertSubjectSane(strings.Repeat("😀", 250), fail); err != nil {
		t.Fatal("500 units is allowed")
	}
	if assertSubjectSane(strings.Repeat("😀", 250)+"x", fail) == nil {
		t.Fatal("501 units is refused")
	}
	for subject, want := range map[string]string{
		"Hello\nEOF":                      "Subject contains newlines (likely shell/heredoc quoting garbage).",
		"Hello\rthere":                    "Subject contains newlines (likely shell/heredoc quoting garbage).",
		"Hello <<EOF":                     "Subject contains a heredoc marker (<<). Refusing to create a garbage draft.",
		"Report EOF":                      `Subject contains shell crumb "EOF". Refusing to create a garbage draft.`,
		"oops agentio gmail draft --to x": `Subject contains shell crumb "agentio gmail". Refusing to create a garbage draft.`,
		"AGENTIO\u00a0GMAIL":              `Subject contains shell crumb "agentio gmail". Refusing to create a garbage draft.`,
	} {
		if ce := googletest.CliErr(t, assertSubjectSane(subject, fail)); ce.Code != clierr.InvalidParams || ce.Message != want {
			t.Errorf("%q: %q", subject, ce.Message)
		}
	}
	// "EOF" inside a word is not a crumb; "agentiogmail" has no space.
	for _, ok := range []string{"GEOFF's report", "EOFs", "agentiogmail"} {
		if err := assertSubjectSane(ok, fail); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
}

func tempFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestComposeFilesAndSpec(t *testing.T) {
	dir := t.TempDir()
	fail := host.NewRunContext(nil, "", nil).Fail
	subjectPath := tempFile(t, dir, "subject.txt", "  Café résumé  \n")
	bodyPath := tempFile(t, dir, "body.txt", "Line one\nLine two\n")
	r, err := resolveComposeText(nil, subjectPath, nil, bodyPath, nil, fail)
	if err != nil || r.subject != "Café résumé" || r.body != "Line one\nLine two" || !r.bodyFromFileOrSpec {
		t.Fatalf("%#v %v", r, err)
	}
	// Only one trailing newline goes, CRLF included; a BOM stays, as readFile keeps it.
	crlf := tempFile(t, dir, "crlf.txt", "\ufeffBody\r\n\r\n")
	if r, _ = resolveComposeText(nil, "", nil, crlf, nil, fail); r.body != "\ufeffBody\r\n" {
		t.Fatalf("%q", r.body)
	}
	specPath := tempFile(t, dir, "draft.json", `{"to":"alice@example.com","cc":["bob@example.com"],"subject":"From spec","body":"Spec body","attachments":["./a.pdf"],"html":true}`)
	spec, err := loadComposeSpec(specPath, fail)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(spec.to, ",") != "alice@example.com" || strings.Join(spec.cc, ",") != "bob@example.com" || spec.bcc != nil ||
		*spec.subject != "From spec" || *spec.body != "Spec body" || strings.Join(spec.attachments, ",") != "./a.pdf" || !*spec.html || spec.replyTo != nil {
		t.Fatalf("%#v", spec)
	}
	if r, _ = resolveComposeText(nil, "", nil, "", spec, fail); r.subject != "From spec" || r.body != "Spec body" || !r.bodyFromFileOrSpec {
		t.Fatalf("%#v", r)
	}
	// Flags override the spec; both a flag and its file is refused.
	flagSubject, flagBody, flagWins := "Flag subject", "Flag body", "Flag wins"
	_, err = resolveComposeText(&flagSubject, subjectPath, nil, "", nil, fail)
	wantErr(t, err, clierr.InvalidParams, "Cannot use both --subject and --subject-file", "Prefer --subject-file for agent-written subjects to avoid shell quoting bugs.")
	_, err = resolveComposeText(nil, "", &flagBody, filepath.Join(dir, "missing.txt"), nil, fail)
	wantErr(t, err, clierr.InvalidParams, "Cannot use both --body and --body-file", "Prefer --body-file (or --body - for stdin) instead of shell-quoting the body.")
	s1, b1 := "Spec subject", "Spec body"
	if r, _ = resolveComposeText(&flagWins, "", nil, "", &composeSpec{subject: &s1, body: &b1}, fail); r.subject != "Flag wins" || r.body != "Spec body" {
		t.Fatalf("%#v", r)
	}
	// The guardrail runs on a file subject too.
	bad := tempFile(t, dir, "bad-subject.txt", "Hello\nEOF\nagentio gmail draft")
	if _, err = resolveComposeText(nil, bad, nil, "", nil, fail); googletest.CliErr(t, err).Code != clierr.InvalidParams {
		t.Fatal(err)
	}
	_, err = resolveComposeText(nil, "", nil, "/tmp/does-not-exist-agentio-body.txt", nil, fail)
	wantErr(t, err, clierr.InvalidParams, "Failed to read body file: /tmp/does-not-exist-agentio-body.txt", "Check that the file exists and is readable UTF-8 text")
	_, err = resolveComposeText(nil, dir, nil, "", nil, fail)
	wantErr(t, err, clierr.InvalidParams, "Failed to read subject file: "+dir, "Check that the file exists and is readable UTF-8 text")

	// Spec checks, in Bun's order.
	for content, want := range map[string]string{
		`{"to":"a"`:                         "Invalid JSON in spec file: JSON Parse error: Expected '}'",
		``:                                  "Invalid JSON in spec file: JSON Parse error: Unexpected EOF",
		`[1]`:                               "Spec file must contain a JSON object",
		`null`:                              "Spec file must contain a JSON object",
		`{"attachments":5,"to":5}`:          `Spec field "attachments" must be a string or array of strings`,
		`{"attachment":[1]}`:                `Spec field "attachment" must be a string or array of strings`,
		`{"subject":null}`:                  `Spec field "subject" must be a string`,
		`{"subject":"s","body":1}`:          `Spec field "body" must be a string`,
		`{"html":"yes"}`:                    `Spec field "html" must be a boolean`,
		`{"html":true,"to":[1],"cc":5}`:     `Spec field "to" must be a string or array of strings`,
		`{"to":"a","cc":"b","bcc":{"x":1}}`: `Spec field "bcc" must be a string or array of strings`,
		`{"subject":"s","body":1,"attachments":true}`: `Spec field "attachments" must be a string or array of strings`,
	} {
		_, err := loadComposeSpec(tempFile(t, dir, "s.json", content), fail)
		if ce := googletest.CliErr(t, err); ce.Message != want {
			t.Errorf("%s: %q", content, ce.Message)
		}
	}
	spec, _ = loadComposeSpec(tempFile(t, dir, "s.json", `{"to":"  ","attachments":[],"attachment":["x"],"reply_to":"t1","replyTo":5,"bcc":null}`), fail)
	if spec.to == nil || len(spec.to) != 0 || spec.attachments == nil || len(spec.attachments) != 0 || *spec.replyTo != "t1" || spec.bcc != nil {
		t.Fatalf("%#v", spec)
	}
}

func TestSendOptionsAreBunsParse(t *testing.T) {
	dir := t.TempDir()
	fail := host.NewRunContext(nil, "", nil).Fail
	parse := func(set map[string]any, stdin any) (*sendOptions, error) {
		in := product.Input(t, "send", nil, set)
		in.Stdin = stdin
		return parseSendOptions(in, fail)
	}
	_, err := parse(map[string]any{"subject": "Hi"}, nil)
	wantErr(t, err, clierr.InvalidParams, "--to is required (unless using --reply-to)", "")
	_, err = parse(map[string]any{"to": []string{"a@example.com"}}, nil)
	wantErr(t, err, clierr.InvalidParams, "--subject is required (unless using --reply-to)", "Use --subject, --subject-file, or --spec")
	// A blank stdin is no body; stdin is trimmed; "-" reads stdin.
	_, err = parse(map[string]any{"to": []string{"a@example.com"}, "subject": "Hi"}, " \n\t")
	wantErr(t, err, clierr.InvalidParams, "Body is required. Use --body, --body-file, --spec, or pipe via stdin.", "")
	o, err := parse(map[string]any{"to": []string{"a@example.com"}, "subject": "Hi", "body": "-"}, "\n  piped body \n")
	if err != nil || o.body != "piped body" {
		t.Fatalf("%#v %v", o, err)
	}
	// A body from the spec never falls back to stdin, even when empty.
	specPath := tempFile(t, dir, "spec.json", `{"to":["s@example.com"],"cc":"c@example.com","subject":"S","body":"","html":true,"attachments":["./x.pdf"],"replyTo":""}`)
	_, err = parse(map[string]any{"spec": specPath}, "stdin body")
	wantErr(t, err, clierr.InvalidParams, "Body is required. Use --body, --body-file, --spec, or pipe via stdin.", "")
	specPath = tempFile(t, dir, "spec2.json", `{"to":["s@example.com"],"cc":"c@example.com","subject":"S","body":"B","html":true,"attachments":["dir/x.pdf"]}`)
	o, err = parse(map[string]any{"spec": specPath, "to": []string{"flag@example.com"}, "inline": []string{"logo:./img/logo.png"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(o.to, ",") != "flag@example.com" || strings.Join(o.cc, ",") != "c@example.com" || o.subject != "S" || o.body != "B" || !o.isHTML ||
		len(o.attachments) != 2 || o.attachments[0] != (attachmentFile{path: "dir/x.pdf", filename: "x.pdf"}) ||
		o.attachments[1] != (attachmentFile{path: "./img/logo.png", filename: "logo.png", contentID: "logo"}) {
		t.Fatalf("%#v", o)
	}
	// --reply-to lifts the to/subject requirement.
	if o, err = parse(map[string]any{"reply-to": "t1", "body": "Thanks"}, nil); err != nil || o.replyTo != "t1" || len(o.to) != 0 {
		t.Fatalf("%#v %v", o, err)
	}
	_, err = parse(map[string]any{"reply-to": "t1", "body": "x", "inline": []string{"nocolon.png"}}, nil)
	wantErr(t, err, clierr.InvalidParams, "Invalid inline format: nocolon.png", "Use format: contentId:filepath (e.g., logo:./logo.png)")
	if basename("") != "" || basename("/") != "" || basename("a/b/") != "b" || basename("c") != "c" {
		t.Fatal("basename")
	}
}

// Bun resolveComposeText checks `options.subject !== undefined`: an explicit
// --subject "" or --body "" is given, so it clashes with its file and hides the
// spec's value (an empty body then reads stdin). On a read-only profile these
// input errors come before the refusal, as in Bun.
func TestGivenEmptySubjectOrBodyIsNotAbsent(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", storedCreds(time.Now().Add(24*time.Hour).UnixMilli()), true)
	dir := t.TempDir()
	subjectPath := tempFile(t, dir, "subject.txt", "Subj")
	bodyPath := tempFile(t, dir, "body.txt", "Body")
	specPath := tempFile(t, dir, "spec.json", `{"to":["a@example.com"],"subject":"SpecSubj","body":"SpecBody"}`)
	send := func(set map[string]any, stdin any) error {
		in := product.Input(t, "send", nil, set)
		in.Stdin = stdin
		_, err := product.Exec(context.Background(), t, reg, "send", in)
		return err
	}
	err := send(map[string]any{"to": []string{"a@example.com"}, "subject": "", "subject-file": subjectPath, "body": "x"}, nil)
	wantErr(t, err, clierr.InvalidParams, "Cannot use both --subject and --subject-file", "Prefer --subject-file for agent-written subjects to avoid shell quoting bugs.")
	err = send(map[string]any{"to": []string{"a@example.com"}, "subject": "s", "body": "", "body-file": bodyPath}, nil)
	wantErr(t, err, clierr.InvalidParams, "Cannot use both --body and --body-file", "Prefer --body-file (or --body - for stdin) instead of shell-quoting the body.")
	err = send(map[string]any{"spec": specPath, "subject": ""}, nil)
	wantErr(t, err, clierr.InvalidParams, "--subject is required (unless using --reply-to)", "Use --subject, --subject-file, or --spec")
	err = send(map[string]any{"spec": specPath, "body": ""}, nil)
	wantErr(t, err, clierr.InvalidParams, "Body is required. Use --body, --body-file, --spec, or pipe via stdin.", "")
	fail := host.NewRunContext(nil, "", nil).Fail
	in := product.Input(t, "send", nil, map[string]any{"spec": specPath, "body": ""})
	in.Stdin = "piped"
	if o, err := parseSendOptions(in, fail); err != nil || o.body != "piped" || o.subject != "SpecSubj" {
		t.Fatalf("empty --body with a spec: %#v %v", o, err)
	}
}

// gmailFake answers profile, thread and send/draft calls for the MIME tests.
func gmailFake(t *testing.T, thread map[string]any) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case h.Path == "/gmail/v1/users/me/profile":
			googletest.WriteJSON(w, 200, map[string]any{"emailAddress": "me@example.com"})
		case strings.HasPrefix(h.Path, "/gmail/v1/users/me/threads/"):
			if thread == nil {
				googletest.WriteAPIError(w, 404, "Requested entity was not found.")
				return
			}
			googletest.WriteJSON(w, 200, thread)
		case h.Path == "/gmail/v1/users/me/messages/send":
			googletest.WriteJSON(w, 200, map[string]any{"id": "m-sent", "threadId": "t-sent"})
		case h.Path == "/gmail/v1/users/me/drafts":
			googletest.WriteJSON(w, 200, map[string]any{"id": "r-new", "message": map[string]any{"id": "m-draft"}})
		case strings.HasPrefix(h.Path, "/gmail/v1/users/me/drafts/"):
			if h.Path == "/gmail/v1/users/me/drafts/r-missing" {
				googletest.WriteAPIError(w, 404, "Requested entity was not found.")
				return
			}
			googletest.WriteJSON(w, 200, map[string]any{"id": "r-1"})
		default:
			t.Errorf("unexpected %s %s", h.Method, h.Path)
			w.WriteHeader(500)
		}
	})
}

func TestSendBuildsBunsMessage(t *testing.T) {
	pinBoundaries(t)
	fake := gmailFake(t, nil)
	v, err, _ := runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, map[string]any{
		"to": []string{"a@example.com", "b@example.com"}, "cc": []string{"c@example.com"}, "bcc": []string{"d@example.com"},
		"subject": "Héllo ✓", "body": "Line 1\nLine 2",
	}))
	if err != nil {
		t.Fatal(err)
	}
	hits := fake.Recorded()
	send := hits[len(hits)-1]
	want := "From: me@example.com\r\nTo: a@example.com, b@example.com\r\nCc: c@example.com\r\nBcc: d@example.com\r\n" +
		"Subject: =?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte("Héllo ✓")) + "?=\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\nLine 1\nLine 2"
	if got := rawMessage(t, send.JSON["raw"]); got != want {
		t.Fatalf("raw\n%q\nwant\n%q", got, want)
	}
	if _, ok := send.JSON["threadId"]; ok || send.Method != "POST" {
		t.Fatalf("send %#v", send.JSON)
	}
	// labelIds default to ["SENT"] when the API omits them.
	if render(v) != "Message sent\nID: m-sent\nThread: t-sent" || googletest.JSONText(v) != `{"id":"m-sent","threadId":"t-sent","labelIds":["SENT"]}` {
		t.Fatalf("%q %s", render(v), googletest.JSONText(v))
	}
}

func TestReplyDerivesRecipientSubjectAndThreadingHeaders(t *testing.T) {
	thread := map[string]any{"id": "t1", "messages": []any{
		map[string]any{"id": "m0", "payload": map[string]any{"headers": []any{map[string]any{"name": "Subject", "value": "old"}}}},
		map[string]any{"id": "m1", "payload": map[string]any{"headers": []any{
			map[string]any{"name": "From", "value": "Alice <alice@example.com>"},
			map[string]any{"name": "Reply-To", "value": "list@example.com"},
			map[string]any{"name": "Subject", "value": "Quarterly"},
			map[string]any{"name": "Message-ID", "value": "<abc@mail.example.com>"},
		}}},
	}}
	fake := gmailFake(t, thread)
	v, err, _ := runDirect(t, fake.Ctx(), "draft", product.Input(t, "draft", nil, map[string]any{"reply-to": "t1", "body": "Thanks", "html": true}))
	if err != nil {
		t.Fatal(err)
	}
	hits := fake.Recorded()
	if hits[0].Path != "/gmail/v1/users/me/profile" || hits[1].Path != "/gmail/v1/users/me/threads/t1" || hits[1].Query.Has("format") {
		t.Fatalf("calls %v", hits)
	}
	draft := hits[2]
	msg, _ := draft.JSON["message"].(map[string]any)
	want := "From: me@example.com\r\nTo: list@example.com\r\nSubject: Re: Quarterly\r\nIn-Reply-To: <abc@mail.example.com>\r\nReferences: <abc@mail.example.com>\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n\r\nThanks"
	if got := rawMessage(t, msg["raw"]); got != want || msg["threadId"] != "t1" {
		t.Fatalf("raw %q thread %v", got, msg["threadId"])
	}
	if render(v) != "Draft created\nDraft ID: r-new\nMessage ID: m-draft" {
		t.Fatalf("%q", render(v))
	}
	// A "Re:" subject is kept, an absent one reads (no subject), and explicit
	// flags win over the thread.
	thread["messages"] = []any{map[string]any{"payload": map[string]any{"headers": []any{map[string]any{"name": "From", "value": "b@example.com"}}}}}
	if _, err, _ = runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, map[string]any{"reply-to": "t1", "body": "x"})); err != nil {
		t.Fatal(err)
	}
	hits = fake.Recorded()
	if got := rawMessage(t, hits[len(hits)-1].JSON["raw"]); !strings.Contains(got, "To: b@example.com\r\nSubject: Re: (no subject)\r\nContent-Type") {
		t.Fatalf("%q", got)
	}
	if _, err, _ = runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, map[string]any{"reply-to": "t1", "body": "x", "to": []string{"z@example.com"}, "subject": "Re: kept"})); err != nil {
		t.Fatal(err)
	}
	hits = fake.Recorded()
	if got := rawMessage(t, hits[len(hits)-1].JSON["raw"]); !strings.Contains(got, "To: z@example.com\r\nSubject: Re: kept\r\n") {
		t.Fatalf("%q", got)
	}
	// An empty thread is NOT_FOUND.
	thread["messages"] = []any{}
	_, err, _ = runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, map[string]any{"reply-to": "t1", "body": "x"}))
	wantErr(t, err, clierr.NotFound, "Thread not found: t1", "")
}

func TestDraftUpdateAndMissingThreadAndDraft(t *testing.T) {
	fake := gmailFake(t, nil)
	compose := map[string]any{"to": []string{"a@example.com"}, "subject": "S", "body": "B"}
	v, err, _ := runDirect(t, fake.Ctx(), "draft", product.Input(t, "draft", map[string]any{"draft-id": "r-1"}, compose))
	hits := fake.Recorded()
	if err != nil || hits[len(hits)-1].Method != "PUT" || hits[len(hits)-1].Path != "/gmail/v1/users/me/drafts/r-1" || render(v) != "Draft updated\nDraft ID: r-1\nMessage ID: " {
		t.Fatalf("%q %v", render(v), err)
	}
	_, err, _ = runDirect(t, fake.Ctx(), "draft", product.Input(t, "draft", map[string]any{"draft-id": "r-missing"}, compose))
	wantErr(t, err, clierr.NotFound, "Draft not found: r-missing", "Check the draft ID (use the ID returned when the draft was created).")
	// Bun does not catch the thread lookup: its own message, no code.
	v, err, _ = runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, map[string]any{"reply-to": "t-gone", "body": "x"}))
	if v != nil || err == nil || err.Error() != "Requested entity was not found." {
		t.Fatalf("%#v %v", v, err)
	}
	if _, ok := err.(*clierr.Error); ok {
		t.Fatal("an uncaught googleapis error became a CliError")
	}
}

func TestMultipartMessagesMatchBun(t *testing.T) {
	pinBoundaries(t)
	dir := t.TempDir()
	pdf := tempFile(t, dir, "report.PDF", "%PDF-1")
	png := tempFile(t, dir, "chart.png", "\x89PNG")
	noext := tempFile(t, dir, "notes", "n")
	fake := gmailFake(t, nil)
	mixed := "----=_Mixed_1700000000000_abc123xyz"
	related := "----=_Related_1700000000000_abc123xyz"
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	send := func(set map[string]any) string {
		t.Helper()
		base := map[string]any{"to": []string{"a@example.com"}, "subject": "S", "body": "<p>Hi</p>", "html": true}
		for k, v := range set {
			base[k] = v
		}
		if _, err, _ := runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, base)); err != nil {
			t.Fatal(err)
		}
		hits := fake.Recorded()
		return rawMessage(t, hits[len(hits)-1].JSON["raw"])
	}
	head := "From: me@example.com\r\nTo: a@example.com\r\nSubject: S\r\nMIME-Version: 1.0\r\n"
	got := send(map[string]any{"attachment": []string{pdf, noext}})
	want := head + `Content-Type: multipart/mixed; boundary="` + mixed + "\"\r\n\r\n--" + mixed + "\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi</p>\r\n" +
		"--" + mixed + "\r\nContent-Type: application/pdf; name=\"report.PDF\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"report.PDF\"\r\n\r\n" + b64("%PDF-1") + "\r\n" +
		"--" + mixed + "\r\nContent-Type: application/octet-stream; name=\"notes\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"notes\"\r\n\r\n" + b64("n") + "\r\n" +
		"--" + mixed + "--"
	if got != want {
		t.Fatalf("mixed\n%q\nwant\n%q", got, want)
	}
	inlinePart := "--" + related + "\r\nContent-Type: image/png; name=\"chart.png\"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <chart1>\r\nContent-Disposition: inline; filename=\"chart.png\"\r\n\r\n" + b64("\x89PNG") + "\r\n"
	got = send(map[string]any{"inline": []string{"chart1:" + png}})
	want = head + `Content-Type: multipart/related; boundary="` + related + "\"\r\n\r\n--" + related + "\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi</p>\r\n" +
		inlinePart + "--" + related + "--"
	if got != want {
		t.Fatalf("related\n%q\nwant\n%q", got, want)
	}
	got = send(map[string]any{"inline": []string{"chart1:" + png}, "attachment": []string{pdf}})
	want = head + `Content-Type: multipart/mixed; boundary="` + mixed + "\"\r\n\r\n--" + mixed + "\r\n" +
		`Content-Type: multipart/related; boundary="` + related + "\"\r\n\r\n--" + related + "\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi</p>\r\n" +
		inlinePart + "--" + related + "--\r\n" +
		"--" + mixed + "\r\nContent-Type: application/pdf; name=\"report.PDF\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"report.PDF\"\r\n\r\n" + b64("%PDF-1") + "\r\n" +
		"--" + mixed + "--"
	if got != want {
		t.Fatalf("both\n%q\nwant\n%q", got, want)
	}
	// A missing file or a directory is NOT_FOUND before anything is sent.
	n := len(fake.Recorded())
	for _, path := range []string{filepath.Join(dir, "nope.pdf"), dir} {
		_, err, _ := runDirect(t, fake.Ctx(), "send", product.Input(t, "send", nil, map[string]any{"to": []string{"a@example.com"}, "subject": "S", "body": "B", "attachment": []string{path}}))
		wantErr(t, err, clierr.NotFound, "Attachment not found: "+path, "")
	}
	for _, h := range fake.Recorded()[n:] {
		if h.Path == "/gmail/v1/users/me/messages/send" {
			t.Fatal("a message with a missing attachment was sent")
		}
	}
}

func TestListAndSearchSendBunsQueries(t *testing.T) {
	var pages int
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case h.Path == "/gmail/v1/users/me/messages":
			pages++
			if h.Query.Get("pageToken") == "" {
				googletest.WriteJSON(w, 200, map[string]any{"resultSizeEstimate": 0, "nextPageToken": "p2", "messages": []any{
					map[string]any{"id": "m1", "threadId": "t1"}, map[string]any{"id": "nothread"},
				}})
				return
			}
			googletest.WriteJSON(w, 200, map[string]any{"resultSizeEstimate": 42, "messages": []any{
				map[string]any{"id": "m2", "threadId": "t2"}, map[string]any{"id": "m3", "threadId": "t3"},
			}})
		case strings.HasPrefix(h.Path, "/gmail/v1/users/me/messages/"):
			id := strings.TrimPrefix(h.Path, "/gmail/v1/users/me/messages/")
			googletest.WriteJSON(w, 200, map[string]any{"id": id, "threadId": "t-" + id, "snippet": "snip " + id, "labelIds": []any{"INBOX", "UNREAD"},
				"payload": map[string]any{"headers": []any{
					map[string]any{"name": "From", "value": "Alice <a@example.com>"},
					map[string]any{"name": "To", "value": "b@example.com,  c@example.com "},
					map[string]any{"name": "Subject", "value": ""},
					map[string]any{"name": "Date", "value": "Mon, 1 Jan 2024 10:00:00 +0000"},
				}}})
		default:
			t.Errorf("unexpected %s", h.Path)
		}
	})
	v, err, _ := runDirect(t, fake.Ctx(), "list", product.Input(t, "list", nil, map[string]any{"limit": "2", "query": " is:unread ", "label": []string{"INBOX", "Work"}}))
	if err != nil {
		t.Fatal(err)
	}
	hits := fake.Recorded()
	if q := hits[0].Query; q.Get("q") != "is:unread  label:INBOX label:Work" || q.Get("maxResults") != "2" {
		t.Fatalf("first page %v", q)
	}
	if q := hits[1].Query; q.Get("pageToken") != "p2" || q.Get("maxResults") != "1" {
		t.Fatalf("second page %v", q)
	}
	if q := hits[2].Query; hits[2].Path != "/gmail/v1/users/me/messages/m1" || q.Get("format") != "metadata" || strings.Join(q["metadataHeaders"], ",") != "From,To,Cc,Subject,Date" {
		t.Fatalf("metadata %s %v", hits[2].Path, q)
	}
	want := "Messages (2 of ~42)\n\n" +
		"[1] m1 | thread:t-m1\n    From: Alice <a@example.com>\n    To: b@example.com, c@example.com\n    Date: Mon, 1 Jan 2024 10:00:00 +0000\n    Subject: (no subject)\n    Labels: INBOX, UNREAD\n    > snip m1\n\n" +
		"[2] m2 | thread:t-m2\n    From: Alice <a@example.com>\n    To: b@example.com, c@example.com\n    Date: Mon, 1 Jan 2024 10:00:00 +0000\n    Subject: (no subject)\n    Labels: INBOX, UNREAD\n    > snip m2\n"
	if render(v) != want {
		t.Fatalf("list\n%q\nwant\n%q", render(v), want)
	}
	// Above 100 only ids, no metadata calls; the ids print one per line.
	n := len(fake.Recorded())
	v, err, _ = runDirect(t, fake.Ctx(), "search", product.Input(t, "search", nil, map[string]any{"query": "from:x", "limit": "101", "ids-only": true}))
	if err != nil || render(v) != "m1\nm2\nm3" || len(fake.Recorded()) != n+2 {
		t.Fatalf("%q %v %d", render(v), err, len(fake.Recorded())-n)
	}
	v, _, _ = runDirect(t, fake.Ctx(), "search", product.Input(t, "search", nil, map[string]any{"query": "from:x", "limit": "101"}))
	if !strings.HasPrefix(render(v), "Messages (3 of ~42)\n\n[1] m1 | thread:t1\n\n[2] m2") {
		t.Fatalf("%q", render(v))
	}
	// A NaN or negative limit calls nothing and totals zero.
	n = len(fake.Recorded())
	for _, limit := range []string{"abc", "-5"} {
		v, err, _ = runDirect(t, fake.Ctx(), "list", product.Input(t, "list", nil, map[string]any{"limit": limit}))
		if err != nil || render(v) != "Messages (0 of ~0)\n" {
			t.Fatalf("%s: %q %v", limit, render(v), err)
		}
	}
	if len(fake.Recorded()) != n {
		t.Fatal("a NaN limit called the API")
	}
	_, err, _ = runDirect(t, fake.Ctx(), "search", product.Input(t, "search", nil, nil))
	wantErr(t, err, clierr.InvalidParams, "required option '--query <query>' not specified", "")
}

func b64url(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func TestGetReadsTheBodyAndAttachmentsLikeBun(t *testing.T) {
	msg := map[string]any{
		"id": "m1", "threadId": "t1", "labelIds": []any{"INBOX"}, "raw": b64url("From: x\r\n\r\nraw ✓"),
		"payload": map[string]any{
			"mimeType": "multipart/mixed",
			"headers": []any{
				map[string]any{"name": "from", "value": "a@example.com"},
				map[string]any{"name": "CC", "value": "c@example.com, d@example.com"},
				map[string]any{"name": "Subject", "value": "Hello"},
				map[string]any{"name": "Date", "value": "today"},
			},
			"parts": []any{
				map[string]any{"mimeType": "multipart/alternative", "parts": []any{
					map[string]any{"mimeType": "text/plain", "body": map[string]any{"data": ""}},
					map[string]any{"mimeType": "text/html", "body": map[string]any{"data": b64url("<b>hi</b>")}},
					map[string]any{"mimeType": "text/plain", "body": map[string]any{"data": b64url("plain ✓")}},
				}},
				map[string]any{"mimeType": "application/pdf", "filename": "a.pdf", "body": map[string]any{"attachmentId": "att-1", "size": 2048}},
				map[string]any{"filename": "b.bin", "body": map[string]any{"attachmentId": "att-2"}},
				map[string]any{"filename": "", "body": map[string]any{"attachmentId": "att-3"}},
			},
		},
	}
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/gmail/v1/users/me/messages/gone" {
			googletest.WriteAPIError(w, 404, "Requested entity was not found.")
			return
		}
		if h.Path == "/gmail/v1/users/me/messages/boom" {
			googletest.WriteAPIError(w, 400, "Invalid id value")
			return
		}
		googletest.WriteJSON(w, 200, msg)
	})
	v, err, _ := runDirect(t, fake.Ctx(), "get", product.Input(t, "get", map[string]any{"message-id": "m1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if q := fake.Recorded()[0].Query; q.Get("format") != "full" {
		t.Fatalf("%v", q)
	}
	want := "ID: m1\nThread: t1\nFrom: a@example.com\nCC: c@example.com, d@example.com\nDate: today\nSubject: Hello\nLabels: INBOX\n" +
		"Attachments: 2\n  - a.pdf (2 KB) [att-1]\n  - b.bin (0 B) [att-2]\n---\nplain ✓"
	if render(v) != want {
		t.Fatalf("get\n%q\nwant\n%q", render(v), want)
	}
	// Bun's { ...message, body } key order.
	if googletest.JSONText(v) != `{"id":"m1","threadId":"t1","subject":"Hello","from":"a@example.com","to":[],"cc":["c@example.com","d@example.com"],"date":"today","snippet":"","labels":["INBOX"],"attachments":[{"id":"att-1","filename":"a.pdf","mimeType":"application/pdf","size":2048},{"id":"att-2","filename":"b.bin","mimeType":"application/octet-stream","size":0}],"body":"plain ✓"}` {
		t.Fatalf("%s", googletest.JSONText(v))
	}
	v, _, _ = runDirect(t, fake.Ctx(), "get", product.Input(t, "get", map[string]any{"message-id": "m1"}, map[string]any{"format": "html", "body-only": true}))
	if v != "<b>hi</b>" {
		t.Fatalf("%#v", v)
	}
	v, _, _ = runDirect(t, fake.Ctx(), "get", product.Input(t, "get", map[string]any{"message-id": "m1"}, map[string]any{"format": "raw", "body-only": true}))
	if v != "From: x\r\n\r\nraw ✓" || fake.Recorded()[2].Query.Get("format") != "raw" {
		t.Fatalf("%#v", v)
	}
	_, err, _ = runDirect(t, fake.Ctx(), "get", product.Input(t, "get", map[string]any{"message-id": "gone"}, nil))
	wantErr(t, err, clierr.NotFound, "Message not found: gone", "")
	v, err, _ = runDirect(t, fake.Ctx(), "get", product.Input(t, "get", map[string]any{"message-id": "boom"}, nil))
	wantErr(t, err, clierr.APIError, "Gmail API error: Invalid id value", "")
	if v != nil {
		t.Fatal("a failed get returned a value")
	}
}

func TestAttachmentDownloadsLikeBun(t *testing.T) {
	msg := map[string]any{"id": "m1", "payload": map[string]any{"parts": []any{
		map[string]any{"filename": "a.txt", "mimeType": "text/plain", "body": map[string]any{"attachmentId": "A"}},
		map[string]any{"filename": "b.txt", "mimeType": "text/plain", "body": map[string]any{"attachmentId": "B"}},
		map[string]any{"filename": "empty.txt", "body": map[string]any{"attachmentId": "E"}},
	}}}
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/gmail/v1/users/me/messages/m1":
			googletest.WriteJSON(w, 200, msg)
		case "/gmail/v1/users/me/messages/plain":
			googletest.WriteJSON(w, 200, map[string]any{"id": "plain", "payload": map[string]any{"mimeType": "text/plain"}})
		case "/gmail/v1/users/me/messages/m1/attachments/A":
			googletest.WriteJSON(w, 200, map[string]any{"data": b64url("alpha")})
		case "/gmail/v1/users/me/messages/m1/attachments/B":
			googletest.WriteJSON(w, 200, map[string]any{"data": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xfb}, 1500))})
		case "/gmail/v1/users/me/messages/m1/attachments/E":
			googletest.WriteJSON(w, 200, map[string]any{})
		default:
			googletest.WriteAPIError(w, 404, "Requested entity was not found.")
		}
	})
	dir := filepath.Join(t.TempDir(), "new", "out")
	v, err, _ := runDirect(t, fake.Ctx(), "attachment", product.Input(t, "attachment", map[string]any{"message-id": "m1"}, map[string]any{"output": dir}))
	if err != nil {
		t.Fatal(err)
	}
	want := "Downloading 2 attachment(s)...\n\nDownloaded: a.txt\n  Path: " + filepath.Join(dir, "a.txt") + "\n  Size: 5 B\n\nDownloaded: b.txt\n  Path: " + filepath.Join(dir, "b.txt") + "\n  Size: 1.5 KB\n"
	if render(v) != want {
		t.Fatalf("%q\nwant %q", render(v), want)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "alpha" {
		t.Fatalf("%q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "b.txt")); len(b) != 1500 || b[0] != 0xfb {
		t.Fatal("b.txt")
	}
	if _, err := os.Stat(filepath.Join(dir, "empty.txt")); err == nil {
		t.Fatal("an attachment without data was written")
	}
	v, _, _ = runDirect(t, fake.Ctx(), "attachment", product.Input(t, "attachment", map[string]any{"message-id": "m1"}, map[string]any{"output": dir, "name": "b.txt"}))
	if render(v) != "Downloaded: b.txt\n  Path: "+filepath.Join(dir, "b.txt")+"\n  Size: 1.5 KB" {
		t.Fatalf("%q", render(v))
	}
	_, err, _ = runDirect(t, fake.Ctx(), "attachment", product.Input(t, "attachment", map[string]any{"message-id": "m1"}, map[string]any{"output": dir, "name": "zzz"}))
	wantErr(t, err, clierr.NotFound, "Attachment not found: zzz", "")
	v, _, _ = runDirect(t, fake.Ctx(), "attachment", product.Input(t, "attachment", map[string]any{"message-id": "plain"}, map[string]any{"output": dir}))
	if render(v) != "No attachments found" {
		t.Fatalf("%q", render(v))
	}
	_, err, _ = runDirect(t, fake.Ctx(), "attachment", product.Input(t, "attachment", map[string]any{"message-id": "gone"}, map[string]any{"output": dir}))
	wantErr(t, err, clierr.NotFound, "Message not found: gone", "")
}

func labelsFake(t *testing.T, extra func(w http.ResponseWriter, h googletest.Hit) bool) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if extra != nil && extra(w, h) {
			return
		}
		if h.Path == "/gmail/v1/users/me/labels" && h.Method == "GET" {
			googletest.WriteJSON(w, 200, map[string]any{"labels": []any{
				map[string]any{"id": "Label_2", "name": "zeta", "type": "user"},
				map[string]any{"id": "INBOX", "name": "INBOX", "type": "system", "messageListVisibility": "hide"},
				map[string]any{"id": "Label_1", "name": "Auto/Receipts", "type": "user", "labelListVisibility": "labelShow"},
				map[string]any{"id": "Label_3", "name": "auto", "type": "user"},
				map[string]any{"id": "UNREAD", "name": "UNREAD", "type": "system"},
			}})
			return
		}
		t.Errorf("unexpected %s %s", h.Method, h.Path)
		w.WriteHeader(500)
	})
}

func TestLabelsCommands(t *testing.T) {
	fake := labelsFake(t, func(w http.ResponseWriter, h googletest.Hit) bool {
		switch {
		case h.Method == "POST" && h.Path == "/gmail/v1/users/me/labels":
			googletest.WriteJSON(w, 200, map[string]any{"id": "Label_9", "name": h.JSON["name"], "type": "user"})
		case h.Method == "DELETE" && h.Path == "/gmail/v1/users/me/labels/Label_1":
			w.WriteHeader(204)
		case h.Method == "PATCH" && h.Path == "/gmail/v1/users/me/labels/Label_3":
			googletest.WriteJSON(w, 200, map[string]any{"id": "Label_3", "name": h.JSON["name"], "type": "user"})
		default:
			return false
		}
		return true
	})
	v, err, _ := runDirect(t, fake.Ctx(), "labels list", product.Input(t, "labels list", nil, nil))
	want := "NAME           TYPE    ID\nINBOX          system  INBOX\nUNREAD         system  UNREAD\nauto           user    Label_3\nAuto/Receipts  user    Label_1\nzeta           user    Label_2\n\n5 label(s)"
	if err != nil || render(v) != want {
		t.Fatalf("%q\nwant %q", render(v), want)
	}
	if !strings.HasPrefix(googletest.JSONText(v), `[{"id":"INBOX","name":"INBOX","type":"system","messageListVisibility":"hide"},`) {
		t.Fatalf("%s", googletest.JSONText(v))
	}
	if render(labelList{}) != "No labels found" {
		t.Fatal("empty list")
	}
	v, err, _ = runDirect(t, fake.Ctx(), "labels create", product.Input(t, "labels create", map[string]any{"name": "work/acme"}, nil))
	create := fake.Recorded()[1]
	if err != nil || googletest.JSONText(create.JSON) != `{"labelListVisibility":"labelShow","messageListVisibility":"show","name":"work/acme"}` || render(v) != "Created label: work/acme\nID: Label_9" {
		t.Fatalf("%s %q %v", googletest.JSONText(create.JSON), render(v), err)
	}
	// By name without regard to case; system labels refused.
	v, err, _ = runDirect(t, fake.Ctx(), "labels delete", product.Input(t, "labels delete", map[string]any{"name-or-id": "auto/receipts"}, nil))
	if err != nil || render(v) != "Deleted label: Auto/Receipts (Label_1)" {
		t.Fatalf("%q %v", render(v), err)
	}
	_, err, _ = runDirect(t, fake.Ctx(), "labels delete", product.Input(t, "labels delete", map[string]any{"name-or-id": "inbox"}, nil))
	wantErr(t, err, clierr.InvalidParams, "Cannot delete system label: INBOX", "")
	_, err, _ = runDirect(t, fake.Ctx(), "labels rename", product.Input(t, "labels rename", map[string]any{"old": "UNREAD", "new": "x"}, nil))
	wantErr(t, err, clierr.InvalidParams, "Cannot rename system label: UNREAD", "")
	_, err, _ = runDirect(t, fake.Ctx(), "labels delete", product.Input(t, "labels delete", map[string]any{"name-or-id": "nope"}, nil))
	wantErr(t, err, clierr.NotFound, "Label not found: nope", "")
	v, err, _ = runDirect(t, fake.Ctx(), "labels rename", product.Input(t, "labels rename", map[string]any{"old": "Label_3", "new": "auto/new"}, nil))
	if err != nil || render(v) != "Renamed label: Label_3 -> auto/new\nID: Label_3" {
		t.Fatalf("%q %v", render(v), err)
	}
}

func TestMarkArchiveAndLabelModify(t *testing.T) {
	prevSleep := retrySleep
	retrySleep = func(time.Duration) {}
	t.Cleanup(func() { retrySleep = prevSleep })
	var batchCalls int
	fake := labelsFake(t, func(w http.ResponseWriter, h googletest.Hit) bool {
		switch {
		case strings.HasSuffix(h.Path, "/gone/modify"):
			googletest.WriteAPIError(w, 404, "Requested entity was not found.")
		case strings.HasSuffix(h.Path, "/modify"):
			googletest.WriteJSON(w, 200, map[string]any{"id": "x"})
		case h.Path == "/gmail/v1/users/me/messages/batchModify":
			batchCalls++
			ids, _ := h.JSON["ids"].([]any)
			if ids[0] == "bad1" {
				googletest.WriteAPIError(w, 400, "Invalid ids")
				return true
			}
			if ids[0] == "flaky" && batchCalls == 1 {
				googletest.WriteAPIError(w, 503, "Backend Error")
				return true
			}
			w.WriteHeader(204)
		case strings.HasPrefix(h.Path, "/gmail/v1/users/me/threads/"):
			id := strings.TrimPrefix(h.Path, "/gmail/v1/users/me/threads/")
			switch id {
			case "tgone":
				googletest.WriteAPIError(w, 404, "Requested entity was not found.")
			case "t1":
				googletest.WriteJSON(w, 200, map[string]any{"messages": []any{map[string]any{"id": "m1"}, map[string]any{"id": "m2"}}})
			default:
				googletest.WriteJSON(w, 200, map[string]any{"messages": []any{map[string]any{"id": "m-" + id}}})
			}
		default:
			return false
		}
		return true
	})
	v, err, _ := runDirect(t, fake.Ctx(), "mark", product.Input(t, "mark", map[string]any{"message-id": []string{"a", "b"}}, map[string]any{"unread": true}))
	hits := fake.Recorded()
	if err != nil || render(v) != "Marked a as unread\nMarked b as unread" || googletest.JSONText(hits[0].JSON) != `{"addLabelIds":["UNREAD"]}` || hits[0].Path != "/gmail/v1/users/me/messages/a/modify" {
		t.Fatalf("%q %v %s", render(v), err, googletest.JSONText(hits[0].JSON))
	}
	// The marks before a failure are printed, then the error.
	v, err, _ = runDirect(t, fake.Ctx(), "mark", product.Input(t, "mark", map[string]any{"message-id": []string{"a", "gone", "c"}}, map[string]any{"read": true}))
	wantErr(t, err, clierr.NotFound, "Message not found: gone", "")
	if render(v) != "Marked a as read" {
		t.Fatalf("%q", render(v))
	}
	_, err, _ = runDirect(t, fake.Ctx(), "mark", product.Input(t, "mark", map[string]any{"message-id": []string{"a"}}, map[string]any{"read": true, "unread": true}))
	wantErr(t, err, clierr.InvalidParams, "Cannot specify both --read and --unread", "")

	// archive: one id is a modify; ids from stdin batch in chunks.
	v, err, _ = runDirect(t, fake.Ctx(), "archive", product.Input(t, "archive", map[string]any{"message-id": []string{"one"}}, nil))
	if err != nil || render(v) != "Archived: one" {
		t.Fatalf("%q %v", render(v), err)
	}
	_, err, _ = runDirect(t, fake.Ctx(), "archive", product.Input(t, "archive", map[string]any{"message-id": []string{"gone"}}, nil))
	wantErr(t, err, clierr.NotFound, "Message not found: gone", "")
	in := product.Input(t, "archive", nil, map[string]any{"chunk-size": "2", "max-retries": "1"})
	in.Stdin = "flaky x\n  y\u00a0z\tw\n"
	batchCalls = 0
	n := len(fake.Recorded())
	v, err, logs := runDirect(t, fake.Ctx(), "archive", in)
	calls := fake.Recorded()[n:]
	if err != nil || render(v) != "archive: 5/5 succeeded across 3 chunk(s)" || len(calls) != 4 {
		t.Fatalf("%q %v %d", render(v), err, len(calls))
	}
	if googletest.JSONText(calls[0].JSON) != `{"ids":["flaky","x"],"removeLabelIds":["INBOX"]}` || googletest.JSONText(calls[3].JSON) != `{"ids":["w"],"removeLabelIds":["INBOX"]}` {
		t.Fatalf("%s / %s", googletest.JSONText(calls[0].JSON), googletest.JSONText(calls[3].JSON))
	}
	if len(logs) != 3 || !strings.HasPrefix(logs[0], "[archive] chunk 1/3 (2 ids) ok in ") || !strings.HasSuffix(logs[0], "ms") {
		t.Fatalf("%q", logs)
	}
	// A failed chunk is reported, the rest still run, and the exit status is 5
	// with no error line.
	in.Options["max-retries"] = "abc"
	in.Stdin = "bad1 bad2 ok1 ok2 ok3 ok4 ok5 ok6 ok7"
	in.Options["chunk-size"] = "0"
	v, err, logs = runDirect(t, fake.Ctx(), "archive", in)
	if exit, ok := err.(*plugins.ExitStatus); !ok || exit.Code != 5 {
		t.Fatalf("%#v", err)
	}
	if render(v) != "archive: 0/9 succeeded across 1 chunk(s)\nFailed chunks: 1\n  - bad1..ok7 (9 ids): Invalid ids" || !strings.Contains(logs[0], "FAILED in ") || !strings.HasSuffix(logs[0], ": Invalid ids") {
		t.Fatalf("%q %q", render(v), logs)
	}
	if googletest.JSONText(v) != `{"totalIds":9,"ok":0,"failed":[{"ids":["bad1","bad2","ok1","ok2","ok3","ok4","ok5","ok6","ok7"],"reason":"Invalid ids"}],"chunks":1}` {
		t.Fatalf("%s", googletest.JSONText(v))
	}

	// label: names resolve to ids; one id is a modify printed with the names.
	n = len(fake.Recorded())
	v, err, _ = runDirect(t, fake.Ctx(), "label", product.Input(t, "label", map[string]any{"id": []string{"m9"}}, map[string]any{"apply": []string{"AUTO/receipts", "Label_2"}, "remove": []string{"inbox"}}))
	calls = fake.Recorded()[n:]
	if err != nil || render(v) != "message m9: applied [AUTO/receipts, Label_2]; removed [inbox]" || len(calls) != 3 ||
		googletest.JSONText(calls[2].JSON) != `{"addLabelIds":["Label_1","Label_2"],"removeLabelIds":["INBOX"]}` {
		t.Fatalf("%q %v %d", render(v), err, len(calls))
	}
	_, err, _ = runDirect(t, fake.Ctx(), "label", product.Input(t, "label", map[string]any{"id": []string{"m9"}}, map[string]any{"apply": []string{"missing"}}))
	wantErr(t, err, clierr.NotFound, "Label not found: missing", "")
	// --thread expands (a missing thread skipped) in thread order.
	n = len(fake.Recorded())
	v, err, logs = runDirect(t, fake.Ctx(), "label", product.Input(t, "label", map[string]any{"id": []string{"t1", "tgone", "t3"}}, map[string]any{"remove": []string{"UNREAD"}, "thread": true}))
	calls = fake.Recorded()[n:]
	last := calls[len(calls)-1]
	if err != nil || render(v) != "label: 3/3 succeeded across 1 chunk(s)" || googletest.JSONText(last.JSON) != `{"ids":["m1","m2","m-t3"],"removeLabelIds":["UNREAD"]}` {
		t.Fatalf("%q %v %s", render(v), err, googletest.JSONText(last.JSON))
	}
	if logs[0] != "expanded 3 thread(s) to 3 message(s)" {
		t.Fatalf("%q", logs)
	}
	for _, c := range calls {
		if strings.HasPrefix(c.Path, "/gmail/v1/users/me/threads/") && c.Query.Get("format") != "minimal" {
			t.Fatalf("thread format %v", c.Query)
		}
	}
	v, _, logs = runDirect(t, fake.Ctx(), "label", product.Input(t, "label", map[string]any{"id": []string{"tgone"}}, map[string]any{"apply": []string{"zeta"}, "thread": true}))
	if render(v) != "label: 0 message(s) to modify" || logs[0] != "expanded 1 thread(s) to 0 message(s)" {
		t.Fatalf("%q %q", render(v), logs)
	}
	in = product.Input(t, "label", nil, map[string]any{"apply": []string{"a", "b"}, "remove": []string{"c"}, "thread": true, "dry-run": true, "chunk-size": "2"})
	in.Stdin = "x y z"
	v, _, logs = runDirect(t, fake.Ctx(), "label", in)
	if render(v) != "[dry-run] label\n  ids: 3\n  chunk size: 2\n  chunks: 2\n  add labels: a, b\n  remove labels: c\n  no API calls made" ||
		logs[0] != "would expand 3 thread(s) to messages; chunk count below assumes 1 message/thread" {
		t.Fatalf("%q %q", render(v), logs)
	}
}

func TestDeleteLoopsLogFailuresAndExitFive(t *testing.T) {
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case strings.HasSuffix(h.Path, "/gone"):
			googletest.WriteAPIError(w, 404, "Requested entity was not found.")
		case strings.HasSuffix(h.Path, "/bad"):
			googletest.WriteAPIError(w, 400, "Invalid draft")
		default:
			w.WriteHeader(204)
		}
	})
	v, err, logs := runDirect(t, fake.Ctx(), "draft delete", product.Input(t, "draft delete", map[string]any{"draft-id": []string{"r1", "gone", "bad", "r2"}}, nil))
	if exit, ok := err.(*plugins.ExitStatus); !ok || exit.Code != 5 {
		t.Fatalf("%#v", err)
	}
	if render(v) != "Deleted draft: r1\nDeleted draft: r2" ||
		strings.Join(logs, "|") != "Failed to delete draft gone: Draft not found: gone|Failed to delete draft bad: Failed to delete draft: Invalid draft" {
		t.Fatalf("%q %q", render(v), logs)
	}
	v, err, logs = runDirect(t, fake.Ctx(), "filters delete", product.Input(t, "filters delete", map[string]any{"id": []string{"gone"}}, nil))
	if exit, ok := err.(*plugins.ExitStatus); !ok || exit.Code != 5 || v != nil || strings.Join(logs, "|") != "Failed to delete filter gone: Filter not found: gone" {
		t.Fatalf("%#v %#v %q", v, err, logs)
	}
	v, err, _ = runDirect(t, fake.Ctx(), "filters delete", product.Input(t, "filters delete", map[string]any{"id": []string{"f1", "f2"}}, nil))
	if err != nil || render(v) != "Deleted filter: f1\nDeleted filter: f2" || fake.Recorded()[len(fake.Recorded())-1].Path != "/gmail/v1/users/me/settings/filters/f2" {
		t.Fatalf("%q %v", render(v), err)
	}
}

func TestFiltersCommands(t *testing.T) {
	fake := labelsFake(t, func(w http.ResponseWriter, h googletest.Hit) bool {
		switch {
		case h.Method == "GET" && h.Path == "/gmail/v1/users/me/settings/filters":
			googletest.WriteJSON(w, 200, map[string]any{"filter": []any{
				map[string]any{"id": "f1", "criteria": map[string]any{"from": "a@example.com", "hasAttachment": true, "size": 5000, "sizeComparison": "larger"},
					"action": map[string]any{"addLabelIds": []any{"Label_1", "Label_x"}, "removeLabelIds": []any{"INBOX"}}},
				map[string]any{"id": "filter-long", "criteria": map[string]any{"sizeComparison": "unknown"}, "action": map[string]any{"forward": "f@example.com", "addLabelIds": []any{}}},
			}})
		case h.Method == "GET" && h.Path == "/gmail/v1/users/me/settings/filters/f1":
			googletest.WriteJSON(w, 200, map[string]any{"id": "f1", "criteria": map[string]any{"to": "t@example.com", "subject": "S", "query": "q", "negatedQuery": "nq", "excludeChats": true},
				"action": map[string]any{"addLabelIds": []any{"Label_1"}, "forward": "f@example.com"}})
		case h.Method == "GET" && h.Path == "/gmail/v1/users/me/settings/filters/gone":
			googletest.WriteAPIError(w, 404, "Filter not found")
		case h.Method == "POST" && h.Path == "/gmail/v1/users/me/settings/filters":
			body := map[string]any{"id": "new1"}
			for k, v := range h.JSON {
				body[k] = v
			}
			googletest.WriteJSON(w, 200, body)
		default:
			return false
		}
		return true
	})
	v, err, _ := runDirect(t, fake.Ctx(), "filters list", product.Input(t, "filters list", nil, nil))
	want := "f1           from:a@example.com has:attachment size:larger:5000  ->  +Auto/Receipts +Label_x -INBOX\nfilter-long  (no criteria)  ->  forward:f@example.com\n\n2 filter(s)"
	if err != nil || render(v) != want {
		t.Fatalf("%q\nwant %q", render(v), want)
	}
	if googletest.JSONText(v) != `[{"id":"f1","criteria":{"from":"a@example.com","hasAttachment":true,"size":5000,"sizeComparison":"larger"},"action":{"addLabelIds":["Label_1","Label_x"],"removeLabelIds":["INBOX"]}},{"id":"filter-long","criteria":{},"action":{"forward":"f@example.com"}}]` {
		t.Fatalf("%s", googletest.JSONText(v))
	}
	v, err, _ = runDirect(t, fake.Ctx(), "filters get", product.Input(t, "filters get", map[string]any{"id": "f1"}, nil))
	want = "ID:       f1\nCriteria:\n  To:             t@example.com\n  Subject:        S\n  Query:          q\n  Negated query:  nq\n  Exclude chats:  yes\nAction:\n  Apply labels:   Auto/Receipts\n  Forward:        f@example.com"
	if err != nil || render(v) != want {
		t.Fatalf("%q\nwant %q", render(v), want)
	}
	_, err, _ = runDirect(t, fake.Ctx(), "filters get", product.Input(t, "filters get", map[string]any{"id": "gone"}, nil))
	wantErr(t, err, clierr.NotFound, "Filter not found: gone", "")

	for set, message := range map[*map[string]any]string{
		{"size": "5"}:                                 "--size and --size-comparison must be set together",
		{"size-comparison": "larger"}:                 "--size and --size-comparison must be set together",
		{"size": "5", "size-comparison": "bigger"}:    `--size-comparison must be "larger" or "smaller"`,
		{"size": "abc", "size-comparison": "smaller"}: "--size must be a non-negative integer (bytes)",
		{"size": "-1", "size-comparison": "smaller"}:  "--size must be a non-negative integer (bytes)",
		{"from": "a@example.com"}:                     "At least one action is required",
		// Bun checks `!== undefined`: a given "" is set.
		{"size": "", "size-comparison": "larger"}: "--size must be a non-negative integer (bytes)",
		{"size": "5", "size-comparison": ""}:      `--size-comparison must be "larger" or "smaller"`,
		{"size": "", "from": "a@example.com"}:     "--size and --size-comparison must be set together",
		{"size": "", "size-comparison": ""}:       `--size-comparison must be "larger" or "smaller"`,
	} {
		_, err, _ := runDirect(t, fake.Ctx(), "filters create", product.Input(t, "filters create", nil, *set))
		if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != message {
			t.Errorf("%v: %q", *set, ce.Message)
		}
	}
	// A zero size is still sent, as Bun's { size: 0 } is.
	n := len(fake.Recorded())
	v, err, _ = runDirect(t, fake.Ctx(), "filters create", product.Input(t, "filters create", nil, map[string]any{
		"size": "0", "size-comparison": "smaller", "has-attachment": true, "apply": []string{"zeta"}, "remove": []string{"INBOX"}, "forward": "f@example.com",
	}))
	calls := fake.Recorded()[n:]
	var create googletest.Hit
	for _, c := range calls {
		if c.Method == "POST" {
			create = c
		}
	}
	if err != nil || googletest.JSONText(create.JSON) != `{"action":{"addLabelIds":["Label_2"],"forward":"f@example.com","removeLabelIds":["INBOX"]},"criteria":{"hasAttachment":true,"size":0,"sizeComparison":"smaller"}}` {
		t.Fatalf("%s %v", googletest.JSONText(create.JSON), err)
	}
	// Bun keeps any numeric size from the API, 0 included.
	if render(v) != "Created filter: new1\n  has:attachment size:smaller:0  ->  +zeta -INBOX forward:f@example.com" {
		t.Fatalf("%q", render(v))
	}
}

func TestExportBuildsBunsHTMLAndRunsChrome(t *testing.T) {
	m := &message{Subject: `A <b> & "q"`, From: "x@example.com", To: []string{"a@example.com", "b@example.com"}, Date: "today"}
	body := "<p>fragment</p>"
	m.Body = &body
	header := "\n<div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px 20px; margin-bottom: 16px; border-bottom: 1px solid #ddd; background: #f9f9f9;\">\n" +
		"  <div style=\"font-size: 1.3em; font-weight: 600; margin-bottom: 12px;\">A &lt;b&gt; &amp; &quot;q&quot;</div>\n" +
		"  <div style=\"margin: 4px 0; font-size: 0.9em;\"><strong>From:</strong> x@example.com</div>\n" +
		"  <div style=\"margin: 4px 0; font-size: 0.9em;\"><strong>To:</strong> a@example.com, b@example.com</div>\n" +
		"  <div style=\"margin: 4px 0; font-size: 0.9em;\"><strong>Date:</strong> today</div>\n</div>"
	if got := exportHTML(m); got != "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body>\n"+header+"\n<div style=\"padding: 0 20px;\">"+body+"</div>\n</body>\n</html>" {
		t.Fatalf("fragment %q", got)
	}
	body = "  <!DOCTYPE html><html><BODY class=\"x\">content<body>again</body></html>"
	if got := exportHTML(m); got != "  <!DOCTYPE html><html><BODY class=\"x\">"+header+"content<body>again</body></html>" {
		t.Fatalf("document %q", got)
	}
	body = "<html>no body tag</html>"
	if got := exportHTML(m); got != body {
		t.Fatalf("no body %q", got)
	}

	prevFind, prevRun := findChrome, runChrome
	t.Cleanup(func() { findChrome, runChrome = prevFind, prevRun })
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"id": "m1", "payload": map[string]any{"mimeType": "text/html", "body": map[string]any{"data": b64url("<i>x</i>")}}})
	})
	findChrome = func() string { return "" }
	_, err, _ := runDirect(t, fake.Ctx(), "export", product.Input(t, "export", map[string]any{"message-id": "m1"}, nil))
	wantErr(t, err, clierr.NotFound, "Chrome/Chromium not found", "Install Google Chrome, Chromium, or Microsoft Edge")
	var argv []string
	var html string
	findChrome = func() string { return "/fake/chrome" }
	runChrome = func(path string, a []string) (int, string, error) {
		argv = a
		b, _ := os.ReadFile(a[len(a)-1])
		html = string(b)
		return 0, "", nil
	}
	v, err, logs := runDirect(t, fake.Ctx(), "export", product.Input(t, "export", map[string]any{"message-id": "m1"}, map[string]any{"output": "out/x.pdf"}))
	cwd, _ := os.Getwd()
	if err != nil || render(v) != "Exported to out/x.pdf" || strings.Join(logs, "|") != "Generating PDF..." {
		t.Fatalf("%q %v %q", render(v), err, logs)
	}
	if strings.Join(argv[:4], " ") != "--headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="+filepath.Join(cwd, "out/x.pdf") ||
		!strings.Contains(html, "<i>x</i>") || !strings.HasPrefix(filepath.Base(argv[4]), "agentio-email-") {
		t.Fatalf("%q", argv)
	}
	if _, err := os.Stat(argv[4]); err == nil {
		t.Fatal("the temporary HTML was left behind")
	}
	runChrome = func(string, []string) (int, string, error) { return 1, "boom\n", nil }
	_, err, _ = runDirect(t, fake.Ctx(), "export", product.Input(t, "export", map[string]any{"message-id": "m1"}, map[string]any{"output": "/abs/x.pdf"}))
	wantErr(t, err, clierr.APIError, "Chrome failed: boom\n", "")
}

// Commander treats --query "" as present: Bun sends `q.trim() || undefined`,
// so an empty query lists without q.
func TestEmptySearchQueryListsWithoutQ(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(time.Now().Add(time.Hour).UnixMilli()), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"messages": []any{}, "resultSizeEstimate": 0})
	})
	if _, err := product.Exec(fake.Ctx(), t, reg, "search", product.Input(t, "search", nil, map[string]any{"query": ""})); err != nil {
		t.Fatal(err)
	}
	if q, ok := fake.Recorded()[0].Query["q"]; ok || len(fake.Recorded()) == 0 {
		t.Fatalf("q sent: %q", q)
	}
}
