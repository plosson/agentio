package confluence

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
	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// hit is one request that reached the fake Atlassian.
type hit struct {
	Host   string
	Method string
	Path   string
	Query  url.Values
	Auth   string
	Body   map[string]any
}

// fakeAtlassian stands in for auth.atlassian.com and api.atlassian.com. The
// default transport is rewritten so production URLs land here.
type fakeAtlassian struct {
	mu     sync.Mutex
	hits   []hit
	handle func(w http.ResponseWriter, h hit)
}

func (f *fakeAtlassian) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

type rewrite struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == "api.atlassian.com" || req.URL.Host == "auth.atlassian.com" {
		out := req.Clone(req.Context())
		out.URL.Scheme = r.target.Scheme
		out.URL.Host = r.target.Host
		out.Host = r.target.Host
		out.Header.Set("X-Orig-Host", req.URL.Host)
		return r.base.RoundTrip(out)
	}
	return nil, io.ErrUnexpectedEOF // nothing else may leave the test
}

func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fakeAtlassian {
	t.Helper()
	f := &fakeAtlassian{handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		h := hit{
			Host: r.Header.Get("X-Orig-Host"), Method: r.Method, Path: r.URL.Path,
			Query: r.URL.Query(), Auth: r.Header.Get("Authorization"),
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &h.Body); err != nil {
				t.Errorf("non-JSON body %q", raw)
			}
		}
		f.mu.Lock()
		f.hits = append(f.hits, h)
		f.mu.Unlock()
		f.handle(w, h)
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	prev := http.DefaultTransport
	http.DefaultTransport = rewrite{target: target, base: srv.Client().Transport}
	t.Cleanup(func() { http.DefaultTransport = prev })
	return f
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
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"cloudId":      "cloud-1",
		"siteUrl":      "https://acme.atlassian.net",
		"legacyField":  "kept",
	}
}

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c.Credentials["confluence"][name]
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

func exec(t *testing.T, reg *plugins.Registry, path string, in plugins.CommandInput) (any, error) {
	t.Helper()
	if in.Options == nil {
		in.Options = map[string]any{}
	}
	if in.Args == nil {
		in.Args = map[string]any{}
	}
	return host.Execute(context.Background(), reg, reg.Find("confluence"), spec(t, path), in)
}

func codeOf(err error) string {
	if ce, ok := err.(*clierr.Error); ok {
		return string(ce.Code)
	}
	return ""
}

// The command table is the Bun surface. A renamed flag, a lost default, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op, input string
	}
	want := map[string]row{
		"spaces":   {"", "--limit <number>=50 --type <type>", "read", "", ""},
		"pages":    {"", "--space <key> --space-id <id> --parent <id> --limit <number>=25", "read", "", ""},
		"get":      {"<page-id>", "--format <format>=storage", "read", "", ""},
		"search":   {"", "--cql <query> --space <key> --type <type> --text <text> --limit <number>=25", "read", "", ""},
		"create":   {"", "--title <title> --space <key> --space-id <id> --parent <id> --content <text>", "write", "create page", "text"},
		"update":   {"<page-id>", "--title <title> --content <text>", "write", "update page", "text"},
		"comments": {"<page-id>", "", "read", "", ""},
		"comment":  {"<page-id> [body]", "", "write", "add comment", "text"},
	}
	p := New()
	if p.ID != "confluence" || p.DisplayName != "Confluence" || p.Description != "Use when interacting with Confluence via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	if len(p.Commands) != len(want) {
		t.Fatalf("%d commands, want %d", len(p.Commands), len(want))
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
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
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
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	sc.Prompt = func(q string, _ bool) (string, error) {
		prompts = append(prompts, q)
		return "2", nil
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
		q.Get("audience") != "api.atlassian.com" || q.Get("client_id") != atlassianClientID ||
		q.Get("scope") != "read:page:confluence write:page:confluence read:space:confluence read:comment:confluence write:comment:confluence search:confluence read:me offline_access" ||
		q.Get("redirect_uri") != "http://localhost:9999/callback" || q.Get("state") != opts.ExpectedState ||
		q.Get("response_type") != "code" || q.Get("prompt") != "consent" {
		t.Fatalf("authorize url %s", authURL)
	}
	secret, _ := obscure.Reveal(atlassianSecretEnc)
	token := fake.recorded()[0]
	if token.Body["grant_type"] != "authorization_code" || token.Body["client_id"] != atlassianClientID ||
		token.Body["client_secret"] != secret || secret == "" || token.Body["code"] != "code-1" ||
		token.Body["redirect_uri"] != "http://localhost:9999/callback" {
		t.Fatalf("token request %#v", token.Body)
	}
	if len(prompts) != 1 || !strings.Contains(prompts[0], "beta") {
		t.Fatalf("prompts %v", prompts)
	}
	// The suggested name is the site hostname, and the host saved it.
	stored := loadCreds(t, "beta.atlassian.net")
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
	if !strings.Contains(out.String(), "Test with: agentio confluence spaces") {
		t.Fatal(out.String())
	}
}

