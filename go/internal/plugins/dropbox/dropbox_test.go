package dropbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// hit is one request that reached the fake Dropbox.
type hit struct {
	Host        string
	Path        string
	Auth        string
	ContentType string
	Arg         string // Dropbox-API-Arg
	Raw         []byte
}

func (h hit) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(h.Raw, &m); err != nil {
		t.Fatalf("%s: body %q is not a JSON object", h.Path, h.Raw)
	}
	return m
}

func (h hit) form(t *testing.T) url.Values {
	t.Helper()
	v, err := url.ParseQuery(string(h.Raw))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// fakeDropbox stands in for api.dropboxapi.com and content.dropboxapi.com.
// The default transport is rewritten so production URLs land here.
type fakeDropbox struct {
	mu     sync.Mutex
	hits   []hit
	handle func(w http.ResponseWriter, h hit)
}

func (f *fakeDropbox) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

func (f *fakeDropbox) paths() []string {
	var out []string
	for _, h := range f.recorded() {
		out = append(out, h.Path)
	}
	return out
}

type rewrite struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == "api.dropboxapi.com" || req.URL.Host == "content.dropboxapi.com" {
		out := req.Clone(req.Context())
		out.URL.Scheme = r.target.Scheme
		out.URL.Host = r.target.Host
		out.Host = r.target.Host
		out.Header.Set("X-Orig-Host", req.URL.Host)
		return r.base.RoundTrip(out)
	}
	return nil, io.ErrUnexpectedEOF // nothing else may leave the test
}

func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fakeDropbox {
	t.Helper()
	f := &fakeDropbox{handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		h := hit{
			Host: r.Header.Get("X-Orig-Host"), Path: r.URL.Path, Auth: r.Header.Get("Authorization"),
			ContentType: r.Header.Get("Content-Type"), Arg: r.Header.Get("Dropbox-API-Arg"), Raw: raw,
		}
		if r.Method != http.MethodPost {
			t.Errorf("%s %s: Dropbox calls are all POST", r.Method, r.URL.Path)
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

func accountJSON() map[string]any {
	return map[string]any{
		"account_id": "dbid:AA1", "name": map[string]any{"display_name": "Ada L"},
		"email": "ada@example.com", "email_verified": true,
		"account_type": map[string]any{".tag": "basic"}, "country": "FR",
	}
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

func storedCreds(expiry any) map[string]any {
	return map[string]any{
		"appKey":       "app-1",
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"accountId":    "dbid:AA1",
		"email":        "ada@example.com",
		"name":         "Ada L",
		"legacyField":  "kept",
	}
}

func farFuture() int64 { return time.Now().Add(24 * time.Hour).UnixMilli() }

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c.Credentials["dropbox"][name]
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
	return host.Execute(context.Background(), reg, reg.Find("dropbox"), spec(t, path), in)
}

func cliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	ce, ok := err.(*clierr.Error)
	if !ok {
		t.Fatalf("want a clierr, got %#v", err)
	}
	return ce
}

// The command table is the Bun surface. A renamed flag, a lost default, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op string
	}
	want := map[string]row{
		"list":     {"[path]", "--limit <n>=100 --recursive --folders", "read", ""},
		"get":      {"<path>", "", "read", ""},
		"search":   {"", "--query <text>! --path <path> --limit <n>=20 --filename-only", "read", ""},
		"download": {"<path>", "--output <path>", "read", ""},
		"put":      {"<file-path>", "--path <path> --overwrite", "write", "upload a file"},
		"mkdir":    {"<path>", "", "write", "create a folder"},
		"move":     {"<from> <to>", "", "write", "move a file"},
		"copy":     {"<from> <to>", "", "write", "copy a file"},
		"delete":   {"<path>", "--force", "write", "delete a file"},
		"link":     {"<path>", "--temporary", "write", "create a shared link"},
		"account":  {"", "", "read", ""},
	}
	p := New()
	if p.ID != "dropbox" || p.DisplayName != "Dropbox" ||
		p.Description != "Use when interacting with Dropbox via the agentio CLI - list, search, download, upload, move, copy, delete, share links." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	// tests/plugins/registry.test.ts: dropbox reauthenticates and has a lifecycle.
	if p.Profile.Reauthenticate == nil || p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" {
		t.Fatal("profile hooks")
	}
	if len(p.Profile.SetupOptions) != 1 || p.Profile.SetupOptions[0].Flags != "--app-key <key>" {
		t.Fatalf("profile add flags %#v", p.Profile.SetupOptions)
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
			if o.Required {
				f += "!" // requiredOption
			}
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			flags = append(flags, f)
		}
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil || c.Input != "" {
			t.Errorf("%s: missing examples or format, or unexpected stdin", c.Path)
		}
	}
	link := spec(t, "link")
	if link.AccessFor(plugins.CommandInput{Options: map[string]any{"temporary": true}}) != "read" ||
		link.AccessFor(plugins.CommandInput{Options: map[string]any{"temporary": false}}) != "write" {
		t.Fatal("link access does not follow --temporary")
	}
}

