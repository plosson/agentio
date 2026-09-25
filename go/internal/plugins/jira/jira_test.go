package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
	"github.com/plosson/agentio/go/internal/plugins/atlassian/atlassiantest"
	"github.com/plosson/agentio/go/internal/vault"
)

var product = atlassiantest.For(New)

type hit = atlassiantest.Hit

var writeJSON = atlassiantest.WriteJSON

var (
	storedCreds = atlassiantest.StoredCreds
	far         = atlassiantest.Far
)

// The command table is the Bun surface. A renamed flag, a lost default, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	p := New()
	if p.ID != "jira" || p.DisplayName != "JIRA" ||
		p.Description != "Use when interacting with JIRA via the agentio CLI - search issues, comment, transition." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	product.CheckCommands(t, map[string]atlassiantest.Row{
		"projects":    {Flags: "--limit <number>=50", Access: "read"},
		"search":      {Flags: "--jql <query> --project <key> --status <status> --assignee <name> --limit <number>=50", Access: "read"},
		"get":         {Args: "<issue-key>", Access: "read"},
		"comment":     {Args: "<issue-key> [body]", Access: "write", Operation: "add comment", Input: "text"},
		"transitions": {Args: "<issue-key>", Access: "read"},
		"transition":  {Args: "<issue-key> <transition-id>", Access: "write", Operation: "transition issue"},
	})
	// comment reads its body before the profile: the argument, else stdin
	// trimmed; a blank one is the input error.
	comment := product.Spec(t, "comment")
	fail := func(code, message, _ string) error { return errors.New(code + ": " + message) }
	for in, want := range map[*plugins.CommandInput]string{
		{Args: map[string]any{"body": "x"}, Stdin: "ignored"}: "x",
		{Stdin: " piped\n"}: "piped",
	} {
		got, done, err := comment.Prepare(context.Background(), *in, &plugins.PrepareContext{Fail: fail})
		if got != want || done || err != nil {
			t.Fatalf("%#v: %#v %v %v", in, got, done, err)
		}
	}
	if _, _, err := comment.Prepare(context.Background(), plugins.CommandInput{Stdin: " \n"}, &plugins.PrepareContext{Fail: fail}); err == nil ||
		err.Error() != "INVALID_PARAMS: Comment body is required. Provide as argument or pipe via stdin." {
		t.Fatalf("blank body: %v", err)
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Host == "auth.atlassian.com" && h.Path == "/oauth/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
		case h.Host == "api.atlassian.com" && h.Path == "/oauth/token/accessible-resources":
			writeJSON(w, 200, []map[string]any{
				{"id": "c-a", "url": "https://alpha.atlassian.net", "name": "alpha", "scopes": []string{}},
				{"id": "c-b", "url": "https://beta.atlassian.net", "name": "beta", "scopes": []string{}},
			})
		default:
			w.WriteHeader(404)
		}
	})
	var opts plugins.OAuthSetupOptions
	var prompts []string
	sc := atlassiantest.SetupContext()
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	sc.Select = func(message string, choices []plugins.Choice) (int, error) {
		q := message
		for _, c := range choices {
			q += " | " + c.Name + " - " + c.Description
		}
		prompts = append(prompts, q)
		return 1, nil
	}
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if opts.Port != 9999 || opts.ServiceName != "Atlassian" || opts.ExpectedState == "" {
		t.Fatalf("oauth opts %#v", opts)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:9999/callback"))
	q := authURL.Query()
	if authURL.Host != "auth.atlassian.com" || authURL.Path != "/authorize" ||
		q.Get("audience") != "api.atlassian.com" || q.Get("client_id") != atlassian.ClientID ||
		q.Get("scope") != "read:jira-work write:jira-work read:me offline_access" ||
		q.Get("redirect_uri") != "http://localhost:9999/callback" || q.Get("state") != opts.ExpectedState ||
		q.Get("response_type") != "code" || q.Get("prompt") != "consent" {
		t.Fatalf("authorize url %s", authURL)
	}
	secret, _ := obscure.Reveal(atlassian.SecretEnc)
	token := fake.Recorded()[0]
	if token.Body["grant_type"] != "authorization_code" || token.Body["client_id"] != atlassian.ClientID ||
		token.Body["client_secret"] != secret || secret == "" || token.Body["code"] != "code-1" ||
		token.Body["redirect_uri"] != "http://localhost:9999/callback" {
		t.Fatalf("token request %#v", token.Body)
	}
	if len(prompts) != 1 || prompts[0] != "Select a JIRA site: | alpha - https://alpha.atlassian.net | beta - https://beta.atlassian.net" {
		t.Fatalf("prompts %v", prompts)
	}
	// The suggested name is the site hostname, and the host saved it.
	stored := product.LoadCreds(t, "beta.atlassian.net")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,cloudId,expiryDate,refreshToken,siteUrl" {
		t.Fatalf("keys %v", keys)
	}
	if stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" || stored["cloudId"] != "c-b" || stored["siteUrl"] != "https://beta.atlassian.net" {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiryDate"].(json.Number)
	if !ok {
		t.Fatalf("expiryDate is %T, want a JSON number", stored["expiryDate"])
	}
	if n, _ := exp.Int64(); n < before+3600_000 || n > time.Now().UnixMilli()+3600_000 {
		t.Fatalf("expiry %d", n)
	}
	if !strings.Contains(out.String(), "Test with: agentio jira projects") {
		t.Fatal(out.String())
	}
}