func TestSetupRefusesWhenNoSiteOrNoTerminal(t *testing.T) {
	setupVault(t)
	sites := []map[string]any{}
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			writeJSON(w, 200, map[string]any{"access_token": "a", "refresh_token": "r", "expires_in": 1})
			return
		}
		writeJSON(w, 200, sites)
	})
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	_, err := setup(context.Background(), plugins.SetupOptions{}, sc)
	if err == nil || err.Error() != "No accessible Confluence sites found. Make sure your app has the correct permissions." {
		t.Fatalf("no sites: %v", err)
	}
	// Two sites and stdin at EOF is Bun's non-TTY interactiveSelect refusal.
	sites = []map[string]any{{"id": "1", "url": "https://a.atlassian.net", "name": "a"}, {"id": "2", "url": "https://b.atlassian.net", "name": "b"}}
	_, err = setup(context.Background(), plugins.SetupOptions{}, sc)
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.InvalidParams || ce.Message != "Interactive input required but not running in terminal" {
		t.Fatalf("non-tty: %#v", err)
	}
	c, _ := vault.Load()
	if len(c.Credentials["confluence"]) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

func TestReauthenticateKeepsUnknownFields(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		writeJSON(w, 200, []map[string]any{{"id": "c-9", "url": "https://z.atlassian.net", "name": "z"}})
	})
	sc := &plugins.SetupContext{
		Log: func(...any) {}, Fetch: func(ctx context.Context, r *http.Request) (*http.Response, error) {
			return http.DefaultClient.Do(r.WithContext(ctx))
		},
		OAuth: func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
			return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:9999/callback"}, nil
		},
	}
	got, err := reauth(context.Background(), storedCreds(1), "p", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["legacyField"] != "kept" || got["accessToken"] != "at-2" || got["refreshToken"] != "rt-2" || got["cloudId"] != "c-9" || got["siteUrl"] != "https://z.atlassian.net" {
		t.Fatalf("%#v", got)
	}
}