func setupContext(prompts map[string]string, opened *[]string) *plugins.SetupContext {
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Prompt = func(q string, _ bool) (string, error) { return prompts[q], nil }
	sc.OpenURL = func(u string) bool {
		if opened != nil {
			*opened = append(*opened, u)
		}
		return true
	}
	return sc
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/oauth2/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 14400, "token_type": "bearer", "account_id": "dbid:FROMTOKEN"})
		case "/2/users/get_current_account":
			writeJSON(w, 200, accountJSON())
		default:
			w.WriteHeader(404)
		}
	})
	var opened []string
	// --app-key is padded: Bun trims it. The code prompt answer is padded too.
	sc := setupContext(map[string]string{"? Paste the authorisation code: ": "  code-1 \n"}, &opened)
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	opts := plugins.SetupOptions{Options: map[string]any{"app-key": " app-1 "}}
	if err := host.AddProfile(context.Background(), New(), opts, sc, &out); err != nil {
		t.Fatal(err)
	}
	if len(opened) != 1 {
		t.Fatalf("opened %v", opened)
	}
	// URLSearchParams order and encoding, no redirect_uri.
	authURL := opened[0]
	prefix := "https://www.dropbox.com/oauth2/authorize?client_id=app-1&response_type=code&token_access_type=offline&code_challenge="
	suffix := "&code_challenge_method=S256&scope=account_info.read+files.metadata.read+files.content.read+files.content.write+sharing.read+sharing.write"
	if !strings.HasPrefix(authURL, prefix) || !strings.HasSuffix(authURL, suffix) {
		t.Fatalf("authorize url %s", authURL)
	}
	challenge := strings.TrimSuffix(strings.TrimPrefix(authURL, prefix), suffix)

	hits := fake.recorded()
	token := hits[0]
	if token.Host != "api.dropboxapi.com" || token.ContentType != "application/x-www-form-urlencoded" ||
		!strings.HasPrefix(string(token.Raw), "grant_type=authorization_code&code=code-1&client_id=app-1&code_verifier=") {
		t.Fatalf("token request %s %q", token.ContentType, token.Raw)
	}
	verifier := token.form(t).Get("code_verifier")
	sum := sha256.Sum256([]byte(verifier))
	if len(verifier) != 86 || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
		t.Fatalf("PKCE verifier %q does not match challenge %q", verifier, challenge)
	}
	if acct := hits[1]; acct.Auth != "Bearer at-1" || string(acct.Raw) != "null" || acct.ContentType != "application/json" {
		t.Fatalf("account call %#v", acct)
	}

	// The suggested name is the account email, and the host saved it.
	stored := loadCreds(t, "ada@example.com")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,accountId,appKey,email,expiryDate,name,refreshToken" {
		t.Fatalf("keys %v", keys)
	}
	if stored["appKey"] != "app-1" || stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" ||
		stored["accountId"] != "dbid:AA1" || stored["email"] != "ada@example.com" || stored["name"] != "Ada L" {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiryDate"].(json.Number)
	if !ok {
		t.Fatalf("expiryDate is %T, want a JSON number", stored["expiryDate"])
	}
	if n, _ := exp.Int64(); n < before+14400_000 || n > time.Now().UnixMilli()+14400_000 {
		t.Fatalf("expiry %d", n)
	}
	if out.String() != "Profile \"ada@example.com\" configured!\nAccount: Ada L <ada@example.com>\nTest with: agentio dropbox list\n" {
		t.Fatalf("%q", out.String())
	}
}

func TestSetupRefusalsMatchBunAndWriteNothing(t *testing.T) {
	setupVault(t)
	var tokenStatus int
	var tokenBody map[string]any
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth2/token" {
			writeJSON(w, tokenStatus, tokenBody)
			return
		}
		writeJSON(w, 200, accountJSON())
	})
	code := "? Paste the authorisation code: "
	cases := []struct {
		name       string
		prompts    map[string]string
		appKey     string
		status     int
		body       map[string]any
		code       clierr.Code
		message    string
		suggestion string
	}{
		{"no app key", map[string]string{"? App key: ": "   "}, "", 200, nil,
			clierr.InvalidParams, "App key is required", ""},
		{"no code", map[string]string{code: " "}, "k", 200, nil,
			clierr.InvalidParams, "Authorisation code is required", ""},
		{"no refresh token", map[string]string{code: "c"}, "k", 200, map[string]any{"access_token": "a", "expires_in": 1},
			clierr.AuthFailed, "Dropbox did not return a refresh token",
			"The authorisation URL must include token_access_type=offline - retry: agentio dropbox profile add"},
		{"code rejected", map[string]string{code: "c"}, "k", 400, map[string]any{"error": "invalid_grant"},
			clierr.InvalidParams, "", ""},
	}
	for _, c := range cases {
		tokenStatus, tokenBody = c.status, c.body
		_, err := setup(context.Background(), plugins.SetupOptions{Options: map[string]any{"app-key": c.appKey}}, setupContext(c.prompts, nil))
		ce := cliErr(t, err)
		if c.name == "code rejected" {
			// 400 is API_ERROR by status, with Bun's single-use hint.
			if ce.Code != clierr.APIError || ce.Message != `Dropbox token request failed (400): {"error":"invalid_grant"}`+"\n" ||
				ce.Suggestion != "Authorisation codes are single-use and short-lived - request a fresh one" {
				t.Fatalf("%s: %#v", c.name, ce)
			}
			continue
		}
		if ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s: %#v", c.name, ce)
		}
	}
	if n := len(fake.recorded()); n != 2 {
		t.Fatalf("%d requests; refusals before the exchange must not call Dropbox", n)
	}
	c, _ := vault.Load()
	if len(c.Credentials["dropbox"]) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