func TestSetupFailuresWriteNothing(t *testing.T) {
	product.SetupVault(t)
	sites := []map[string]any{}
	tokenStatus := 200
	atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			if tokenStatus != 200 {
				atlassiantest.WriteRaw(w, tokenStatus, `{"error":"invalid_grant"}`)
				return
			}
			writeJSON(w, 200, map[string]any{"access_token": "a", "refresh_token": "r", "expires_in": 1})
			return
		}
		writeJSON(w, 200, sites)
	})
	sc := atlassiantest.SetupContext()
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	var out bytes.Buffer
	err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out)
	if err == nil || err.Error() != "No accessible Jira sites found. Make sure your app has the correct permissions." {
		t.Fatalf("no sites: %v", err)
	}
	// Two sites and stdin at EOF is Bun's non-TTY interactiveSelect refusal.
	sites = []map[string]any{{"id": "1", "url": "https://a.atlassian.net", "name": "a"}, {"id": "2", "url": "https://b.atlassian.net", "name": "b"}}
	err = host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out)
	if ce := atlassiantest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "Interactive input required but not running in terminal" {
		t.Fatalf("non-tty: %#v", ce)
	}
	tokenStatus = 400
	err = host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out)
	if err == nil || err.Error() != `Failed to exchange code for tokens: {"error":"invalid_grant"}` {
		t.Fatalf("exchange: %v", err)
	}
	c, _ := vault.Load()
	if len(c.Credentials["jira"]) != 0 || out.Len() != 0 {
		t.Fatalf("failed setup wrote %v / %q", c.Credentials["jira"], out.String())
	}
}

// Bun tests/plugins/jira/lifecycle.test.ts: reauthentication returns the
// replacement without persisting it, and keeps fields it does not own.
func TestReauthenticateReturnsTheReplacement(t *testing.T) {
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			writeJSON(w, 200, map[string]any{"access_token": "access-new", "refresh_token": "refresh-new", "expires_in": 60})
			return
		}
		writeJSON(w, 200, []map[string]any{{"id": "cloud-new", "url": "https://new.atlassian.net", "name": "new"}})
	})
	var logs []string
	sc := atlassiantest.SetupContext()
	sc.Log = func(a ...any) { logs = append(logs, a[0].(string)) }
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	creds := storedCreds(10_000)
	got, err := New().Profile.Reauthenticate(context.Background(), creds, "work", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["accessToken"] != "access-new" || got["refreshToken"] != "refresh-new" || got["cloudId"] != "cloud-new" ||
		got["siteUrl"] != "https://new.atlassian.net" || got["legacyField"] != "kept" || len(got) != 6 {
		t.Fatalf("%#v", got)
	}
	if creds["accessToken"] != "at-old" || creds["cloudId"] != "cloud-1" {
		t.Fatalf("input mutated: %#v", creds)
	}
	if len(fake.Recorded()) != 2 || len(logs) != 2 || logs[0] != "\nRe-authenticating jira / work..." || logs[1] != "  Done (https://new.atlassian.net)" {
		t.Fatalf("logs %q", logs)
	}
}

