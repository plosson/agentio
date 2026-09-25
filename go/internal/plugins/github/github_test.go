package github

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
	"golang.org/x/crypto/nacl/box"
)

// hit is one request that reached the fake GitHub.
type hit struct {
	Host, Method, Path   string
	Auth, Accept, APIVer string
	ContentType          string
	Raw                  []byte
}

type fakeGitHub struct {
	mu     sync.Mutex
	hits   []hit
	handle func(w http.ResponseWriter, h hit)
}

func (f *fakeGitHub) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

type rewrite struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == "api.github.com" || req.URL.Host == "github.com" {
		out := req.Clone(req.Context())
		out.URL.Scheme = r.target.Scheme
		out.URL.Host = r.target.Host
		out.Host = r.target.Host
		out.Header.Set("X-Orig-Host", req.URL.Host)
		return r.base.RoundTrip(out)
	}
	return nil, io.ErrUnexpectedEOF // nothing else may leave the test
}

func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		h := hit{
			Host: r.Header.Get("X-Orig-Host"), Method: r.Method, Path: r.URL.Path,
			Auth: r.Header.Get("Authorization"), Accept: r.Header.Get("Accept"),
			APIVer: r.Header.Get("X-GitHub-Api-Version"), ContentType: r.Header.Get("Content-Type"), Raw: raw,
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

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return testbox.Map(c.Credentials.Get("github", name))
}

func cliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	ce, ok := err.(*clierr.Error)
	if !ok {
		t.Fatalf("want a clierr, got %#v", err)
	}
	return ce
}

// setupContext answers the OAuth callback without a listener and records the
// authorize URL the host would open.
func setupContext(log *bytes.Buffer, authURL *string) *plugins.SetupContext {
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: log})
	sc.OAuth = func(_ context.Context, opts plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		redirect := "http://localhost:3000/callback"
		if authURL != nil {
			*authURL = opts.AuthorizationURL(redirect)
		}
		if opts.ServiceName != "GitHub" || opts.Port != 0 || opts.ExpectedState == "" {
			return plugins.OAuthSetupResult{}, io.ErrUnexpectedEOF
		}
		return plugins.OAuthSetupResult{Code: "code-1", State: opts.ExpectedState, RedirectURI: redirect}, nil
	}
	return sc
}

func userHandler(user map[string]any) func(w http.ResponseWriter, h hit) {
	return func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/login/oauth/access_token":
			writeJSON(w, 200, map[string]any{"access_token": "gho_new", "token_type": "bearer", "scope": "repo"})
		case "/user":
			writeJSON(w, 200, user)
		default:
			w.WriteHeader(500)
		}
	}
}

func TestIdentityAndCommandTableMatchBun(t *testing.T) {
	p := New()
	if p.ID != "github" || p.DisplayName != "GitHub" || p.Description != "Use when interacting with GitHub via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	// install/uninstall read the vault and belong to the host; the plugin has
	// no service command of its own, and no refresh lifecycle (static token).
	if len(p.Commands) != 0 {
		t.Fatalf("unexpected plugin commands %#v", p.Commands)
	}
	// tests/plugins/registry.test.ts: github reauthenticates.
	if p.Profile == nil || p.Profile.Reauthenticate == nil || p.Profile.Refresh != nil || len(p.Profile.SetupOptions) != 0 {
		t.Fatal("profile hooks")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	fake := newFake(t, userHandler(map[string]any{"login": "octocat", "email": "octo@example.com", "name": "Octo"}))
	var log, out bytes.Buffer
	var authURL string
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, setupContext(&log, &authURL), &out); err != nil {
		t.Fatal(err)
	}
	prefix := "https://github.com/login/oauth/authorize?client_id=Ov23liR1X63IRAf6eONJ&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&scope=repo&state="
	if !strings.HasPrefix(authURL, prefix) || len(authURL) == len(prefix) {
		t.Fatalf("authorize url %s", authURL)
	}
	hits := fake.recorded()
	if len(hits) != 2 {
		t.Fatalf("%d requests", len(hits))
	}
	token := hits[0]
	var body map[string]any
	_ = json.Unmarshal(token.Raw, &body)
	secret, _ := body["client_secret"].(string)
	if token.Host != "github.com" || token.Method != "POST" || token.Accept != "application/json" || token.ContentType != "application/json" ||
		!strings.HasPrefix(string(token.Raw), `{"client_id":"Ov23liR1X63IRAf6eONJ","client_secret":`) ||
		body["code"] != "code-1" || body["redirect_uri"] != "http://localhost:3000/callback" || secret == "" || len(body) != 4 {
		t.Fatalf("token request %#v %s", token, token.Raw)
	}
	u := hits[1]
	if u.Host != "api.github.com" || u.Method != "GET" || u.Auth != "Bearer gho_new" || u.Accept != "application/vnd.github+json" ||
		u.APIVer != "2022-11-28" || u.ContentType != "" || len(u.Raw) != 0 {
		t.Fatalf("user request %#v", u)
	}
	stored := loadCreds(t, "octocat")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,email,username" ||
		stored["accessToken"] != "gho_new" || stored["username"] != "octocat" || stored["email"] != "octo@example.com" {
		t.Fatalf("stored %#v", stored)
	}
	if out.String() != "Profile \"octocat\" configured!\nInstall secrets: agentio github install owner/repo\n" {
		t.Fatalf("stdout %q", out.String())
	}
	wantLog := "\nGitHub Setup\n\nThis will open your browser to authorize agentio with GitHub.\n" +
		"You will need to grant access to repositories where you want to set secrets.\n\n" +
		"\nAuthenticated as: octocat (octo@example.com)\n"
	if log.String() != wantLog {
		t.Fatalf("stderr %q", log.String())
	}
}