func TestReauthenticateKeepsUnknownFieldsAndNeedsTheAppKey(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth2/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		acct := accountJSON()
		acct["email"] = "new@example.com"
		writeJSON(w, 200, acct)
	})
	sc := setupContext(map[string]string{"? Paste the authorisation code: ": "c"}, nil)
	got, err := reauth(context.Background(), storedCreds(int64(1)), "p", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["legacyField"] != "kept" || got["appKey"] != "app-1" || got["accessToken"] != "at-2" || got["refreshToken"] != "rt-2" ||
		got["email"] != "new@example.com" || got["accountId"] != "dbid:AA1" {
		t.Fatalf("%#v", got)
	}
	creds := storedCreds(int64(1))
	delete(creds, "appKey")
	_, err = reauth(context.Background(), creds, "p", sc)
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed || ce.Message != "Dropbox app key is missing" {
		t.Fatalf("%#v", ce)
	}
}

func TestStaleTokenRefreshesOnceAndKeepsTheRefreshToken(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("dropbox", "acme", storedCreds(int64(1)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	refreshes := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth2/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			// Bun ignores a refresh_token in the refresh response.
			writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-ignored", "expires_in": 14400})
			return
		}
		writeJSON(w, 200, accountJSON())
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(context.Background(), reg, "dropbox", "acme", auth.RefreshOptions{})
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
	if body := string(fake.recorded()[0].Raw); body != "grant_type=refresh_token&refresh_token=rt-old&client_id=app-1" {
		t.Fatalf("refresh request %q", body)
	}
	stored := loadCreds(t, "acme")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-old" || stored["appKey"] != "app-1" ||
		stored["email"] != "ada@example.com" || stored["legacyField"] != "kept" {
		t.Fatalf("%#v", stored)
	}
	if exp, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate %T", stored["expiryDate"])
	} else if n, _ := exp.Int64(); n < time.Now().UnixMilli()+14000_000 {
		t.Fatalf("expiry %d", n)
	}
	// The command then calls the API with the refreshed token and no second refresh.
	if _, err := exec(t, reg, "account", plugins.CommandInput{}); err != nil {
		t.Fatal(err)
	}
	last := fake.recorded()[len(fake.recorded())-1]
	if last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("dropbox", "acme", storedCreds(int64(1)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth2/token" {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := exec(t, reg, "account", plugins.CommandInput{})
	ce := cliErr(t, err)
	if ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for dropbox profile "acme": Dropbox token request failed (400): {"error":"invalid_grant"}` ||
		ce.Suggestion != "Re-authenticate with: agentio dropbox profile add --profile acme" {
		t.Fatalf("%#v", ce)
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
	if err := profile.Save("dropbox", "ro", storedCreds(farFuture()), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/2/files/get_temporary_link":
			writeJSON(w, 200, map[string]any{"link": "https://dl.example/x", "metadata": map[string]any{"path_display": "/A.pdf"}})
		default:
			writeJSON(w, 200, map[string]any{"entries": []any{}, "has_more": false})
		}
	})
	local := filepath.Join(t.TempDir(), "f.txt")
	_ = os.WriteFile(local, []byte("x"), 0o600)
	args := map[string]any{"path": "/a", "from": "/a", "to": "/b", "file-path": local}
	for path, op := range map[string]string{
		"put": "upload a file", "mkdir": "create a folder", "move": "move a file",
		"copy": "copy a file", "delete": "delete a file", "link": "create a shared link",
	} {
		_, err := exec(t, reg, path, plugins.CommandInput{Args: args, Options: map[string]any{"force": true, "temporary": false}})
		ce := cliErr(t, err)
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio dropbox profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	if _, err := exec(t, reg, "list", plugins.CommandInput{Options: map[string]any{"limit": "100"}}); err != nil {
		t.Fatal(err)
	}
	res, err := exec(t, reg, "link", plugins.CommandInput{Args: map[string]any{"path": "/A.pdf"}, Options: map[string]any{"temporary": true}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(fake.paths(), " "); got != "/2/files/list_folder /2/files/get_temporary_link" {
		t.Fatalf("reads did not run: %s", got)
	}
	if formatLink(res) != "https://dl.example/x\n  Path: /A.pdf\n  Expires: in 4 hours" {
		t.Fatalf("%q", formatLink(res))
	}
}

func TestValidate(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if status != 200 {
			writeJSON(w, status, map[string]any{"error_summary": "invalid_access_token/..", "error": map[string]any{}})
			return
		}
		writeJSON(w, 200, accountJSON())
	})
	run := host.NewRunContext(storedCreds(int64(1)), "acme", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != "ada@example.com (basic)" {
		t.Fatalf("%#v %v", res, err)
	}
	if h := fake.recorded()[0]; h.Path != "/2/users/get_current_account" || h.Auth != "Bearer at-old" {
		t.Fatalf("%#v", h)
	}
	status = 401
	res, err = validate(context.Background(), run)
	if err != nil || res.Valid || res.Error != "Dropbox users/get_current_account failed (401): invalid_access_token/.." {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(int64(1))
	out := auth.RedactForRemote(reg, "dropbox", creds)
	if _, ok := out["refreshToken"]; ok {
		t.Fatal("refreshToken leaked to a remote caller")
	}
	if out["accessToken"] != "at-old" || out["appKey"] != "app-1" || creds["refreshToken"] != "rt-old" {
		t.Fatalf("%#v / %#v", out, creds)
	}
}

func TestStaleFollowsTheBunComparison(t *testing.T) {
	cases := []struct {
		name  string
		creds map[string]any
		want  bool
	}{
		{"missing expiry is stale (unlike Atlassian)", map[string]any{"refreshToken": "r"}, true},
		{"null expiry coerces to 0", map[string]any{"expiryDate": nil}, true},
		{"inside the buffer", map[string]any{"expiryDate": json.Number("1400")}, true},
		{"exactly at the buffer edge", map[string]any{"expiryDate": json.Number("1500")}, true},
		{"beyond the buffer", map[string]any{"expiryDate": json.Number("1501")}, false},
		{"a string is NaN, never stale", map[string]any{"expiryDate": "soon"}, false},
	}
	for _, c := range cases {
		if got := stale(c.creds, 1000, 500); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
	if applies(map[string]any{"refreshToken": ""}) || applies(map[string]any{}) || applies(map[string]any{"refreshToken": nil}) ||
		!applies(map[string]any{"refreshToken": "r"}) {
		t.Fatal("applies")
	}
}

func TestCommandsSendTheBunRequests(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("dropbox", "acme", storedCreds(farFuture()), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	listCalls := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/2/files/list_folder":
			listCalls++
			writeJSON(w, 200, map[string]any{"entries": []any{
				map[string]any{".tag": "file", "id": "id:1", "name": "a.txt", "path_display": "/Docs/a.txt", "size": 3},
				map[string]any{".tag": "folder", "id": "id:2", "name": "Sub", "path_lower": "/docs/sub"},
			}, "cursor": "c1", "has_more": true})
		case "/2/files/list_folder/continue":
			writeJSON(w, 200, map[string]any{"entries": []any{
				map[string]any{".tag": "folder", "id": "id:3", "name": "Two", "path_display": "/Docs/Two"},
				map[string]any{".tag": "folder", "id": "id:4", "name": "Three", "path_display": "/Docs/Three"},
			}, "cursor": "c2", "has_more": true})
		case "/2/files/search_v2":
			writeJSON(w, 200, map[string]any{"matches": []any{
				map[string]any{"metadata": map[string]any{"metadata": map[string]any{".tag": "file", "name": "q", "path_display": "/q"}}},
				map[string]any{"metadata": map[string]any{}},
			}, "has_more": false})
		case "/2/files/create_folder_v2":
			writeJSON(w, 200, map[string]any{"metadata": map[string]any{"id": "id:9", "name": "New", "path_display": "/New"}})
		case "/2/files/move_v2", "/2/files/copy_v2", "/2/files/delete_v2":
			writeJSON(w, 200, map[string]any{"metadata": map[string]any{".tag": "file", "name": "b", "path_display": "/B"}})
		case "/2/files/get_metadata":
			if strings.Contains(string(h.Raw), "missing") {
				writeJSON(w, 409, map[string]any{"error_summary": "path/not_found/..", "error": map[string]any{}})
				return
			}
			writeJSON(w, 200, map[string]any{".tag": "file", "name": "r.pdf", "path_display": "/R.pdf", "size": 1})
		case "/2/sharing/create_shared_link_with_settings":
			writeJSON(w, 409, map[string]any{"error_summary": "shared_link_already_exists/metadata/..", "error": map[string]any{}})
		case "/2/sharing/list_shared_links":
			writeJSON(w, 200, map[string]any{"links": []any{map[string]any{"url": "https://www.dropbox.com/s/old"}}})
		default:
			t.Errorf("unexpected %s", h.Path)
		}
	})
	last := func() hit { r := fake.recorded(); return r[len(r)-1] }
	opts := func(kv ...any) map[string]any {
		m := map[string]any{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}

	// list: the first page asks for the clamped limit; paging stops once the
	// limit is reached; --folders filters before counting.
	res, err := exec(t, reg, "list", plugins.CommandInput{Args: map[string]any{"path": " Docs/ "}, Options: opts("limit", "3", "recursive", true, "folders", true)})
	if err != nil {
		t.Fatal(err)
	}
	first := fake.recorded()[0]
	if string(first.Raw) != `{"path":"/Docs","recursive":true,"limit":3,"include_deleted":false,"include_non_downloadable_files":true}` {
		t.Fatalf("list body %s", first.Raw)
	}
	if got := strings.Join(fake.paths(), " "); got != "/2/files/list_folder /2/files/list_folder/continue" {
		t.Fatalf("paging %s", got)
	}
	if !jsonEqual(last().json(t), map[string]any{"cursor": "c1"}) {
		t.Fatalf("continue %s", last().Raw)
	}
	if formatEntryList(res) != "Entries in  Docs/  (3)\n\nfolder         -              /docs/sub/\nfolder         -              /Docs/Two/\nfolder         -              /Docs/Three/" {
		t.Fatalf("%q", formatEntryList(res))
	}
	// A huge limit is clamped to 2000 on the wire and a non-number is refused
	// before any call.
	if _, err := exec(t, reg, "list", plugins.CommandInput{Options: opts("limit", "5000")}); err != nil {
		t.Fatal(err)
	}
	if b := fake.recorded()[2].json(t); b["limit"] != float64(2000) || b["path"] != "" {
		t.Fatalf("clamp %v", b)
	}
	before := len(fake.recorded())
	for _, bad := range []string{"0", "-1", "abc", ""} {
		_, err := exec(t, reg, "list", plugins.CommandInput{Options: opts("limit", bad)})
		if ce := cliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "--limit must be a positive number" {
			t.Fatalf("limit %q: %#v", bad, ce)
		}
	}
	if len(fake.recorded()) != before {
		t.Fatal("a bad --limit reached the API")
	}

	// search: nested options, missing metadata skipped.
	res, err = exec(t, reg, "search", plugins.CommandInput{Options: opts("query", "q", "path", "/Acc/", "limit", "2000", "filename-only", true)})
	if err != nil {
		t.Fatal(err)
	}
	if string(last().Raw) != `{"query":"q","options":{"path":"/Acc","max_results":1000,"filename_only":true}}` {
		t.Fatalf("search %s", last().Raw)
	}
	if list := res.(entryList); len(list.entries) != 1 || list.title != "Search Results" {
		t.Fatalf("%#v", res)
	}
	_, err = exec(t, reg, "search", plugins.CommandInput{Options: opts("limit", "20")})
	if ce := cliErr(t, err); ce.Message != "required option '--query <text>' not specified" {
		t.Fatalf("%#v", ce)
	}
	// Commander's requiredOption takes a given "": Bun sends the empty query.
	if _, err = exec(t, reg, "search", plugins.CommandInput{Options: opts("query", "", "limit", "20")}); err != nil {
		t.Fatal(err)
	}
	if string(last().Raw) != `{"query":"","options":{"path":"","max_results":20,"filename_only":false}}` {
		t.Fatalf("search --query \"\" %s", last().Raw)
	}

	// mkdir forces the folder tag; move/copy send both paths normalized.
	res, err = exec(t, reg, "mkdir", plugins.CommandInput{Args: map[string]any{"path": "New/"}})
	if err != nil || spec(t, "mkdir").Format(res) != "Created folder: /New" || string(last().Raw) != `{"path":"/New","autorename":false}` {
		t.Fatalf("mkdir %v %s", err, last().Raw)
	}
	if res.(entry).Type != "folder" {
		t.Fatal("mkdir entry is not a folder")
	}
	for path, want := range map[string]string{"move": "Moved to: /B", "copy": "Copied to: /B"} {
		res, err = exec(t, reg, path, plugins.CommandInput{Args: map[string]any{"from": "a", "to": "/b/"}})
		if err != nil || spec(t, path).Format(res) != want || string(last().Raw) != `{"from_path":"/a","to_path":"/b","autorename":false}` {
			t.Fatalf("%s %v %s", path, err, last().Raw)
		}
	}

	// delete --force skips the lookup.
	before = len(fake.recorded())
	res, err = exec(t, reg, "delete", plugins.CommandInput{Args: map[string]any{"path": "id:abc"}, Options: opts("force", true)})
	if err != nil || spec(t, "delete").Format(res) != "Deleted: /B" || len(fake.recorded()) != before+1 || string(last().Raw) != `{"path":"id:abc"}` {
		t.Fatalf("delete %v %s", err, last().Raw)
	}

	// link: an existing shared link is looked up instead of failing.
	res, err = exec(t, reg, "link", plugins.CommandInput{Args: map[string]any{"path": "/R.pdf"}, Options: opts("temporary", false)})
	if err != nil || formatLink(res) != "https://www.dropbox.com/s/old\n  Path: /R.pdf\n  Expires: never" ||
		string(last().Raw) != `{"path":"/R.pdf","direct_only":true}` {
		t.Fatalf("link %v %s", err, last().Raw)
	}

	// A 409 not_found is NOT_FOUND with Dropbox's summary.
	_, err = exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"path": "/missing"}})
	if ce := cliErr(t, err); ce.Code != clierr.NotFound || ce.Message != "Dropbox files/get_metadata failed (409): path/not_found/.." || ce.Suggestion != "" {
		t.Fatalf("%#v", ce)
	}
	if listCalls != 2 {
		t.Fatalf("list calls %d", listCalls)
	}
}

func TestSharedLinkRethrowsWhenNoExistingLinkIsListed(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/2/sharing/list_shared_links" {
			writeJSON(w, 200, map[string]any{"links": []any{}})
			return
		}
		writeJSON(w, 409, map[string]any{"error_summary": "shared_link_already_exists/.."})
	})
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)
	_, err := a.sharedLink("/x")
	ae, ok := err.(*apiError)
	if !ok || ae.message != "Dropbox sharing/create_shared_link_with_settings failed (409): shared_link_already_exists/.." || ae.code != "API_ERROR" {
		t.Fatalf("%#v", err)
	}
	if len(fake.recorded()) != 2 {
		t.Fatal(fake.paths())
	}
}

func TestDeleteAsksFirstAndACancelSendsNothing(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/2/files/get_metadata" {
			writeJSON(w, 200, map[string]any{".tag": "folder", "name": "Old", "path_display": "/Old"})
			return
		}
		writeJSON(w, 200, map[string]any{"metadata": map[string]any{".tag": "folder", "path_display": "/Old"}})
	})
	// An answer that cannot be read neither deletes nor prints "Cancelled".
	run := host.NewRunContext(storedCreds(int64(1)), "acme", context.Background())
	run.Confirm = func(string) (bool, error) { return false, errors.New("read failed") }
	run.Log = func(parts ...any) { t.Fatalf("logged %v on a failed read", parts) }
	res, err := spec(t, "delete").Run(context.Background(), plugins.CommandInput{
		Args: map[string]any{"path": "old"}, Options: map[string]any{"force": false},
	}, run)
	if err != nil || res != nil || strings.Join(fake.paths(), " ") != "/2/files/get_metadata" {
		t.Fatalf("failed read: %#v %v %v", res, err, fake.paths())
	}
	for _, answer := range []bool{false, true} {
		var asked []string
		var logged []string
		run := host.NewRunContext(storedCreds(int64(1)), "acme", context.Background())
		run.Confirm = func(q string) (bool, error) { asked = append(asked, q); return answer, nil }
		run.Log = func(parts ...any) { logged = append(logged, parts[0].(string)) }
		res, err := spec(t, "delete").Run(context.Background(), plugins.CommandInput{
			Args: map[string]any{"path": "old"}, Options: map[string]any{"force": false},
		}, run)
		if err != nil {
			t.Fatal(err)
		}
		if len(asked) != 1 || asked[0] != `Delete folder (and everything in it) "/Old"?` {
			t.Fatalf("asked %q", asked)
		}
		if !answer {
			if res != nil || len(logged) != 1 || logged[0] != "Cancelled" {
				t.Fatalf("cancel: %#v %v", res, logged)
			}
			if got := strings.Join(fake.paths(), " "); got != "/2/files/get_metadata /2/files/get_metadata" {
				t.Fatalf("a cancelled delete called %s", got)
			}
			continue
		}
		if spec(t, "delete").Format(res) != "Deleted: /Old" || fake.recorded()[len(fake.recorded())-1].Path != "/2/files/delete_v2" {
			t.Fatalf("%#v", res)
		}
	}
}

func TestDownloadWritesTheFileOrAZip(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/2/files/get_metadata":
			if strings.Contains(string(h.Raw), "Folder") {
				writeJSON(w, 200, map[string]any{".tag": "folder", "name": "Folder", "path_display": "/Folder"})
				return
			}
			writeJSON(w, 200, map[string]any{".tag": "file", "name": "résumé.pdf", "path_display": "/résumé.pdf"})
		case "/2/files/download", "/2/files/download_zip":
			w.Header().Set("Dropbox-API-Result", `{"name":"x"}`)
			_, _ = io.WriteString(w, strings.Repeat("z", 1280))
		}
	})
	dir := t.TempDir()
	t.Chdir(dir)
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)

	r, err := a.download("résumé.pdf", "")
	if err != nil {
		t.Fatal(err)
	}
	dl := fake.recorded()[1]
	// Non-ASCII is \u-escaped because the argument travels in a header.
	if dl.Host != "content.dropboxapi.com" || dl.Path != "/2/files/download" || dl.Arg != `{"path":"/r\u00e9sum\u00e9.pdf"}` || len(dl.Raw) != 0 {
		t.Fatalf("download %#v", dl)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "résumé.pdf")); len(got) != 1280 {
		t.Fatalf("wrote %d bytes", len(got))
	}
	if formatDownloaded(r) != "Downloaded: /résumé.pdf\n  Path: résumé.pdf\n  Size: 1.3 KB" {
		t.Fatalf("%q", formatDownloaded(r))
	}

	r, err = a.download("/Folder", "")
	if err != nil || r.OutputPath != "Folder.zip" || r.Kind != "folder" || fake.recorded()[3].Path != "/2/files/download_zip" {
		t.Fatalf("%#v %v", r, err)
	}
	if !strings.HasSuffix(formatDownloaded(r), "\n  Format: zip archive") {
		t.Fatal(formatDownloaded(r))
	}
	out := filepath.Join(dir, "named.bin")
	if r, err = a.download("/Folder", out); err != nil || r.OutputPath != out {
		t.Fatalf("%#v %v", r, err)
	}

	before := len(fake.recorded())
	_, err = a.download(" / ", "")
	ae, ok := err.(*apiError)
	if !ok || ae.code != "INVALID_PARAMS" || ae.message != "Cannot download the account root" ||
		ae.suggestion != "Give a path, e.g. agentio dropbox download /Documents" || len(fake.recorded()) != before {
		t.Fatalf("root download %#v", err)
	}
}

func TestUploadPicksTheDestinationAndChunksLargeFiles(t *testing.T) {
	var fail409 bool
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/2/files/upload":
			if fail409 {
				writeJSON(w, 409, map[string]any{"error_summary": "path/conflict/file/.."})
				return
			}
			writeJSON(w, 200, map[string]any{"id": "id:u", "name": "f.txt", "path_display": "/Docs/f.txt", "size": 5, "rev": "r1"})
		case "/2/files/upload_session/start":
			writeJSON(w, 200, map[string]any{"session_id": "s1"})
		case "/2/files/upload_session/append_v2":
			w.WriteHeader(200) // Dropbox answers null; an empty body is accepted too
		case "/2/files/upload_session/finish":
			writeJSON(w, 200, map[string]any{"id": "id:big", "path_display": "/big.bin"})
		}
	})
	dir := t.TempDir()
	local := filepath.Join(dir, "f.txt")
	_ = os.WriteFile(local, []byte("hello"), 0o600)
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)

	for dest, remote := range map[string]string{"": "/f.txt", "/": "/f.txt", "/Docs/": "/Docs/f.txt", " Docs/ ": "/Docs/f.txt", "/Docs/g.txt": "/Docs/g.txt"} {
		if _, err := a.upload(local, dest, dest == "/Docs/g.txt"); err != nil {
			t.Fatal(err)
		}
		h := fake.recorded()[len(fake.recorded())-1]
		mode := "add"
		if dest == "/Docs/g.txt" {
			mode = "overwrite"
		}
		if h.Arg != `{"path":"`+remote+`","mode":"`+mode+`","autorename":false,"mute":false}` ||
			h.ContentType != "application/octet-stream" || string(h.Raw) != "hello" {
			t.Fatalf("%q: %#v", dest, h)
		}
	}
	r, _ := a.upload(local, "/Docs/", false)
	if formatUploaded(r) != "Uploaded: /Docs/f.txt\n  Size: 5 B\n  ID: id:u\n  Rev: r1" {
		t.Fatalf("%q", formatUploaded(r))
	}

	// Without --overwrite an existing file is an error with Bun's hint.
	fail409 = true
	_, err := a.upload(local, "/Docs/", false)
	ae, ok := err.(*apiError)
	if !ok || ae.code != "INVALID_PARAMS" || ae.message != "Dropbox files/upload failed (409): path/conflict/file/.." ||
		ae.suggestion != "A file already exists at that path - pass --overwrite to replace it" {
		t.Fatalf("%#v", err)
	}

	before := len(fake.recorded())
	_, err = a.upload(filepath.Join(dir, "nope"), "", false)
	if ae, ok := err.(*apiError); !ok || ae.code != "NOT_FOUND" || ae.message != "Local file not found: "+filepath.Join(dir, "nope") {
		t.Fatalf("%#v", err)
	}
	_, err = a.upload(dir, "", false)
	if ae, ok := err.(*apiError); !ok || ae.code != "INVALID_PARAMS" || ae.message != `"`+dir+`" is a directory` {
		t.Fatalf("%#v", err)
	}
	if len(fake.recorded()) != before {
		t.Fatal("a local failure reached the API")
	}

	// Above the single-request limit the file goes up in chunks.
	prevLimit, prevChunk := singleUploadLimit, uploadChunkSize
	singleUploadLimit, uploadChunkSize = 4, 4
	t.Cleanup(func() { singleUploadLimit, uploadChunkSize = prevLimit, prevChunk })
	big := filepath.Join(dir, "big.bin")
	_ = os.WriteFile(big, []byte("0123456789"), 0o600)
	start := len(fake.recorded())
	r, err = a.upload(big, "", false)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, h := range fake.recorded()[start:] {
		got = append(got, h.Path+" "+h.Arg+" "+string(h.Raw))
	}
	want := []string{
		`/2/files/upload_session/start {"close":false} 0123`,
		`/2/files/upload_session/append_v2 {"cursor":{"session_id":"s1","offset":4},"close":false} 4567`,
		`/2/files/upload_session/append_v2 {"cursor":{"session_id":"s1","offset":8},"close":false} 89`,
		`/2/files/upload_session/finish {"cursor":{"session_id":"s1","offset":10},"commit":{"path":"/big.bin","mode":"add","autorename":false,"mute":false}} `,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("session\n%s", strings.Join(got, "\n"))
	}
	// Size falls back to the local size when Dropbox omits it; name to the remote base.
	if r.Size != 10 || r.Name != "big.bin" || r.ID != "id:big" {
		t.Fatalf("%#v", r)
	}
}

func TestErrorMappingFollowsBun(t *testing.T) {
	cases := []struct {
		status          int
		body, code, msg string
		suggestion      string
	}{
		{401, `{"error_summary":"expired_access_token/.."}`, "AUTH_FAILED", "Dropbox users/get_current_account failed (401): expired_access_token/..", "Run: agentio dropbox profile add to re-authorise"},
		{429, `{"error_summary":"too_many_requests/"}`, "RATE_LIMITED", "Dropbox users/get_current_account failed (429): too_many_requests/", "Dropbox is rate limiting this app - wait a moment and retry"},
		{400, "Error in call: bad \n", "API_ERROR", "Dropbox users/get_current_account failed (400): Error in call: bad", ""},
		{409, `{"error_summary":"path/malformed_path/"}`, "INVALID_PARAMS", "Dropbox users/get_current_account failed (409): path/malformed_path/", ""},
		{409, `{"error_summary":"path/no_write_permission/"}`, "PERMISSION_DENIED", "Dropbox users/get_current_account failed (409): path/no_write_permission/", ""},
		{409, `{"error_summary":"path/insufficient_space/"}`, "API_ERROR", "Dropbox users/get_current_account failed (409): path/insufficient_space/", ""},
		{403, `{"error_summary":"missing_scope/.."}`, "PERMISSION_DENIED", "Dropbox users/get_current_account failed (403): missing_scope/..",
			"Enable the missing permission in the Dropbox App Console, then run: agentio dropbox profile add"},
	}
	var current int
	newFake(t, func(w http.ResponseWriter, h hit) {
		w.WriteHeader(cases[current].status)
		_, _ = io.WriteString(w, cases[current].body)
	})
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)
	for i, c := range cases {
		current = i
		_, err := a.account()
		ae, ok := err.(*apiError)
		if !ok || string(ae.code) != c.code || ae.message != c.msg || ae.suggestion != c.suggestion {
			t.Errorf("%d %s: %#v", c.status, c.body, err)
		}
	}
}

// Bun reads an error body with response.text(), which rejects when the
// connection drops: the plain TypeError, not a message built from a fragment.
func TestACutErrorBodyFailsLikeBun(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) { testbox.CutShort(t, w, 409) })
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)
	_, err := a.account()
	if _, isAPI := err.(*apiError); isAPI {
		t.Fatalf("%#v", err)
	}
	testbox.WantSocketClosed(t, err)
}

// A success body is read with response.json(), which rejects the same way.
func TestACutSuccessBodyFailsLikeBun(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) { testbox.CutShort(t, w, 200) })
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)
	_, err := a.account()
	testbox.WantSocketClosed(t, err)
}

func TestNormalizePathAndHeaderEscaping(t *testing.T) {
	for in, want := range map[string]string{
		"": "", " / ": "", "Docs": "/Docs", "/Docs///": "/Docs", "//": "", "id:abc": "id:abc",
		"rev:123/": "rev:123/", " ns:9/x ": "ns:9/x", "\ufeff/a/\ufeff": "/a",
	} {
		if got := normalizePath(in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
	got, _ := headerSafeJSON(map[string]string{"path": "/é😀<&>\u007f"})
	if got != `{"path":"/\u00e9\ud83d\ude00<&>\u007f"}` {
		t.Fatalf("%s", got)
	}
}

func TestFormatMatchesBun(t *testing.T) {
	for n, want := range map[int64]string{
		0: "0 B", 1: "1 B", 1023: "1023 B", 1024: "1 KB", 1280: "1.3 KB", 1331: "1.3 KB", 1536: "1.5 KB",
		1048576: "1 MB", 5 * 1073741824: "5 GB", 1099511627776: "1 undefined",
	} {
		if got := formatBytes(n); got != want {
			t.Errorf("formatBytes(%d) = %q, want %q", n, got, want)
		}
	}
	size := int64(2048)
	mod := "2026-01-02T03:04:05Z"
	rev := "abc"
	list := entryList{title: "Entries", entries: []entry{
		{Type: "file", Path: "/a.txt", Size: &size, Modified: &mod},
		{Type: "folder", Path: "/Dir"},
		{Type: "deleted", Path: "/gone"},
	}}
	want := "Entries (3)\n\nfile        2 KB  2026-01-02  /a.txt\nfolder         -              /Dir/\ndeleted         -              /gone"
	if got := formatEntryList(list); got != want {
		t.Fatalf("list\n%q\n%q", got, want)
	}
	if formatEntryList(entryList{title: "Search Results"}) != "No entries found" {
		t.Fatal("empty list")
	}
	// JSON is the entries alone, with Bun's omitted-when-undefined fields.
	raw, _ := marshal(list)
	if string(raw) != `[{"type":"file","id":"","name":"","path":"/a.txt","size":2048,"modified":"2026-01-02T03:04:05Z"},{"type":"folder","id":"","name":"","path":"/Dir"},{"type":"deleted","id":"","name":"","path":"/gone"}]` {
		t.Fatalf("%s", raw)
	}
	if raw, _ := marshal(entryList{}); string(raw) != "[]" {
		t.Fatalf("%s", raw)
	}
	e := entry{Type: "file", ID: "id:1", Name: "a", Path: "/a", Size: &size, Modified: &mod, Rev: &rev, ContentHash: &rev}
	if got := formatEntry(e); got != "Path: /a\nName: a\nType: file\nID: id:1\nSize: 2 KB\nModified: 2026-01-02T03:04:05Z\nRev: abc\nContent hash: abc" {
		t.Fatalf("%q", got)
	}
	if got := formatEntry(entry{Type: "folder", Path: "/d", Name: "d"}); got != "Path: /d\nName: d\nType: folder" {
		t.Fatalf("%q", got)
	}
	country := "FR"
	if got := formatAccount(account{AccountID: "dbid:1", Name: "Ada", Email: "a@x", AccountType: "pro", Country: &country}); got !=
		"Account: Ada\n  Email: a@x (unverified)\n  Type: pro\n  Country: FR\n  ID: dbid:1" {
		t.Fatalf("%q", got)
	}
	if got := formatUploaded(uploadResult{Path: "/p", Size: 0}); got != "Uploaded: /p\n  Size: 0 B" {
		t.Fatalf("%q", got)
	}
	if listInfo(map[string]any{"email": "a@x"}) != " - a@x" || listInfo(map[string]any{}) != "" {
		t.Fatal("listInfo")
	}
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// A success body that is not JSON fails with JSON.parse's message (Bun
// `text ? JSON.parse(text) : undefined`).
func TestASuccessBodyThatIsNotJSONFailsLikeBun(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) { _, _ = io.WriteString(w, `{"account_id":`) })
	a := newAPI(context.Background(), storedCreds(int64(1)), host.NewRunContext(nil, "", nil).Fetch)
	if _, err := a.account(); err == nil || err.Error() != "JSON Parse error: Unexpected EOF" {
		t.Fatalf("%v", err)
	}
}