// Bun lifecycle.test.ts: applies and the expiry buffer.
func TestLifecycleFollowsBun(t *testing.T) {
	spec := New().Profile.Refresh
	creds := storedCreds(10_000)
	if !spec.Applies(creds) || spec.Applies(map[string]any{"accessToken": "static"}) || spec.Applies(nil) ||
		spec.Applies(map[string]any{"refreshToken": ""}) || spec.Applies(map[string]any{"refreshToken": 5}) {
		t.Fatal("applies")
	}
	if !spec.IsStale(creds, 4_000, 6_000) || spec.IsStale(creds, 3_999, 6_000) {
		t.Fatal("buffer edge")
	}
	delete(creds, "expiryDate")
	if spec.IsStale(creds, 4_000, 6_000) {
		t.Fatal("missing expiry is never stale")
	}
	if !spec.IsStale(map[string]any{"expiryDate": nil}, 0, 0) || !spec.IsStale(map[string]any{"expiryDate": json.Number("10000")}, 4_000, 6_000) {
		t.Fatal("null coerces to 0; json.Number is read")
	}
	if len(spec.SecretFields) != 1 || spec.SecretFields[0] != "refreshToken" {
		t.Fatalf("%v", spec.SecretFields)
	}
}

// Bun lifecycle.test.ts: redacts refresh material through the host API.
func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(10_000)
	out := auth.RedactForRemote(reg, "jira", creds)
	if _, ok := out["refreshToken"]; ok || len(out) != 5 {
		t.Fatalf("redacted %#v", out)
	}
	if out["accessToken"] != "at-old" || out["cloudId"] != "cloud-1" || out["siteUrl"] != "https://acme.atlassian.net" || creds["refreshToken"] != "rt-old" {
		t.Fatalf("%#v / %#v", out, creds)
	}
}