func TestSetupKeepsANullEmailAndHonoursReadOnly(t *testing.T) {
	setupVault(t)
	newFake(t, userHandler(map[string]any{"login": "octocat", "email": nil}))
	// tests/config/profile-store.test.ts: a read-only add beside an existing
	// octocat profile is named octocat-readonly.
	if err := profile.Save("github", "octocat", testbox.Object(map[string]any{"accessToken": "gho_rw"}), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	var log, out bytes.Buffer
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{ReadOnly: true}, setupContext(&log, nil), &out); err != nil {
		t.Fatal(err)
	}
	stored := loadCreds(t, "octocat-readonly")
	if v, ok := stored["email"]; !ok || v != nil {
		t.Fatalf("email must be stored as null: %#v", stored)
	}
	if !strings.HasSuffix(log.String(), "\nAuthenticated as: octocat\n") {
		t.Fatalf("stderr %q", log.String())
	}
	if ro, _ := profile.IsReadOnly("github", "octocat-readonly"); !ro {
		t.Fatal("profile is not read-only")
	}
	if loadCreds(t, "octocat")["accessToken"] != "gho_rw" {
		t.Fatal("the existing profile was overwritten")
	}
}

func TestSetupFailuresMatchBunAndWriteNothing(t *testing.T) {
	cases := []struct {
		name    string
		handle  func(w http.ResponseWriter, h hit)
		code    clierr.Code
		message string
	}{
		{"token error description", func(w http.ResponseWriter, h hit) {
			writeJSON(w, 200, map[string]any{"error": "bad_verification_code", "error_description": "The code passed is incorrect or expired."})
		}, "", "The code passed is incorrect or expired."},
		{"token error only", func(w http.ResponseWriter, h hit) {
			writeJSON(w, 200, map[string]any{"error": "incorrect_client_credentials"})
		}, "", "incorrect_client_credentials"},
		{"no token", func(w http.ResponseWriter, h hit) {
			writeJSON(w, 200, map[string]any{})
		}, "", "Failed to get access token"},
		{"user rejected", func(w http.ResponseWriter, h hit) {
			if h.Path == "/user" {
				writeJSON(w, 401, map[string]any{"message": "Bad credentials"})
				return
			}
			writeJSON(w, 200, map[string]any{"access_token": "gho_new"})
		}, clierr.AuthFailed, "GitHub authentication failed: Bad credentials"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setupVault(t)
			newFake(t, c.handle)
			var log bytes.Buffer
			err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, setupContext(&log, nil), io.Discard)
			if err == nil || err.Error() != c.message {
				t.Fatalf("err %v", err)
			}
			if ce, ok := err.(*clierr.Error); ok != (c.code != "") || (ok && ce.Code != c.code) {
				t.Fatalf("error kind %#v", err)
			}
			v, _ := vault.Load()
			if len(v.Credentials.Profiles("github")) != 0 || len(v.Config.Profiles.Get("github")) != 0 {
				t.Fatalf("a failed setup wrote the vault: %#v", v.Credentials)
			}
		})
	}
}