func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("confluence", "acme", storedCreds(1), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	refreshes := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3600})
			return
		}
		writeJSON(w, 200, map[string]any{"results": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(context.Background(), reg, "confluence", "acme", auth.RefreshOptions{})
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
	secret, _ := obscure.Reveal(atlassianSecretEnc)
	body := fake.recorded()[0].Body
	if body["grant_type"] != "refresh_token" || body["refresh_token"] != "rt-old" || body["client_id"] != atlassianClientID || body["client_secret"] != secret {
		t.Fatalf("refresh request %#v", body)
	}
	stored := loadCreds(t, "acme")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-rotated" || stored["cloudId"] != "cloud-1" ||
		stored["siteUrl"] != "https://acme.atlassian.net" || stored["legacyField"] != "kept" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate %T", stored["expiryDate"])
	}
	// The command then calls the API with the refreshed token.
	if _, err := exec(t, reg, "spaces", plugins.CommandInput{Options: map[string]any{"limit": "50"}}); err != nil {
		t.Fatal(err)
	}
	last := fake.recorded()[len(fake.recorded())-1]
	if last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestRefreshKeepsTheOldRefreshTokenWhenNoneIsReturned(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"access_token": "at-new", "expires_in": 10})
	})
	got, err := refresh(context.Background(), storedCreds(1))
	if err != nil {
		t.Fatal(err)
	}
	if got["refreshToken"] != "rt-old" || got["accessToken"] != "at-new" || got["legacyField"] != "kept" {
		t.Fatalf("%#v", got)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("confluence", "acme", storedCreds(1), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			w.WriteHeader(403)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := exec(t, reg, "spaces", plugins.CommandInput{Options: map[string]any{"limit": "50"}})
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for confluence profile "acme": Failed to refresh token: {"error":"invalid_grant"}` ||
		ce.Suggestion != "Re-authenticate with: agentio confluence profile add --profile acme" {
		t.Fatalf("%#v", err)
	}
	stored := loadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if len(fake.recorded()) != 1 {
		t.Fatalf("%d requests", len(fake.recorded()))
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := setupVault(t)
	far := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := profile.Save("confluence", "ro", storedCreds(far), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"results": []any{}})
	})
	for path, op := range map[string]string{"create": "create page", "update": "update page", "comment": "add comment"} {
		_, err := exec(t, reg, path, plugins.CommandInput{
			Args:    map[string]any{"page-id": "1", "body": "hi"},
			Options: map[string]any{"title": "T", "space-id": "9", "content": "x"},
		})
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio confluence profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, err)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	if _, err := exec(t, reg, "comments", plugins.CommandInput{Args: map[string]any{"page-id": "1"}}); err != nil {
		t.Fatal(err)
	}
	if n := len(fake.recorded()); n != 1 {
		t.Fatalf("read did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"results":[]}`)
	})
	run := host.NewRunContext(storedCreds(1), "acme", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != "https://acme.atlassian.net" {
		t.Fatalf("%#v %v", res, err)
	}
	h := fake.recorded()[0]
	if h.Path != "/ex/confluence/cloud-1/wiki/api/v2/spaces" || h.Query.Get("limit") != "1" || h.Auth != "Bearer at-old" {
		t.Fatalf("%#v", h)
	}
	status = 401
	res, err = validate(context.Background(), run)
	if err != nil || res.Valid || res.Error != "API returned 401" {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(1)
	out := auth.RedactForRemote(reg, "confluence", creds)
	if _, ok := out["refreshToken"]; ok {
		t.Fatal("refreshToken leaked to a remote caller")
	}
	if out["accessToken"] != "at-old" || out["cloudId"] != "cloud-1" || creds["refreshToken"] != "rt-old" {
		t.Fatalf("%#v / %#v", out, creds)
	}
}

func TestStaleFollowsTheBunComparison(t *testing.T) {
	cases := []struct {
		name  string
		creds map[string]any
		want  bool
	}{
		{"missing expiry is never stale", map[string]any{"refreshToken": "r"}, false},
		{"null expiry coerces to 0", map[string]any{"expiryDate": nil}, true},
		{"inside the buffer", map[string]any{"expiryDate": json.Number("1400")}, true},
		{"exactly at the buffer edge", map[string]any{"expiryDate": json.Number("1500")}, true},
		{"beyond the buffer", map[string]any{"expiryDate": json.Number("1501")}, false},
	}
	for _, c := range cases {
		if got := stale(c.creds, 1000, 500); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
	if applies(map[string]any{"refreshToken": ""}) || applies(map[string]any{"refreshToken": 5}) || !applies(map[string]any{"refreshToken": "r"}) {
		t.Fatal("applies")
	}
}

func TestCommandsSendTheBunRequests(t *testing.T) {
	reg := setupVault(t)
	far := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := profile.Save("confluence", "acme", storedCreds(far), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/spaces" && h.Query.Get("keys") == "NOPE":
			writeJSON(w, 200, map[string]any{"results": []any{}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/spaces" && h.Query.Get("keys") != "":
			writeJSON(w, 200, map[string]any{"results": []any{map[string]any{"id": "77", "key": "ENG", "name": "Eng", "type": "global", "status": "current"}}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/pages/5" && h.Method == "GET":
			writeJSON(w, 200, map[string]any{"id": "5", "title": "Old", "spaceId": "77", "status": "current", "createdAt": "t", "version": map[string]any{"number": 4}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/pages/5" && h.Method == "PUT":
			writeJSON(w, 200, map[string]any{"id": "5", "title": "Old", "version": map[string]any{"number": 5}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/pages/404":
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"message":"gone"}`)
		case h.Method == "POST":
			writeJSON(w, 200, map[string]any{"id": "900", "title": "T", "spaceId": "77", "_links": map[string]any{"webui": "/spaces/ENG/pages/900"}})
		default:
			writeJSON(w, 200, map[string]any{"results": []any{}})
		}
	})
	last := func() hit { r := fake.recorded(); return r[len(r)-1] }
	opts := func(kv ...string) map[string]any {
		m := map[string]any{"profile": "acme"}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}

	// spaces: limit is parseInt'ed; NaN is sent as Bun sends it.
	if _, err := exec(t, reg, "spaces", plugins.CommandInput{Options: opts("limit", "10abc", "type", "global")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("limit") != "10" || h.Query.Get("type") != "global" {
		t.Fatalf("spaces %v", h.Query)
	}
	if _, err := exec(t, reg, "spaces", plugins.CommandInput{Options: opts("limit", "x")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("limit") != "NaN" || h.Query.Has("type") {
		t.Fatalf("spaces NaN %v", h.Query)
	}

	// pages: a space key is resolved to its id first.
	if _, err := exec(t, reg, "pages", plugins.CommandInput{Options: opts("space", "ENG", "parent", "3", "limit", "25")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Path != "/ex/confluence/cloud-1/wiki/api/v2/spaces/77/pages" || h.Query.Get("parent-id") != "3" || h.Query.Get("limit") != "25" {
		t.Fatalf("pages %#v", h)
	}
	_, err := exec(t, reg, "pages", plugins.CommandInput{Options: opts("space", "NOPE", "limit", "25")})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != "NOT_FOUND" || ce.Message != `Space "NOPE" not found` {
		t.Fatalf("missing space %#v", err)
	}

	// search: CQL is joined the Bun way and quotes in --text are escaped.
	if _, err := exec(t, reg, "search", plugins.CommandInput{Options: opts("cql", "title ~ 'API'", "space", "ENG", "type", "page", "text", `say "hi"`, "limit", "5")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Path != "/ex/confluence/cloud-1/wiki/rest/api/search" ||
		h.Query.Get("cql") != `title ~ 'API' AND space.key = "ENG" AND type = "page" AND text ~ "say \"hi\""` || h.Query.Get("limit") != "5" {
		t.Fatalf("search %#v", h)
	}
	if _, err := exec(t, reg, "search", plugins.CommandInput{Options: opts("limit", "25")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("cql") != `type = "page" ORDER BY lastmodified DESC` {
		t.Fatalf("default cql %v", h.Query)
	}

	// create: body from stdin is trimmed, escaped, and wrapped as storage.
	res, err := exec(t, reg, "create", plugins.CommandInput{Options: opts("title", "T", "space", "ENG"), Stdin: "a & <b>\nline\n\nnext\n"})
	if err != nil {
		t.Fatal(err)
	}
	h := last()
	wantBody := map[string]any{"representation": "storage", "value": "<p>a &amp; &lt;b&gt;<br/>line</p><p>next</p>"}
	if h.Path != "/ex/confluence/cloud-1/wiki/api/v2/pages" || h.Body["spaceId"] != "77" || h.Body["status"] != "current" ||
		h.Body["title"] != "T" || !jsonEqual(h.Body["body"], wantBody) {
		t.Fatalf("create %#v", h.Body)
	}
	if _, has := h.Body["parentId"]; has {
		t.Fatal("parentId sent although --parent was not given")
	}
	if formatCreated(res) != "Page created\nID: 900\nTitle: T\nSpace: 77\nLink: https://acme.atlassian.net/wiki/spaces/ENG/pages/900" {
		t.Fatalf("%q", formatCreated(res))
	}

	// update: keeps the current title, bumps the version.
	if _, err := exec(t, reg, "update", plugins.CommandInput{Args: map[string]any{"page-id": "5"}, Options: opts("content", "new")}); err != nil {
		t.Fatal(err)
	}
	h = last()
	if h.Method != "PUT" || h.Body["title"] != "Old" || h.Body["status"] != "current" || h.Body["id"] != "5" ||
		!jsonEqual(h.Body["version"], map[string]any{"number": 5}) {
		t.Fatalf("update %#v", h.Body)
	}

	// comment: the argument wins over stdin.
	if _, err := exec(t, reg, "comment", plugins.CommandInput{Args: map[string]any{"page-id": "5", "body": "arg"}, Options: opts(), Stdin: "stdin"}); err != nil {
		t.Fatal(err)
	}
	h = last()
	if h.Path != "/ex/confluence/cloud-1/wiki/api/v2/footer-comments" || h.Body["pageId"] != "5" ||
		!jsonEqual(h.Body["body"], map[string]any{"representation": "storage", "value": "<p>arg</p>"}) {
		t.Fatalf("comment %#v", h.Body)
	}

	// An API failure maps the status and keeps Atlassian's body.
	_, err = exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"page-id": "404"}, Options: opts("format", "storage")})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != "NOT_FOUND" || ce.Message != `Confluence API error: {"message":"gone"}` || ce.Suggestion != "" {
		t.Fatalf("404 %#v", err)
	}
}

func TestInputErrorsMatchBun(t *testing.T) {
	reg := setupVault(t)
	far := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := profile.Save("confluence", "acme", storedCreds(far), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, map[string]any{}) })
	cases := []struct {
		path string
		in   plugins.CommandInput
		msg  string
	}{
		{"get", plugins.CommandInput{Args: map[string]any{"page-id": "1"}, Options: map[string]any{"format": "html"}},
			`Invalid format "html". Use storage, atlas_doc_format, or view.`},
		{"create", plugins.CommandInput{Options: map[string]any{"title": "T", "content": "x"}}, "--space or --space-id is required"},
		{"create", plugins.CommandInput{Options: map[string]any{"title": "T", "space": "ENG"}, Stdin: "  \n"},
			"Page body is required. Use --content or pipe via stdin."},
		{"update", plugins.CommandInput{Args: map[string]any{"page-id": "1"}, Options: map[string]any{}},
			"Page body is required. Use --content or pipe via stdin."},
		{"comment", plugins.CommandInput{Args: map[string]any{"page-id": "1"}, Options: map[string]any{}},
			"Comment body is required. Provide as argument or pipe via stdin."},
	}
	for _, c := range cases {
		_, err := exec(t, reg, c.path, c.in)
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != clierr.InvalidParams || ce.Message != c.msg {
			t.Errorf("%s: %#v", c.path, err)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("invalid input reached the API %d times", n)
	}
	// No profile at all is the host's error, not a crash in the client.
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	_, err := exec(t, reg, "spaces", plugins.CommandInput{Options: map[string]any{"profile": "ghost"}})
	if codeOf(err) != string(clierr.ProfileNotFound) {
		t.Fatalf("%#v", err)
	}
}

func TestResponseMappingAndFormat(t *testing.T) {
	a := api{siteURL: "https://acme.atlassian.net/"}
	// search: content fields win, then the top-level title, then "(untitled)".
	var hits []searchHit
	_ = json.Unmarshal([]byte(`[
		{"content":{"id":"1","type":"page","title":"Doc","space":{"key":"ENG"}},"excerpt":"<b>x</b> &amp; y","url":"/spaces/ENG/pages/1","lastModified":"2024-01-01"},
		{"title":"Loose"},
		{"content":{"id":"3","title":""}}
	]`), &hits)
	var results []searchResult
	for _, h := range hits {
		results = append(results, a.searchModel(h))
	}
	want := "Results (3)\n\n" +
		"[page] 1 | Doc\n    Space: ENG\n    Modified: 2024-01-01\n    Link: https://acme.atlassian.net/wiki/spaces/ENG/pages/1\n    > x & y\n\n" +
		"[unknown]  | Loose\n\n" +
		"[unknown] 3 | \n"
	if got := formatSearch(results); got != want {
		t.Fatalf("search\n%q\n%q", got, want)
	}
	if formatSearch([]searchResult{}) != "No results" || formatSpaces([]space{}) != "No spaces found" ||
		formatPages([]page{}) != "No pages found" || formatComments([]comment{}) != "No comments" {
		t.Fatal("empty lists")
	}
	// A comment with no body still prints its preview line, as Bun does.
	got := formatComments([]comment{{ID: "c1", Version: 2, CreatedAt: "t"}})
	if got != "Comments (1)\n\n[c1] v2 t\n    > \n" {
		t.Fatalf("%q", got)
	}
	// Truncation counts UTF-16 units like String.prototype.slice.
	if truncate(strings.Repeat("😀", 60), 100) != strings.Repeat("😀", 50)+"..." {
		t.Fatal("utf16 truncate")
	}
	// ADF bodies flatten blocks with blank lines and hard breaks with newlines.
	adf := map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "a"}, map[string]any{"type": "hardBreak"}, map[string]any{"type": "text", "text": "b"}}},
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "c"}}},
	}}
	if extractTextFromAdf(adf) != "a\nb\n\nc" {
		t.Fatalf("%q", extractTextFromAdf(adf))
	}
	if stripHTML("<p>one</p>  <p class='x'>two<br/>three</p>\n\n\n\n&quot;q&quot;&#39;&nbsp;") != "one\n\ntwo\nthree\n\n\"q\"'" {
		t.Fatalf("%q", stripHTML("<p>one</p>  <p class='x'>two<br/>three</p>\n\n\n\n&quot;q&quot;&#39;&nbsp;"))
	}
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