func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(time.Now().Add(time.Minute).UnixMilli()), false)
	var mu sync.Mutex
	refreshes := 0
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3600})
			return
		}
		writeJSON(w, 200, map[string]any{"values": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(context.Background(), reg, "jira", "acme", auth.RefreshOptions{})
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
	secret, _ := obscure.Reveal(atlassian.SecretEnc)
	body := fake.Recorded()[0].Body
	if body["grant_type"] != "refresh_token" || body["refresh_token"] != "rt-old" || body["client_id"] != atlassian.ClientID || body["client_secret"] != secret {
		t.Fatalf("refresh request %#v", body)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-rotated" || stored["cloudId"] != "cloud-1" ||
		stored["siteUrl"] != "https://acme.atlassian.net" || stored["legacyField"] != "kept" {
		t.Fatalf("%#v", stored)
	}
	if n, _ := stored["expiryDate"].(json.Number).Int64(); n < time.Now().UnixMilli()+3500_000 {
		t.Fatalf("expiry %v", stored["expiryDate"])
	}
	// The command then calls the API with the refreshed token.
	if _, err := product.Exec(t, reg, "projects", plugins.CommandInput{Options: map[string]any{"limit": "50"}}); err != nil {
		t.Fatal(err)
	}
	if last := fake.Last(); last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestRefreshKeepsTheOldRefreshTokenWhenNoneIsReturned(t *testing.T) {
	atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "", "expires_in": 10})
	})
	got, err := New().Profile.Refresh.Run(context.Background(), storedCreds(1))
	if err != nil {
		t.Fatal(err)
	}
	if got["refreshToken"] != "rt-old" || got["accessToken"] != "at-new" || got["legacyField"] != "kept" {
		t.Fatalf("%#v", got)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(1), false)
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			atlassiantest.WriteRaw(w, 403, `{"error":"invalid_grant"}`)
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := product.Exec(t, reg, "projects", plugins.CommandInput{Options: map[string]any{"limit": "50"}})
	ce := atlassiantest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for jira profile "acme": Failed to refresh token: {"error":"invalid_grant"}` ||
		ce.Suggestion != "Re-authenticate with: agentio jira profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if len(fake.Recorded()) != 1 {
		t.Fatalf("%d requests", len(fake.Recorded()))
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", storedCreds(far()), true)
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"values": []any{}, "transitions": []any{}})
	})
	writes := []struct {
		path, op string
		in       plugins.CommandInput
	}{
		{"transition", "transition issue", plugins.CommandInput{Args: map[string]any{"issue-key": "P-1", "transition-id": "31"}}},
		{"comment", "add comment", plugins.CommandInput{Args: map[string]any{"issue-key": "P-1", "body": "hi"}}},
		{"comment", "add comment", plugins.CommandInput{Args: map[string]any{"issue-key": "P-1"}, Stdin: "piped\n"}},
	}
	for _, w := range writes {
		_, err := product.Exec(t, reg, w.path, w.in)
		ce := atlassiantest.CliErr(t, err)
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+w.op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio jira profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", w.path, ce)
		}
	}
	// Bun checks the comment body first: its input error wins on a read-only profile.
	_, err := product.Exec(t, reg, "comment", plugins.CommandInput{Args: map[string]any{"issue-key": "P-1"}, Stdin: "  \n"})
	if ce := atlassiantest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "Comment body is required. Provide as argument or pipe via stdin." {
		t.Fatalf("empty body: %#v", ce)
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	for _, path := range []string{"projects", "transitions"} {
		if _, err := product.Exec(t, reg, path, plugins.CommandInput{Args: map[string]any{"issue-key": "P-1"}, Options: map[string]any{"limit": "50"}}); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if n := len(fake.Recorded()); n != 2 {
		t.Fatalf("reads did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	myself := func(w http.ResponseWriter) {
		atlassiantest.WriteRaw(w, 200, `{"displayName":"Ada","emailAddress":"ada@example.com"}`)
	}
	projects := func(w http.ResponseWriter) { atlassiantest.WriteRaw(w, 200, `{"values":[]}`) }
	var handle func(w http.ResponseWriter, h hit)
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) { handle(w, h) })
	run := host.NewRunContext(storedCreds(1), "acme", context.Background())
	check := func(name string, wantValid bool, want string) {
		t.Helper()
		res, err := validate(context.Background(), run)
		if err != nil || res.Valid != wantValid || (wantValid && res.Info != want) || (!wantValid && res.Error != want) {
			t.Fatalf("%s: %#v %v", name, res, err)
		}
	}

	handle = func(w http.ResponseWriter, h hit) { myself(w) }
	check("displayName", true, "Ada")
	h := fake.Last()
	if h.Path != "/ex/jira/cloud-1/rest/api/3/myself" || h.Auth != "Bearer at-old" {
		t.Fatalf("%#v", h)
	}
	handle = func(w http.ResponseWriter, h hit) {
		atlassiantest.WriteRaw(w, 200, `{"displayName":"","emailAddress":"ada@example.com"}`)
	}
	check("email", true, "ada@example.com")
	handle = func(w http.ResponseWriter, h hit) { atlassiantest.WriteRaw(w, 200, `{}`) }
	check("site", true, "https://acme.atlassian.net")
	handle = func(w http.ResponseWriter, h hit) { atlassiantest.WriteRaw(w, 200, `not json`) }
	check("bad json", false, "JSON Parse error: Unexpected identifier \"not\"")

	// A token without read:me falls back to a one-project search.
	handle = func(w http.ResponseWriter, h hit) {
		if strings.HasSuffix(h.Path, "/myself") {
			w.WriteHeader(401)
			return
		}
		projects(w)
	}
	check("fallback", true, "https://acme.atlassian.net")
	if h := fake.Last(); h.Path != "/ex/jira/cloud-1/rest/api/3/project/search" || h.Query.Get("maxResults") != "1" {
		t.Fatalf("%#v", h)
	}
	handle = func(w http.ResponseWriter, h hit) {
		if strings.HasSuffix(h.Path, "/myself") {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(403)
	}
	check("both fail", false, "API returned 403")
}

func TestCommandsSendTheBunRequests(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(far()), false)
	transitions := map[string]any{"transitions": []any{
		map[string]any{"id": "31", "name": "Start", "to": map[string]any{"id": "3", "name": "In Progress", "statusCategory": map[string]any{"key": "indeterminate", "name": "In Progress"}}},
	}}
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Path == "/ex/jira/cloud-1/rest/api/3/issue/P-404":
			atlassiantest.WriteRaw(w, 404, `{"errorMessages":["Issue does not exist"]}`)
		case strings.HasSuffix(h.Path, "/transitions") && h.Method == "GET":
			writeJSON(w, 200, transitions)
		case strings.HasSuffix(h.Path, "/transitions") && h.Method == "POST":
			w.WriteHeader(204)
		case strings.HasSuffix(h.Path, "/comment"):
			writeJSON(w, 201, map[string]any{"id": "10001"})
		case strings.HasSuffix(h.Path, "/search/jql"):
			writeJSON(w, 200, map[string]any{"issues": []any{}})
		case strings.HasPrefix(h.Path, "/ex/jira/cloud-1/rest/api/3/issue/"):
			writeJSON(w, 200, map[string]any{"id": "1", "key": "P-1", "fields": map[string]any{
				"summary": "S", "status": map[string]any{"name": "Open", "statusCategory": map[string]any{"key": "new"}},
				"created": "c", "updated": "u", "project": map[string]any{"key": "P"}, "issuetype": map[string]any{"name": "Bug"},
			}})
		default:
			writeJSON(w, 200, map[string]any{"values": []any{}})
		}
	})
	exec := func(path string, args map[string]any, opts map[string]any, stdin any) (any, error) {
		t.Helper()
		if opts == nil {
			opts = map[string]any{}
		}
		opts["profile"] = "acme"
		return product.Exec(t, reg, path, plugins.CommandInput{Args: args, Options: opts, Stdin: stdin})
	}
	must := func(v any, err error) any {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	// projects: parseInt'ed limit; a falsy one (NaN, 0) sends no maxResults.
	for limit, want := range map[string]string{"10abc": "maxResults=10", "50": "maxResults=50", "x": "", "0": "", "": "", " -3": "maxResults=-3"} {
		must(exec("projects", nil, map[string]any{"limit": limit}, nil))
		h := fake.Last()
		if h.Path != "/ex/jira/cloud-1/rest/api/3/project/search" || h.Query.Encode() != want {
			t.Fatalf("projects %q: %s?%s", limit, h.Path, h.Query.Encode())
		}
	}

	// search: JQL joined the Bun way, the default when empty, limit || 50.
	must(exec("search", nil, map[string]any{"jql": "priority = High", "project": "P", "status": "In Progress", "assignee": "alice", "limit": "5"}, nil))
	h := fake.Last()
	if h.Path != "/ex/jira/cloud-1/rest/api/3/search/jql" ||
		h.Query.Get("jql") != `priority = High AND project = "P" AND status = "In Progress" AND assignee = "alice"` ||
		h.Query.Get("maxResults") != "5" ||
		h.Query.Get("fields") != "summary,status,priority,assignee,reporter,created,updated,project,issuetype,description" {
		t.Fatalf("search %#v", h.Query)
	}
	must(exec("search", nil, map[string]any{"jql": "", "limit": "abc"}, nil))
	if q := fake.Last().Query; q.Get("jql") != "ORDER BY created DESC" || q.Get("maxResults") != "50" {
		t.Fatalf("default search %v", q)
	}

	// get: the key goes in the path as given.
	must(exec("get", map[string]any{"issue-key": "P-1"}, nil, nil))
	if h := fake.Last(); h.Path != "/ex/jira/cloud-1/rest/api/3/issue/P-1" || h.Method != "GET" {
		t.Fatalf("get %#v", h)
	}

	// comment: stdin is trimmed and sent as ADF; the argument wins over stdin.
	res := must(exec("comment", map[string]any{"issue-key": "P-1"}, nil, "\n line one\nline two\n\nnext\n\n"))
	h = fake.Last()
	wantADF := `{"body":{"version":1,"type":"doc","content":[` +
		`{"type":"paragraph","content":[{"type":"text","text":"line one"},{"type":"hardBreak"},{"type":"text","text":"line two"}]},` +
		`{"type":"paragraph","content":[{"type":"text","text":"next"}]}]}}`
	if h.Method != "POST" || h.Path != "/ex/jira/cloud-1/rest/api/3/issue/P-1/comment" || h.Raw != wantADF || h.Type != "application/json" {
		t.Fatalf("comment %s %s %q", h.Method, h.Path, h.Raw)
	}
	if formatComment(res) != "Comment added\nIssue: P-1\nComment ID: 10001" {
		t.Fatalf("%q", formatComment(res))
	}
	must(exec("comment", map[string]any{"issue-key": "P-1", "body": "a\n\n\nb"}, nil, "stdin"))
	if raw := fake.Last().Raw; raw != `{"body":{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]},{"type":"paragraph","content":[{"type":"text","text":""},{"type":"hardBreak"},{"type":"text","text":"b"}]}]}}` {
		t.Fatalf("arg comment %s", raw)
	}

	// transition: looks the transition up, then posts it.
	before := len(fake.Recorded())
	res = must(exec("transition", map[string]any{"issue-key": "P-1", "transition-id": "31"}, nil, nil))
	hits := fake.Recorded()[before:]
	if len(hits) != 2 || hits[0].Method != "GET" || hits[1].Method != "POST" ||
		hits[1].Path != "/ex/jira/cloud-1/rest/api/3/issue/P-1/transitions" || hits[1].Raw != `{"transition":{"id":"31"}}` {
		t.Fatalf("transition %#v", hits)
	}
	if formatTransition(res) != "Issue transitioned\nIssue: P-1\nTransition: Start\nNew Status: In Progress" {
		t.Fatalf("%q", formatTransition(res))
	}
	before = len(fake.Recorded())
	res, err := exec("transition", map[string]any{"issue-key": "P-1", "transition-id": `9"x`}, nil, nil)
	if ce := atlassiantest.CliErr(t, err); res != nil || ce.Code != "NOT_FOUND" || ce.Message != `Transition "9"x" not found or not available for this issue` {
		t.Fatalf("unknown transition %#v %#v", res, ce)
	}
	if n := len(fake.Recorded()) - before; n != 1 {
		t.Fatalf("unknown transition sent %d requests", n)
	}

	// An API failure maps the status, keeps Atlassian's body and prints nothing.
	res, err = exec("get", map[string]any{"issue-key": "P-404"}, nil, nil)
	if ce := atlassiantest.CliErr(t, err); res != nil || ce.Code != "NOT_FOUND" || ce.Message != `JIRA API error: {"errorMessages":["Issue does not exist"]}` || ce.Suggestion != "" {
		t.Fatalf("404 %#v %#v", res, ce)
	}
}