func TestReauthenticateKeepsUnknownFieldsAndReplacesTheUser(t *testing.T) {
	setupVault(t)
	// No email key on /user: Bun's spread writes undefined, which JSON drops.
	newFake(t, userHandler(map[string]any{"login": "hubber"}))
	var log bytes.Buffer
	old := map[string]any{"accessToken": "gho_old", "username": "octocat", "email": "octo@example.com", "legacyField": "kept"}
	got, err := New().Profile.Reauthenticate(context.Background(), testbox.Object(old), "work", setupContext(&log, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got.Value("accessToken") != "gho_new" || got.Value("username") != "hubber" || got.Value("legacyField") != "kept" {
		t.Fatalf("%#v", got)
	}
	if _, ok := testbox.Map(got)["email"]; ok {
		t.Fatalf("absent email must be dropped: %#v", got)
	}
	if old["accessToken"] != "gho_old" {
		t.Fatal("reauthenticate mutated the caller's map")
	}
	if !strings.Contains(log.String(), "\nRe-authenticating github / work...\n") || !strings.HasSuffix(log.String(), "  Done (hubber)\n") {
		t.Fatalf("stderr %q", log.String())
	}
}

func TestValidate(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if status != 200 {
			writeJSON(w, status, map[string]any{"message": "Bad credentials"})
			return
		}
		writeJSON(w, 200, map[string]any{"login": "octocat", "email": nil})
	})
	run := host.NewRunContext(testbox.Object(map[string]any{"accessToken": "gho_1", "username": "octocat", "email": nil}), "octocat", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != "octocat" {
		t.Fatalf("%#v %v", res, err)
	}
	if h := fake.recorded()[0]; h.Path != "/user" || h.Auth != "Bearer gho_1" {
		t.Fatalf("%#v", h)
	}
	status = 401
	res, err = validate(context.Background(), run)
	if err != nil || res.Valid || res.Error != "GitHub authentication failed: Bad credentials" {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestStaticTokenGoesToRemoteCallersWhole(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := map[string]any{"accessToken": "gho_1", "username": "octocat", "email": nil}
	out := auth.RedactForRemote(reg, "github", testbox.Object(creds))
	if out.Value("accessToken") != "gho_1" || out.Value("username") != "octocat" || out.Len() != 3 {
		t.Fatalf("%#v", out)
	}
}

func TestListInfo(t *testing.T) {
	if got := listInfo(testbox.Object(map[string]any{"username": "octocat"})); got != " (octocat)" {
		t.Fatalf("%q", got)
	}
	for _, c := range []map[string]any{{}, {"username": ""}, {"username": nil}} {
		if got := listInfo(testbox.Object(c)); got != "" {
			t.Fatalf("%#v -> %q", c, got)
		}
	}
}

func testClient() *Client {
	run := host.NewRunContext(testbox.Object(map[string]any{"accessToken": "gho_1"}), "octocat", context.Background())
	return NewClient(context.Background(), run)
}

func TestErrorMappingFollowsBun(t *testing.T) {
	cases := []struct {
		status             int
		body               string
		code               clierr.Code
		message, suggested string
	}{
		{401, `{"message":"Bad credentials"}`, clierr.AuthFailed, "GitHub authentication failed: Bad credentials", ""},
		{403, `{"message":"Resource not accessible"}`, clierr.PermissionDenied, "Permission denied: Resource not accessible", "You need admin access to set secrets on this repository"},
		{404, `{"message":"Not Found"}`, clierr.NotFound, "Not found: Not Found", "Check that the repository exists and you have access to it"},
		{429, `{"message":"slow down"}`, clierr.RateLimited, "Rate limited: slow down", ""},
		{500, `{}`, clierr.APIError, "GitHub API error: Unknown GitHub API error", ""},
		{422, `{"message":""}`, clierr.APIError, "GitHub API error: Unknown GitHub API error", ""},
		{502, `<html>bad gateway</html>`, clierr.NetworkError, "Failed to connect to GitHub: JSON Parse error: Unrecognized token '<'", ""},
		{200, "  \n", clierr.NetworkError, "Failed to connect to GitHub: JSON Parse error: Unexpected EOF", ""},
		{404, ``, clierr.NetworkError, "Failed to connect to GitHub: null is not an object (evaluating 'data.message')", ""},
		{400, `[1]`, clierr.APIError, "GitHub API error: Unknown GitHub API error", ""},
		{200, `{"a":1`, clierr.NetworkError, "Failed to connect to GitHub: JSON Parse error: Expected '}'", ""},
		{205, ``, clierr.NetworkError, "Failed to connect to GitHub: Unexpected end of JSON input", ""},
	}
	for _, c := range cases {
		newFake(t, func(w http.ResponseWriter, h hit) {
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		})
		err := testClient().DeleteRepoSecret("octocat/hello", "AGENTIO_KEY")
		ce := cliErr(t, err)
		if ce.Code != c.code || ce.Suggestion != c.suggested {
			t.Fatalf("%d: %#v", c.status, ce)
		}
		if c.message != "" && ce.Message != c.message {
			t.Fatalf("%d: %q", c.status, ce.Message)
		}
		if c.code == clierr.NetworkError && !strings.HasPrefix(ce.Message, "Failed to connect to GitHub: ") {
			t.Fatalf("%d: %q", c.status, ce.Message)
		}
	}
}

func TestSetRepoSecretSealsTheValueForTheRepoKey(t *testing.T) {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Method == "GET" && h.Path == "/repos/octocat/hello/actions/secrets/public-key":
			writeJSON(w, 200, map[string]any{"key_id": "568250167242549743", "key": base64.StdEncoding.EncodeToString(pub[:])})
		case h.Method == "PUT" && h.Path == "/repos/octocat/hello/actions/secrets/AGENTIO_KEY":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(500)
		}
	})
	if err := testClient().SetRepoSecret("octocat/hello", "AGENTIO_KEY", "s3cret-value"); err != nil {
		t.Fatal(err)
	}
	hits := fake.recorded()
	if len(hits) != 2 {
		t.Fatalf("%d requests", len(hits))
	}
	put := hits[1]
	if put.ContentType != "application/json" || put.Auth != "Bearer gho_1" || put.APIVer != "2022-11-28" {
		t.Fatalf("%#v", put)
	}
	var body struct {
		EncryptedValue string `json:"encrypted_value"`
		KeyID          string `json:"key_id"`
	}
	if err := json.Unmarshal(put.Raw, &body); err != nil || body.KeyID != "568250167242549743" ||
		!strings.HasPrefix(string(put.Raw), `{"encrypted_value":`) {
		t.Fatalf("%s %v", put.Raw, err)
	}
	sealed, err := base64.StdEncoding.DecodeString(body.EncryptedValue)
	if err != nil {
		t.Fatal(err)
	}
	plain, ok := box.OpenAnonymous(nil, sealed, pub, priv)
	if !ok || string(plain) != "s3cret-value" {
		t.Fatalf("sealed box did not open: %q %v", plain, ok)
	}
}