func printed(t *testing.T, path string, v any, asJSON bool) string {
	t.Helper()
	var b bytes.Buffer
	if err := host.PrintResult(&b, product.Spec(t, path), v, asJSON); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestResponseMappingAndFormat(t *testing.T) {
	var payload struct {
		Issues []apiIssue `json:"issues"`
	}
	_ = json.Unmarshal([]byte(`{"issues":[
		{"id":"1","key":"P-1","fields":{"summary":"Crash","status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}},
		 "priority":{"name":"High"},"assignee":{"displayName":"Ada"},"reporter":null,"created":"2024-01-01","updated":"2024-01-02",
		 "project":{"key":"P"},"issuetype":{"name":"Bug"},
		 "description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a"},{"type":"hardBreak"},{"type":"text","text":"b"}]},{"type":"paragraph","content":[{"type":"text","text":"c"}]}]}}},
		{"id":"2","key":"P-2","fields":{"summary":"Plain","status":{"name":"Open","statusCategory":{"key":"new"}},"priority":null,"assignee":null,
		 "created":"c","updated":"u","project":{"key":"P"},"issuetype":{"name":"Task"},"description":null}}
	]}`), &payload)
	var issues []issue
	for _, i := range payload.Issues {
		issues = append(issues, i.model())
	}
	want := "Issues (2)\n\n" +
		"P-1 [In Progress] Crash\n    Type: Bug | Project: P\n    Assignee: Ada\n    Priority: High\n    Updated: 2024-01-02\n\n" +
		"P-2 [Open] Plain\n    Type: Task | Project: P\n    Updated: u\n\n"
	if got := printed(t, "search", issues, false); got != want {
		t.Fatalf("search\n%q\n%q", got, want)
	}
	if got := printed(t, "get", issues[0], false); got != "Key: P-1\nSummary: Crash\nStatus: In Progress\nType: Bug\nProject: P\nPriority: High\nAssignee: Ada\nCreated: 2024-01-01\nUpdated: 2024-01-02\n---\na\nb\n\nc\n" {
		t.Fatalf("get %q", got)
	}
	if got := printed(t, "get", issues[1], false); got != "Key: P-2\nSummary: Plain\nStatus: Open\nType: Task\nProject: P\nCreated: c\nUpdated: u\n" {
		t.Fatalf("get plain %q", got)
	}
	// --json is JSON.stringify of the Bun JiraIssue: undefined fields left out.
	if got := printed(t, "get", issues[1], true); got != `{
  "id": "2",
  "key": "P-2",
  "summary": "Plain",
  "status": "Open",
  "statusCategoryKey": "new",
  "created": "c",
  "updated": "u",
  "projectKey": "P",
  "issueType": "Task",
  "description": ""
}
` {
		t.Fatalf("json %s", got)
	}

	var projects struct {
		Values []project `json:"values"`
	}
	_ = json.Unmarshal([]byte(`{"values":[
		{"id":"1","key":"P","name":"Proj","projectTypeKey":"software","simplified":false,"style":"classic","isPrivate":true,"avatarUrls":{"48x48":"https://x/48","16x16":"https://x/16"}},
		{"id":"2","key":"Q","name":"Other","projectTypeKey":"business","simplified":true,"style":"next-gen","isPrivate":false}
	]}`), &projects)
	if got := printed(t, "projects", projects.Values, false); got != "Projects (2)\n\nP - Proj [private]\n    Type: software\n\nQ - Other\n    Type: business\n\n" {
		t.Fatalf("projects %q", got)
	}
	if got := printed(t, "projects", projects.Values[:1], true); !strings.Contains(got, `"avatarUrls": {
      "48x48": "https://x/48",
      "16x16": "https://x/16"
    }`) {
		t.Fatalf("avatar order %s", got)
	}
	if strings.Contains(printed(t, "projects", projects.Values[1:], true), "avatarUrls") {
		t.Fatal("absent avatarUrls printed")
	}

	list := transitionList{issueKey: "P-1"}
	_ = json.Unmarshal([]byte(`[{"id":"31","name":"Start","to":{"id":"3","name":"In Progress","statusCategory":{"key":"indeterminate","name":"In Progress"}}}]`), &list.items)
	if got := printed(t, "transitions", list, false); got != "Available transitions for P-1:\n\n[31] Start → In Progress\n" {
		t.Fatalf("transitions %q", got)
	}
	if got := printed(t, "transitions", transitionList{issueKey: "P-1"}, false); got != "No transitions available for P-1\n" {
		t.Fatalf("no transitions %q", got)
	}
	if got := printed(t, "transitions", transitionList{issueKey: "P-1"}, true); got != "[]\n" {
		t.Fatalf("no transitions json %q", got)
	}
	if printed(t, "projects", []project{}, false) != "No projects found\n" || printed(t, "search", []issue{}, false) != "No issues found\n" {
		t.Fatal("empty lists")
	}
}

func TestProfileListInfoAndNoProfile(t *testing.T) {
	info := New().Profile.ListInfo
	if info(storedCreds(1)) != " - https://acme.atlassian.net" || info(map[string]any{}) != "" {
		t.Fatal("list info")
	}
	reg := product.SetupVault(t)
	fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, map[string]any{}) })
	_, err := product.Exec(t, reg, "projects", plugins.CommandInput{Options: map[string]any{"profile": "ghost", "limit": "50"}})
	if ce := atlassiantest.CliErr(t, err); ce.Code != clierr.ProfileNotFound {
		t.Fatalf("%#v", ce)
	}
	if len(fake.Recorded()) != 0 {
		t.Fatal("API called without a profile")
	}
}

// Bun's site choice is interactiveSelect: off a terminal, with more than one
// site, a piped answer is not read and setup is refused.
func TestSiteChoiceOffATerminalIsRefused(t *testing.T) {
	product.SetupVault(t)
	atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Host == "auth.atlassian.com" && h.Path == "/oauth/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
		case h.Host == "api.atlassian.com" && h.Path == "/oauth/token/accessible-resources":
			writeJSON(w, 200, []map[string]any{
				{"id": "c-a", "url": "https://alpha.atlassian.net", "name": "alpha", "scopes": []string{}},
				{"id": "c-b", "url": "https://beta.atlassian.net", "name": "beta", "scopes": []string{}},
			})
		default:
			w.WriteHeader(404)
		}
	})
	piped := strings.NewReader("2\n")
	sc := host.NewSetupContext(host.Streams{In: piped, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}})
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &bytes.Buffer{})
	var ce *clierr.Error
	if !errors.As(err, &ce) || ce.Code != clierr.InvalidParams || ce.Message != "Interactive input required but not running in terminal" ||
		ce.Suggestion != "Run this command in an interactive terminal" {
		t.Fatalf("%v", err)
	}
	if piped.Len() != 2 {
		t.Fatal("the piped answer was read")
	}
	if c, _ := vault.Load(); len(c.Config.Profiles["jira"]) != 0 {
		t.Fatal("a profile was saved")
	}
}