func TestSetRepoSecretStopsOnABadKeyAndDeleteAcceptsNoContent(t *testing.T) {
	var puts int
	newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Method {
		case "GET":
			writeJSON(w, 200, map[string]any{"key_id": "1", "key": "AAAA"})
		case "PUT":
			puts++
			w.WriteHeader(201) // empty body: Bun's fetch reads null, not an error
		case "DELETE":
			w.WriteHeader(204)
		}
	})
	err := testClient().SetRepoSecret("octocat/hello", "AGENTIO_KEY", "x")
	if err == nil || err.Error() != "invalid publicKey length" || puts != 0 {
		t.Fatalf("%v, %d puts", err, puts)
	}
	if _, err := sealBox("!!!", "x"); err == nil || err.Error() != "incomplete input" {
		t.Fatalf("%v", err)
	}
	if err := testClient().DeleteRepoSecret("octocat/hello", "AGENTIO_KEY"); err != nil {
		t.Fatal(err)
	}
	pub, _, _ := box.GenerateKey(rand.Reader)
	good := base64.StdEncoding.EncodeToString(pub[:])
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Method == "GET" {
			writeJSON(w, 200, map[string]any{"key_id": "1", "key": good})
			return
		}
		puts++
		w.WriteHeader(201)
	})
	if err := testClient().SetRepoSecret("octocat/hello", "AGENTIO_KEY", "x"); err != nil || puts != 1 {
		t.Fatalf("an empty 201 must succeed: %v, %d puts", err, puts)
	}
}
