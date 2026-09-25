package falco

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
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
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// hit is one request that reached the fake Falco.
type hit struct {
	Host, Method, Path, Query, Auth, ContentType string
	Raw                                          []byte
}

func (h hit) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(h.Raw, &m); err != nil {
		t.Fatalf("%s: body %q is not a JSON object", h.Path, h.Raw)
	}
	return m
}

// form reads a multipart body as ordered name=value pairs.
func (h hit) form(t *testing.T) []string {
	t.Helper()
	_, params, err := mime.ParseMediaType(h.ContentType)
	if err != nil {
		t.Fatalf("content type %q", h.ContentType)
	}
	mr := multipart.NewReader(bytes.NewReader(h.Raw), params["boundary"])
	var out []string
	for {
		part, err := mr.NextPart()
		if err != nil {
			break
		}
		v, _ := io.ReadAll(part)
		out = append(out, part.FormName()+"="+string(v))
	}
	return out
}

type fake struct {
	mu     sync.Mutex
	hits   []hit
	handle func(w http.ResponseWriter, h hit)
}

func (f *fake) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

type rewriteTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	switch req.URL.Host {
	case "accounts.horus-software.be", "api.my-falco.be", "horusapi-billing.azurewebsites.net":
		out := req.Clone(req.Context())
		out.URL.Scheme, out.URL.Host, out.Host = r.target.Scheme, r.target.Host, r.target.Host
		out.Header.Set("X-Orig-Host", req.URL.Host)
		return r.base.RoundTrip(out)
	}
	return nil, io.ErrUnexpectedEOF // nothing else may leave the test
}

// newFake stands in for the three Falco hosts; production URLs land here.
func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fake {
	t.Helper()
	f := &fake{handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		h := hit{Host: r.Header.Get("X-Orig-Host"), Method: r.Method, Path: r.URL.EscapedPath(), Query: r.URL.RawQuery,
			Auth: r.Header.Get("Authorization"), ContentType: r.Header.Get("Content-Type"), Raw: raw}
		f.mu.Lock()
		f.hits = append(f.hits, h)
		f.mu.Unlock()
		f.handle(w, h)
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	prev := http.DefaultTransport
	http.DefaultTransport = rewriteTransport{target: target, base: srv.Client().Transport}
	t.Cleanup(func() { http.DefaultTransport = prev })
	return f
}

func reply(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
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

func farFuture() int64 { return time.Now().Add(24 * time.Hour).UnixMilli() }

func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"refreshToken": "rt-old", "refreshExpiryDate": farFuture() * 2, "accessToken": "at-old", "expiryDate": expiry,
		"organizationId": "org-1", "organizationName": "Acme BV", "userId": "user-1", "userEmail": "pierre@example.com",
		"legacyField": "kept",
	}
}

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c.Credentials["falco"][name]
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
	return host.Execute(context.Background(), reg, reg.Find("falco"), spec(t, path), in)
}

func cliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	ce, ok := err.(*clierr.Error)
	if !ok {
		t.Fatalf("want a clierr, got %#v", err)
	}
	return ce
}

// apiErr reads a client error before a command hands it to the host.
func apiErr(t *testing.T, err error) *apiError {
	t.Helper()
	ae, ok := err.(*apiError)
	if !ok {
		t.Fatalf("want an apiError, got %#v", err)
	}
	return ae
}

func testClient() *client {
	return newClient(context.Background(), storedCreds(farFuture()), nil)
}

const meJSON = `{"id":"user-1","email":"pierre@example.com","firstName":"Pierre","lastName":"Losson","language":"fr","organizations":[{"id":"org-1","name":"Acme BV","vatNumber":"BE0123456789"}]}`

const tokensJSON = `{"access_token":"access-abc","refresh_token":"refresh-xyz","expires_in":600,"refresh_token_expires_in":86400}`

// The command table is the Bun surface. A renamed flag, a lost default, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct{ args, flags, access, op string }
	want := map[string]row{
		"peppol list":      {"", "--since <date> --sender <text> --format <format>=text", "read", ""},
		"peppol get":       {"<id>", "--output <path> --extract-pdf", "read", ""},
		"peppol sync":      {"", "--output <dir> --since <date> --sender <text> --extract-pdf --force", "read", ""},
		"peppol mark-paid": {"<ref>", "--status <status>=Paid --unpaid --format <format>=text", "write", "mark an invoice as paid"},
		"peppol import":    {"<ref>", "--dry-run --format <format>=text", "write", "import a Peppol document into the invoice register"},
		"invoices sync":    {"", "--output <dir> --since <date> --customer <text> --include <types>=Invoice,CreditNote --force", "read", ""},
	}
	p := New()
	if p.ID != "falco" || p.DisplayName != "Falco" ||
		p.Description != "Use when interacting with Falco accounting and Peppol documents via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	// tests/plugins/registry.test.ts: falco reauthenticates and withholds the refresh token.
	if p.Profile.Reauthenticate == nil || p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" ||
		len(p.Profile.SetupOptions) != 0 {
		t.Fatal("profile hooks")
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
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil || c.Input != "" {
			t.Errorf("%s: missing examples or format, or unexpected stdin", c.Path)
		}
	}
	imp := spec(t, "peppol import")
	if imp.AccessFor(plugins.CommandInput{Options: map[string]any{"dry-run": true}}) != "read" ||
		imp.AccessFor(plugins.CommandInput{Options: map[string]any{"dry-run": false}}) != "write" {
		t.Fatal("import access does not follow --dry-run")
	}
}

func setupContext(answers map[string][]string, logged *[]string) *plugins.SetupContext {
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	queues := map[string][]string{}
	for q, a := range answers {
		queues[q] = append([]string(nil), a...)
	}
	answers = queues
	var mu sync.Mutex
	sc.Prompt = func(q string, _ bool) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		queue := answers[q]
		if len(queue) == 0 {
			return "", io.EOF
		}
		answers[q] = queue[1:]
		return queue[0], nil
	}
	if logged != nil {
		sc.Log = func(parts ...any) {
			for _, p := range parts {
				*logged = append(*logged, p.(string))
			}
		}
	}
	return sc
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	logins := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/login":
			logins++
			if logins == 1 {
				reply(w, 400, `{"error":"two_factor_required"}`)
				return
			}
			reply(w, 200, tokensJSON)
		case "/user/me":
			reply(w, 200, `{"id":"user-1","email":"pierre@example.com","firstName":"Pierre","lastName":"Losson","organizations":[`+
				`{"id":"org-1","name":"Acme BV","vatNumber":"BE0123456789"},{"id":"org-2","name":"Béta  SPRL!","vatNumber":null}]}`)
		default:
			w.WriteHeader(404)
		}
	})
	var logged []string
	sc := setupContext(map[string][]string{
		"? Email: ": {"  pierre@example.com "}, "? Password: ": {" pw "}, "? Two-factor code: ": {" 123456 "},
		"? Organization (1-2): ": {"9", "2"},
	}, &logged)
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	hits := fake.recorded()
	// Bun's login body, field for field; the password is not trimmed.
	first := `{"userName":"pierre@example.com","password":" pw ","twoFaCode":null,"brand":"falco","impersonate":null,"scopes":["myhorus","billing","falco","oclaf"]}`
	second := strings.Replace(first, `"twoFaCode":null`, `"twoFaCode":"123456"`, 1)
	if hits[0].Host != "accounts.horus-software.be" || string(hits[0].Raw) != first || hits[0].ContentType != "application/json" ||
		string(hits[1].Raw) != second {
		t.Fatalf("login requests %q / %q", hits[0].Raw, hits[1].Raw)
	}
	if hits[2].Path != "/user/me" || hits[2].Auth != "Bearer access-abc" || hits[2].Host != "api.my-falco.be" {
		t.Fatalf("%#v", hits[2])
	}
	// An out-of-range answer is asked again, as a select cannot pick one.
	if strings.Join(logged, "|") != "\nFalco Setup\n|? Organization|  1) Acme BV — BE0123456789|  2) Béta  SPRL!" {
		t.Fatalf("%q", logged)
	}
	stored := loadCreds(t, "beta-sprl")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,expiryDate,organizationId,organizationName,refreshExpiryDate,refreshToken,userEmail,userId" {
		t.Fatalf("keys %v", keys)
	}
	if stored["accessToken"] != "access-abc" || stored["refreshToken"] != "refresh-xyz" || stored["organizationId"] != "org-2" ||
		stored["organizationName"] != "Béta  SPRL!" || stored["userId"] != "user-1" || stored["userEmail"] != "pierre@example.com" {
		t.Fatalf("%#v", stored)
	}
	for key, secs := range map[string]int64{"expiryDate": 600, "refreshExpiryDate": 86400} {
		n, ok := stored[key].(json.Number)
		if !ok {
			t.Fatalf("%s is %T, want a JSON number", key, stored[key])
		}
		if v, _ := n.Int64(); v < before+secs*1000 || v > time.Now().UnixMilli()+secs*1000 {
			t.Fatalf("%s %d", key, v)
		}
	}
	if out.String() != "Profile \"beta-sprl\" configured!\nPierre Losson <pierre@example.com>\nOrganization: Béta  SPRL! (org-2)\n" {
		t.Fatalf("%q", out.String())
	}
}

func TestSetupWithOneOrganizationAsksNoQuestion(t *testing.T) {
	setupVault(t)
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/login" {
			reply(w, 200, tokensJSON)
			return
		}
		reply(w, 200, meJSON)
	})
	sc := setupContext(map[string][]string{"? Email: ": {"pierre@example.com"}, "? Password: ": {"pw"}}, nil)
	res, err := setup(context.Background(), plugins.SetupOptions{}, sc)
	if err != nil {
		t.Fatal(err)
	}
	if res.SuggestedProfileName != "acme-bv" || res.Credentials["organizationId"] != "org-1" {
		t.Fatalf("%#v", res)
	}
}

func TestSetupRefusalsMatchBunAndWriteNothing(t *testing.T) {
	setupVault(t)
	var loginReplies []string
	var meReply string
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/login" {
			body := loginReplies[0]
			loginReplies = loginReplies[1:]
			status := 200
			if strings.Contains(body, `"error"`) {
				status = 400
			}
			reply(w, status, body)
			return
		}
		reply(w, 200, meReply)
	})
	creds := map[string][]string{"? Email: ": {"a@b.c"}, "? Password: ": {"pw"}}
	with := func(extra map[string][]string) map[string][]string {
		out := map[string][]string{}
		for k, v := range creds {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	twoFA := `{"error":"two_factor_required"}`
	cases := []struct {
		name                string
		answers             map[string][]string
		logins              []string
		me                  string
		code                clierr.Code
		message, suggestion string
	}{
		{"no email", map[string][]string{"? Email: ": {"  "}}, nil, "", clierr.InvalidParams, "An email address is required", ""},
		{"no password", with(map[string][]string{"? Password: ": {""}}), nil, "", clierr.InvalidParams, "A password is required", ""},
		{"bad password", creds, []string{`{"error":"invalid_credentials"}`}, "", clierr.AuthFailed, "Invalid Falco credentials", "Check the email and password"},
		{"no code", with(map[string][]string{"? Two-factor code: ": {" "}}), []string{twoFA}, "", clierr.InvalidParams, "A two-factor code is required", ""},
		{"bad code", with(map[string][]string{"? Two-factor code: ": {"000"}}), []string{twoFA, `{"error":"invalid_two_factor_code"}`}, "",
			clierr.AuthFailed, "Falco rejected the two-factor code", "Codes expire quickly. Re-run the command and enter a fresh one."},
		{"still 2FA", with(map[string][]string{"? Two-factor code: ": {"000"}}), []string{twoFA, twoFA}, "",
			clierr.AuthFailed, "Falco is still asking for a two-factor code", "Re-run the command and enter a fresh code."},
		{"no organizations", creds, []string{tokensJSON}, `{"id":"u","email":"a@b.c","organizations":[]}`,
			clierr.ConfigError, "This Falco account has no organizations", ""},
	}
	for _, c := range cases {
		loginReplies, meReply = c.logins, c.me
		before := len(fake.recorded())
		_, err := setup(context.Background(), plugins.SetupOptions{}, setupContext(c.answers, nil))
		ce := cliErr(t, err)
		if ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s: %#v", c.name, ce)
		}
		if strings.Contains(ce.Message+ce.Suggestion, "pw") {
			t.Fatalf("%s: the password reached an error", c.name)
		}
		if c.logins == nil && len(fake.recorded()) != before {
			t.Fatalf("%s: a refusal before login called Falco", c.name)
		}
	}
	c, _ := vault.Load()
	if len(c.Credentials["falco"]) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

func TestReauthenticateKeepsTheProfileAndRevokesTheOldTokenLast(t *testing.T) {
	var me string
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/login":
			reply(w, 200, tokensJSON)
		case "/user/me":
			reply(w, 200, me)
		default:
			reply(w, 200, "")
		}
	})
	me = strings.Replace(meJSON, `"name":"Acme BV"`, `"name":"Acme Renamed"`, 1)
	var logged []string
	sc := setupContext(map[string][]string{"? Password: ": {"pw"}}, &logged)
	before := time.Now().UnixMilli()
	out, err := reauth(context.Background(), storedCreds(1), "acme", sc)
	if err != nil {
		t.Fatal(err)
	}
	if out["accessToken"] != "access-abc" || out["refreshToken"] != "refresh-xyz" || out["organizationName"] != "Acme Renamed" ||
		out["legacyField"] != "kept" || out["userEmail"] != "pierre@example.com" || out["organizationId"] != "org-1" {
		t.Fatalf("%#v", out)
	}
	if exp := out["expiryDate"].(jsNum); int64(exp) < before+600_000 {
		t.Fatalf("expiry %v", exp)
	}
	var paths []string
	for _, h := range fake.recorded() {
		paths = append(paths, h.Path)
	}
	if strings.Join(paths, " ") != "/login /user/me /user/me /revoke-refresh-token" {
		t.Fatalf("%v", paths)
	}
	last := fake.recorded()[3]
	if string(last.Raw) != `{"RefreshToken":"rt-old"}` || !strings.Contains(fake.recorded()[0].json(t)["userName"].(string), "pierre@example.com") {
		t.Fatalf("revoke %q", last.Raw)
	}
	if strings.Join(logged, "|") != "\nRe-authenticating falco / acme (pierre@example.com)|  Done (pierre@example.com — Acme Renamed)" {
		t.Fatalf("%q", logged)
	}

	// A membership that is gone fails, and the old token is not revoked.
	me = strings.Replace(meJSON, `"id":"org-1"`, `"id":"org-9"`, 1)
	n := len(fake.recorded())
	_, err = reauth(context.Background(), storedCreds(1), "acme", setupContext(map[string][]string{"? Password: ": {"pw"}}, nil))
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed ||
		ce.Message != "Could not use this profile: pierre@example.com is no longer a member of organization org-1" {
		t.Fatalf("%#v", ce)
	}
	for _, h := range fake.recorded()[n:] {
		if h.Path == "/revoke-refresh-token" {
			t.Fatal("revoked after a failed reauth")
		}
	}
	_, err = reauth(context.Background(), storedCreds(1), "acme", setupContext(map[string][]string{"? Password: ": {""}}, nil))
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed || ce.Message != "A password is required" {
		t.Fatalf("%#v", ce)
	}
	_, err = reauth(context.Background(), nil, "acme", setupContext(nil, nil))
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed || ce.Message != `Profile "acme" has no stored Falco credentials` ||
		ce.Suggestion != "Run: agentio falco profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
}

func TestStaleTokenRefreshesOnceAndPersistsTheRotatedToken(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("falco", "acme", storedCreds(1), profile.SaveOptions{}); err != nil {
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
			reply(w, 200, `{"access_token":"at-new","refresh_token":"rt-rotated","expires_in":600,"refresh_token_expires_in":2592000}`)
			return
		}
		reply(w, 200, "[]")
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(context.Background(), reg, "falco", "acme", auth.RefreshOptions{})
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
	tok := fake.recorded()[0]
	if tok.Host != "accounts.horus-software.be" || !strings.HasPrefix(tok.ContentType, "multipart/form-data; boundary=") ||
		strings.Join(tok.form(t), "&") != "grant_type=refresh_token&scope=myhorus billing oclaf&refresh_token=rt-old" {
		t.Fatalf("refresh request %s %q", tok.ContentType, tok.Raw)
	}
	stored := loadCreds(t, "acme")
	// Falco rotates the refresh token, so the new one must be what was kept.
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-rotated" || stored["legacyField"] != "kept" ||
		stored["organizationId"] != "org-1" || stored["userEmail"] != "pierre@example.com" {
		t.Fatalf("%#v", stored)
	}
	for key, secs := range map[string]int64{"expiryDate": 600, "refreshExpiryDate": 2592000} {
		n, ok := stored[key].(json.Number)
		if !ok {
			t.Fatalf("%s %T", key, stored[key])
		}
		if v, _ := n.Int64(); v < time.Now().UnixMilli()+secs*1000-60_000 {
			t.Fatalf("%s %d", key, v)
		}
	}
	if _, err := exec(t, reg, "peppol list", plugins.CommandInput{Options: map[string]any{"format": "text"}}); err != nil {
		t.Fatal(err)
	}
	last := fake.recorded()[len(fake.recorded())-1]
	if last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("falco", "acme", storedCreds(1), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth2/token" {
			reply(w, 400, "invalid_grant")
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := exec(t, reg, "peppol list", plugins.CommandInput{})
	ce := cliErr(t, err)
	if ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for falco profile "acme": Falco refresh failed (HTTP 400): invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio falco profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	if stored := loadCreds(t, "acme"); stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if len(fake.recorded()) != 1 {
		t.Fatalf("%d requests", len(fake.recorded()))
	}

	// A refresh token past its own expiry is not sent at all.
	expired := storedCreds(1)
	expired["refreshExpiryDate"] = int64(1000)
	if err := profile.Save("falco", "old", expired, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	_, err = exec(t, reg, "peppol list", plugins.CommandInput{Options: map[string]any{"profile": "old"}})
	if ce := cliErr(t, err); ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for falco profile "old": The Falco refresh token has expired` {
		t.Fatalf("%#v", ce)
	}
	if len(fake.recorded()) != 1 {
		t.Fatal("an expired refresh token was sent")
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("falco", "ro", storedCreds(farFuture()), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		reply(w, 200, `[{"id":"pep-1","invoiceReference":"INV-1","importState":"NotImported"}]`)
	})
	for path, op := range map[string]string{"peppol mark-paid": "mark an invoice as paid", "peppol import": "import a Peppol document into the invoice register"} {
		_, err := exec(t, reg, path, plugins.CommandInput{Args: map[string]any{"ref": "INV-1"},
			Options: map[string]any{"status": "Paid", "format": "text", "dry-run": false}})
		ce := cliErr(t, err)
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio falco profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	// Bun checks --status before enforceWriteAccess, even with --unpaid.
	for _, unpaid := range []bool{false, true} {
		_, err := exec(t, reg, "peppol mark-paid", plugins.CommandInput{Args: map[string]any{"ref": "INV-1"},
			Options: map[string]any{"status": "bogus", "unpaid": unpaid, "format": "text"}})
		if ce := cliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "--status must be Paid or NotPaid, got: bogus" {
			t.Fatalf("--unpaid %v: %#v", unpaid, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	if _, err := exec(t, reg, "peppol list", plugins.CommandInput{Options: map[string]any{"format": "text"}}); err != nil {
		t.Fatal(err)
	}
	res, err := exec(t, reg, "peppol import", plugins.CommandInput{Args: map[string]any{"ref": "INV-1"},
		Options: map[string]any{"dry-run": true, "format": "json"}})
	if err != nil {
		t.Fatal(err)
	}
	if formatRecord(res) != "{\n  \"id\": \"pep-1\",\n  \"invoiceReference\": \"INV-1\",\n  \"importState\": \"NotImported\"\n}" {
		t.Fatalf("%q", formatRecord(res))
	}
	for _, h := range fake.recorded() {
		if h.Method != http.MethodGet {
			t.Fatalf("a dry run wrote: %s %s", h.Method, h.Path)
		}
	}
}

// Bun requireIsoDate checks `value === undefined`, and Commander's
// requiredOption takes a given --output "": an empty --since is rejected and
// an empty --output fails in mkdir, before any API call.
func TestGivenEmptySinceAndOutputAreNotAbsent(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("falco", "rw", storedCreds(farFuture()), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) { reply(w, 200, `[]`) })
	for _, c := range []struct {
		path string
		opts map[string]any
		want string
	}{
		{"peppol list", map[string]any{"since": "", "format": "text"}, "INVALID_PARAMS: --since must be YYYY-MM-DD, got: "},
		{"peppol sync", map[string]any{"output": "", "since": ""}, "INVALID_PARAMS: --since must be YYYY-MM-DD, got: "},
		{"invoices sync", map[string]any{"output": "", "since": "", "include": "Invoice"}, "INVALID_PARAMS: --since must be YYYY-MM-DD, got: "},
		{"peppol sync", map[string]any{"output": ""}, "ENOENT: no such file or directory, mkdir"},
		{"invoices sync", map[string]any{"output": "", "include": "Invoice"}, "ENOENT: no such file or directory, mkdir"},
		{"peppol sync", map[string]any{}, "INVALID_PARAMS: required option '--output <dir>' not specified"},
	} {
		_, err := exec(t, reg, c.path, plugins.CommandInput{Options: c.opts})
		got := fmt.Sprint(err)
		if ce, ok := err.(*clierr.Error); ok {
			got = string(ce.Code) + ": " + ce.Message
		}
		if got != c.want {
			t.Errorf("%s %v: %q", c.path, c.opts, got)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("rejected input reached the API %d times", n)
	}
}

func TestValidate(t *testing.T) {
	me := meJSON
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) { reply(w, status, me) })
	run := host.NewRunContext(storedCreds(1), "acme", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != "pierre@example.com — Acme BV" {
		t.Fatalf("%#v %v", res, err)
	}
	if h := fake.recorded()[0]; h.Path != "/user/me" || h.Auth != "Bearer at-old" {
		t.Fatalf("%#v", h)
	}
	// A revoked membership leaves the token valid but the profile useless.
	me = strings.Replace(meJSON, `"id":"org-1"`, `"id":"other"`, 1)
	res, _ = validate(context.Background(), run)
	if res.Valid || res.Error != "pierre@example.com is no longer a member of organization org-1" {
		t.Fatalf("%#v", res)
	}
	status, me = 401, "nope"
	res, _ = validate(context.Background(), run)
	if res.Valid || res.Error != "Falco request failed while reading the account (HTTP 401): nope" {
		t.Fatalf("%#v", res)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(1)
	out := auth.RedactForRemote(reg, "falco", creds)
	if _, ok := out["refreshToken"]; ok {
		t.Fatal("refreshToken leaked to a remote caller")
	}
	if out["accessToken"] != "at-old" || out["organizationId"] != "org-1" || creds["refreshToken"] != "rt-old" {
		t.Fatalf("%#v / %#v", out, creds)
	}
}

func TestStaleAndAppliesFollowBun(t *testing.T) {
	cases := []struct {
		name  string
		creds map[string]any
		want  bool
	}{
		{"missing expiry has never been exchanged", map[string]any{"refreshToken": "r"}, true},
		{"null expiry coerces to 0", map[string]any{"expiryDate": nil}, true},
		{"inside the buffer", map[string]any{"expiryDate": json.Number("1400")}, true},
		{"exactly at the buffer edge", map[string]any{"expiryDate": json.Number("1500")}, true},
		{"beyond the buffer", map[string]any{"expiryDate": json.Number("1501")}, false},
		{"a numeric string coerces", map[string]any{"expiryDate": "1501"}, false},
		{"a word is NaN, never stale", map[string]any{"expiryDate": "soon"}, false},
	}
	for _, c := range cases {
		if got := stale(c.creds, 1000, 500); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
	if applies(map[string]any{"refreshToken": ""}) || applies(map[string]any{}) || !applies(map[string]any{"refreshToken": "r"}) {
		t.Fatal("applies")
	}
	if listInfo(storedCreds(1)) != " - pierre@example.com (Acme BV)" ||
		listInfo(map[string]any{"userEmail": "a@b", "organizationId": "org-9"}) != " - a@b (org-9)" || listInfo(nil) != "" {
		t.Fatal("listInfo")
	}
}

// tests/plugins/falco/auth.test.ts
func TestLoginAndRefreshFollowBun(t *testing.T) {
	var status int
	var body string
	newFake(t, func(w http.ResponseWriter, h hit) { reply(w, status, body) })
	ctx := context.Background()

	status, body = 200, tokensJSON
	res, err := login(ctx, plugins.Fetch, "a@b.c", "pw", nil)
	if err != nil || res.twoFactorRequired || res.tokens.accessToken != "access-abc" || res.tokens.refreshToken != "refresh-xyz" ||
		res.tokens.expiresIn != 600 || res.tokens.refreshTokenExpiresIn != 86400 {
		t.Fatalf("%#v %v", res, err)
	}
	// A truncated success response still contains a live token; never echo it.
	status, body = 200, `{"access_token":"eyJhbGciOi-LIVE-TOKEN`
	_, err = login(ctx, plugins.Fetch, "a@b.c", "pw", nil)
	ae := apiErr(t, err)
	if strings.Contains(ae.message+ae.suggestion, "LIVE-TOKEN") || strings.Contains(ae.message+ae.suggestion, "access_token") ||
		ae.message != "Falco returned a login response that could not be read" {
		t.Fatalf("%#v", ae)
	}
	// Storing an undefined refresh token disables refresh silently.
	status, body = 200, `{"access_token":"a","expires_in":600}`
	_, err = login(ctx, plugins.Fetch, "a@b.c", "pw", nil)
	if ae := apiErr(t, err); ae.code != "API_ERROR" ||
		ae.message != "Falco returned an incomplete token response (missing refresh_token, refresh_token_expires_in)" {
		t.Fatalf("%#v", ae)
	}
	status, body = 400, `{"error":"two_factor_required"}`
	if res, err := login(ctx, plugins.Fetch, "a@b.c", "pw", nil); err != nil || !res.twoFactorRequired {
		t.Fatalf("%#v %v", res, err)
	}
	status, body = 400, `{"error":"invalid_credentials"}`
	_, err = login(ctx, plugins.Fetch, "a@b.c", "hunter2", nil)
	if ae := apiErr(t, err); ae.message != "Invalid Falco credentials" || strings.Contains(ae.message+ae.suggestion, "hunter2") {
		t.Fatalf("%#v", ae)
	}
	status, body = 503, strings.Repeat("x", 300)
	_, err = login(ctx, plugins.Fetch, "a@b.c", "pw", nil)
	if ae := apiErr(t, err); ae.code != "AUTH_FAILED" || ae.message != "Falco login failed (HTTP 503): "+strings.Repeat("x", 200) {
		t.Fatalf("%#v", ae)
	}

	status, body = 200, `{"access_token":"a","refresh_token":"rotated-new","expires_in":600,"refresh_token_expires_in":1}`
	if tok, err := refreshToken(ctx, plugins.Fetch, "refresh-old"); err != nil || tok.refreshToken != "rotated-new" {
		t.Fatalf("%#v %v", tok, err)
	}
	status, body = 200, `{"access_token":"a","expires_in":600}`
	_, err = refreshToken(ctx, plugins.Fetch, "refresh-old")
	if ae := apiErr(t, err); ae.code != "API_ERROR" || !strings.Contains(ae.message, "refresh_token") {
		t.Fatalf("%#v", ae)
	}
	status, body = 400, "invalid_grant"
	_, err = refreshToken(ctx, plugins.Fetch, "refresh-old")
	if ae := apiErr(t, err); ae.code != "TOKEN_EXPIRED" || ae.suggestion != "Run: agentio reauth" {
		t.Fatalf("%#v", ae)
	}
}

func TestTransportFailuresAreNetworkErrors(t *testing.T) {
	prev := http.DefaultTransport
	http.DefaultTransport = rewriteTransport{target: &url.URL{Scheme: "http", Host: "127.0.0.1:1"}, base: prev}
	t.Cleanup(func() { http.DefaultTransport = prev })
	_, err := login(context.Background(), plugins.Fetch, "a@b.c", "pw", nil)
	if ae := apiErr(t, err); ae.code != "NETWORK_ERROR" || !strings.HasPrefix(ae.message, "Could not reach Falco: ") {
		t.Fatalf("%#v", ae)
	}
	_, err = testClient().getUserMe()
	if ae := apiErr(t, err); ae.code != "NETWORK_ERROR" || !strings.Contains(ae.message, "reading the account") {
		t.Fatalf("%#v", ae)
	}
}

// A connection cut mid-body: where Bun reads with text(), json() or
// arrayBuffer() the plain TypeError surfaces; where it reads an error body with
// .catch(() => "") the body is empty; where it never reads, nothing fails.
func TestACutBodyFailsWhereBunReadsIt(t *testing.T) {
	status := 200
	newFake(t, func(w http.ResponseWriter, h hit) { testbox.CutShort(t, w, status) })
	ctx := context.Background()
	plain := func(name string, err error) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			if _, isAPI := err.(*apiError); isAPI {
				t.Errorf("%#v", err)
			}
			testbox.WantSocketClosed(t, err)
		})
	}
	for _, s := range []int{200, 500} {
		status = s
		_, err := testClient().getUserMe()
		plain(fmt.Sprintf("getJson %d", s), err)
		_, err = testClient().listBillingDocuments(billingTypes{invoices: true})
		plain(fmt.Sprintf("billing list %d", s), err)
		_, err = login(ctx, plugins.Fetch, "a@b.c", "pw", nil)
		plain(fmt.Sprintf("login %d", s), err)
	}
	status = 200
	_, err := testClient().downloadPeppolDocumentUbl("doc-1")
	plain("peppol download", err)
	_, err = testClient().downloadBillingDocumentPdf("bill-1")
	plain("billing download", err)
	_, err = refreshToken(ctx, plugins.Fetch, "refresh-old")
	plain("refresh", err)
	if err := testClient().setInvoicePaymentStatus("inv-1", "paid"); err != nil {
		t.Errorf("an unread success body failed: %v", err)
	}
	if _, err := testClient().importPeppolDocumentToFalco("doc-1"); apiErr(t, err).message !=
		"Falco returned an empty body while importing Peppol document doc-1 into the invoice register" {
		t.Errorf("%#v", err)
	}

	status = 500
	_, err = testClient().downloadPeppolDocumentUbl("doc-1")
	if ae := apiErr(t, err); ae.message != "Falco request failed while downloading document doc-1 (HTTP 500)" {
		t.Errorf("%#v", ae)
	}
	err = testClient().setPeppolDocumentPaymentStatus("doc-1", "paid")
	if ae := apiErr(t, err); ae.message != "Falco request failed while updating Peppol payment status for doc-1 (HTTP 500)" {
		t.Errorf("%#v", ae)
	}
	_, err = refreshToken(ctx, plugins.Fetch, "refresh-old")
	if ae := apiErr(t, err); ae.code != "TOKEN_EXPIRED" || ae.message != "Falco refresh failed (HTTP 500): " {
		t.Errorf("%#v", ae)
	}
}

// peppol get writes nothing when the download is cut short.
func TestACutPeppolDownloadWritesNothing(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("falco", "acme", storedCreds(farFuture()), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	newFake(t, func(w http.ResponseWriter, h hit) { testbox.CutShort(t, w, 200) })
	dir := t.TempDir()
	_, err := exec(t, reg, "peppol get", plugins.CommandInput{Args: map[string]any{"id": "doc-1"},
		Options: map[string]any{"output": dir, "extract-pdf": true}})
	testbox.WantSocketClosed(t, err)
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("a truncated download was saved: %v", entries)
	}
}

// tests/plugins/falco/client.test.ts
func TestClientErrorsFollowBun(t *testing.T) {
	var status int
	var body string
	newFake(t, func(w http.ResponseWriter, h hit) { reply(w, status, body) })
	for s, code := range map[int]plugins.ErrorCode{401: "AUTH_FAILED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RATE_LIMITED", 500: "API_ERROR", 400: "API_ERROR"} {
		status, body = s, ""
		_, err := testClient().getUserMe()
		if ae := apiErr(t, err); ae.code != code {
			t.Errorf("%d: %s", s, ae.code)
		}
	}
	// The body goes in the message; the suggestion is an action, reauth on 401 only.
	status, body = 400, `{"error":"bad_request"}`
	_, err := testClient().getUserMe()
	if ae := apiErr(t, err); ae.message != `Falco request failed while reading the account (HTTP 400): {"error":"bad_request"}` || ae.suggestion != "" {
		t.Fatalf("%#v", ae)
	}
	status, body = 401, "nope"
	_, err = testClient().getUserMe()
	if ae := apiErr(t, err); ae.suggestion != "Run: agentio reauth" {
		t.Fatalf("%#v", ae)
	}
	status, body = 500, "   "
	_, err = testClient().getUserMe()
	if ae := apiErr(t, err); ae.message != "Falco request failed while reading the account (HTTP 500)" {
		t.Fatalf("%#v", ae)
	}
	status, body = 200, "<html>maintenance</html>"
	_, err = testClient().getUserMe()
	if ae := apiErr(t, err); ae.code != "API_ERROR" || ae.message != "Falco returned malformed JSON while reading the account: <html>maintenance</html>" {
		t.Fatalf("%#v", ae)
	}
}

func TestPaginationWalksTheCursorAndStops(t *testing.T) {
	var pages []string
	var mu sync.Mutex
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		mu.Lock()
		defer mu.Unlock()
		reply(w, 200, pages[0])
		if len(pages) > 1 {
			pages = pages[1:]
		}
	})
	pages = []string{`[{"id":"a"},{"id":"b"}]`, `[{"id":"b"},{"id":"c"}]`, `[]`}
	var progress []string
	docs, err := testClient().listAllPeppolDocuments(func(page, added, total int) {
		progress = append(progress, strings.Join([]string{string(rune('0' + page)), string(rune('0' + added)), string(rune('0' + total))}, "/"))
	})
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, d := range docs {
		id, _ := d.Str("id")
		ids = append(ids, id)
	}
	hits := fake.recorded()
	if strings.Join(ids, ",") != "a,b,c" || len(hits) != 3 || !strings.HasSuffix(hits[1].Query, "&last=b") ||
		strings.Contains(hits[0].Query, "last=") || strings.Join(progress, " ") != "0/2/2 1/1/3" {
		t.Fatalf("%v %d %q %v", ids, len(hits), hits[1].Query, progress)
	}
	if hits[0].Path != "/peppol/documents/org-1" ||
		hits[0].Query != "showNotImported=true&showImported=true&showProcessing=true&showAccepted=true&showRejected=true&showNoResponse=true&selfBilling=false" {
		t.Fatalf("%s?%s", hits[0].Path, hits[0].Query)
	}

	// A page of documents already seen means the cursor is stuck.
	pages = []string{`[{"id":"a"}]`, `[{"id":"a"}]`}
	before := len(fake.recorded())
	docs, _ = testClient().listAllPeppolDocuments(nil)
	if len(docs) != 1 || len(fake.recorded())-before != 2 {
		t.Fatalf("%d docs, %d requests", len(docs), len(fake.recorded())-before)
	}
	pages = []string{`[{"id":"inv-1"}]`, `[]`}
	before = len(fake.recorded())
	if _, err := testClient().listAllInvoices(); err != nil {
		t.Fatal(err)
	}
	inv := fake.recorded()[before:]
	if inv[0].Path != "/document/invoices" || inv[0].Query != "organizationId=org-1&take=100&sortBy=createdAt&sortDirection=desc" ||
		inv[1].Query != "organizationId=org-1&take=100&sortBy=createdAt&sortDirection=desc&last=inv-1" {
		t.Fatalf("%q %q", inv[0].Query, inv[1].Query)
	}
}

func TestClientRequestsFollowBun(t *testing.T) {
	var status int
	var body, contentType string
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	})
	c := testClient()
	last := func() hit { r := fake.recorded(); return r[len(r)-1] }

	status, body = 200, `{"BillingDocuments":[{"Id":"b-1"}]}`
	docs, err := c.listBillingDocuments(billingTypes{invoices: true, creditNotes: true})
	if err != nil || len(docs) != 1 {
		t.Fatalf("%v %v", docs, err)
	}
	h := last()
	if h.Host != "horusapi-billing.azurewebsites.net" || h.Method != "POST" || h.Path != "/api.billing/billing-documents/period/org-1" ||
		string(h.Raw) != `{"Invoices":true,"CreditNotes":true,"Estimates":false,"AdvancePayments":false,"Proformas":false,"Offset":0}` {
		t.Fatalf("%#v %s", h, h.Raw)
	}
	status, body = 200, `{}`
	if docs, err := c.listBillingDocuments(billingTypes{}); err != nil || len(docs) != 0 {
		t.Fatalf("%v %v", docs, err)
	}
	status, body = 200, `null`
	if _, err := c.listBillingDocuments(billingTypes{}); apiErr(t, err).message != "Falco returned malformed JSON while listing billing documents: null" {
		t.Fatal(err)
	}

	// Falco can answer 200 with an HTML error page instead of UBL.
	status, body, contentType = 200, "<html>error</html>", "text/html"
	_, err = c.downloadPeppolDocumentUbl("doc-1")
	if ae := apiErr(t, err); ae.message != "Falco returned a web page instead of UBL XML for doc-1" ||
		ae.suggestion != "The document may not be available yet. Run: agentio falco peppol list" {
		t.Fatalf("%#v", ae)
	}
	status, body, contentType = 200, "<Invoice/>", "application/xml"
	x, err := c.downloadPeppolDocumentUbl("doc/1 é")
	if err != nil || string(x) != "<Invoice/>" || last().Path != "/peppol/document/doc%2F1%20%C3%A9" {
		t.Fatalf("%q %v %s", x, err, last().Path)
	}

	status, body, contentType = 200, "", ""
	if err := c.setInvoicePaymentStatus("inv-1", "Paid"); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "PUT" || h.Path != "/document/invoices/status" || string(h.Raw) != `{"DocumentId":"inv-1","PaymentStatus":"Paid"}` {
		t.Fatalf("%#v %s", h, h.Raw)
	}
	if err := c.setPeppolDocumentPaymentStatus("doc/1", "NotPaid"); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "PUT" || h.Path != "/peppol/document/doc%2F1/status" || string(h.Raw) != `{"Status":"NotPaid"}` {
		t.Fatalf("%#v %s", h, h.Raw)
	}

	status, body = 200, `{"id":"doc/1","importState":"Imported"}`
	doc, err := c.importPeppolDocumentToFalco("doc/1")
	if err != nil || !is(doc, "importState", "Imported") {
		t.Fatal(err)
	}
	if h := last(); h.Method != "POST" || h.Path != "/peppol/transfer-falco" || string(h.Raw) != `{"PeppolDocumentId":"doc/1"}` {
		t.Fatalf("%#v %s", h, h.Raw)
	}
	status, body = 400, `{"errorType":"already_imported"}`
	_, err = c.importPeppolDocumentToFalco("doc-1")
	if ae := apiErr(t, err); ae.code != "INVALID_PARAMS" || ae.message != "Peppol document doc-1 is already imported" {
		t.Fatalf("%#v", ae)
	}
	status, body = 200, ""
	_, err = c.importPeppolDocumentToFalco("doc-1")
	if ae := apiErr(t, err); ae.message != "Falco returned an empty body while importing Peppol document doc-1 into the invoice register" {
		t.Fatalf("%#v", ae)
	}
}

// A failed rendition after the XML reached stdout keeps that XML, then fails,
// as Bun wrote before it threw.
func TestGetToStdoutKeepsTheXMLWhenThePDFFails(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("falco", "acme", storedCreds(farFuture()), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	xml := "\ufeff<Invoice><ID>1</ID><AccountingSupplierParty><Party><PartyName><Name>Ωmega</Name></PartyName></Party></AccountingSupplierParty></Invoice>"
	newFake(t, func(w http.ResponseWriter, h hit) {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, xml)
	})
	t.Chdir(t.TempDir())
	res, err := exec(t, reg, "peppol get", plugins.CommandInput{Args: map[string]any{"id": "doc-1"},
		Options: map[string]any{"output": "-", "extract-pdf": true}})
	if err == nil || err.Error() != `WinAnsi cannot encode "Ω" (0x03a9)` {
		t.Fatalf("%v", err)
	}
	// TextDecoder drops the BOM.
	if formatWritten(res) != strings.TrimPrefix(xml, "\ufeff") {
		t.Fatalf("%q", formatWritten(res))
	}
	if _, err := os.Stat("doc-1.pdf"); err == nil {
		t.Fatal("a failed rendition left a file")
	}
}

// tests/plugins/falco/manifest.test.ts
func TestManifestReconciliation(t *testing.T) {
	type move struct{ from, to string }
	var moves []move
	onRename := func(from, to string) error { moves = append(moves, move{from, to}); return nil }

	m := emptyManifest()
	index := indexManifest(m)
	b, renamed, _ := resolveBasename("id-1", "2026-07-14_acme_1", m, index, onRename)
	if b != "2026-07-14_acme_1" || renamed || m.entries["id-1"] != b || len(moves) != 0 {
		t.Fatal("new document")
	}
	// Same metadata on a second run is a no-op; the owner never collides with itself.
	b, renamed, _ = resolveBasename("id-1", "2026-07-14_acme_1", m, index, onRename)
	if b != "2026-07-14_acme_1" || renamed || len(moves) != 0 {
		t.Fatal("second run")
	}
	// Two documents deriving the same name are kept apart.
	b, _, _ = resolveBasename("id-2", "2026-07-14_acme_1", m, index, onRename)
	if b != "2026-07-14_acme_1_2" || strings.Join(m.ids, ",") != "id-1,id-2" {
		t.Fatalf("%s %v", b, m.ids)
	}
	// Changed metadata renames on disk.
	b, renamed, _ = resolveBasename("id-1", "2026-07-15_acme-bv_1", m, index, onRename)
	if b != "2026-07-15_acme-bv_1" || !renamed || len(moves) != 1 || moves[0] != (move{"2026-07-14_acme_1", "2026-07-15_acme-bv_1"}) ||
		m.entries["id-1"] != "2026-07-15_acme-bv_1" {
		t.Fatalf("%s %v", b, moves)
	}
}

func TestManifestPersistence(t *testing.T) {
	dir := t.TempDir()
	m := loadManifest(dir)
	if len(m.entries) != 0 {
		t.Fatal("fresh manifest")
	}
	m.set("id-b", "2026-07-14_b")
	m.set("id-a", "2026-07-14_a")
	if err := saveManifest(dir, m); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, ".manifest.json"))
	// Insertion order, two-space indent, no trailing newline: Bun's file.
	want := "{\n  \"version\": 1,\n  \"updated_at\": \"" + m.updatedAt + "\",\n  \"entries\": {\n    \"id-b\": \"2026-07-14_b\",\n    \"id-a\": \"2026-07-14_a\"\n  }\n}"
	if string(raw) != want {
		t.Fatalf("%q", raw)
	}
	if again := loadManifest(dir); strings.Join(again.ids, ",") != "id-b,id-a" || again.entries["id-a"] != "2026-07-14_a" {
		t.Fatalf("%#v", again)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("visible file %s", e.Name())
		}
	}
	for _, bad := range []string{"not json", "null", `{"version":2,"entries":{"a":"b"}}`, `{"version":1}`} {
		_ = os.WriteFile(filepath.Join(dir, ".manifest.json"), []byte(bad), 0o600)
		if len(loadManifest(dir).entries) != 0 {
			t.Fatalf("%q read as a manifest", bad)
		}
	}
}

// tests/plugins/falco/sync-plan.test.ts
func TestSyncPlan(t *testing.T) {
	plan := planDocumentWork
	if plan(true, true, true, false) != (workPlan{skip: true}) || plan(true, false, false, false) != (workPlan{skip: true}) {
		t.Fatal("fully on disk")
	}
	if plan(false, false, false, false) != (workPlan{}) || plan(false, false, true, false) != (workPlan{writePDF: true}) {
		t.Fatal("missing")
	}
	if plan(true, false, true, false) != (workPlan{reuseXML: true, writePDF: true}) {
		t.Fatal("reuse xml")
	}
	// A fresh XML re-renders its PDF even when one exists.
	if plan(false, true, true, false) != (workPlan{writePDF: true}) {
		t.Fatal("fresh xml")
	}
	if plan(true, true, true, true) != (workPlan{writePDF: true}) || plan(true, true, false, true) != (workPlan{}) {
		t.Fatal("force")
	}
	for _, x := range []bool{true, false} {
		for _, p := range []bool{true, false} {
			for _, e := range []bool{true, false} {
				for _, f := range []bool{true, false} {
					r := plan(x, p, e, f)
					if !e && r.writePDF || r.skip && (r.reuseXML || r.writePDF) || f && (r.skip || r.reuseXML) {
						t.Fatalf("%v %v %v %v -> %#v", x, p, e, f, r)
					}
				}
			}
		}
	}
}

func obj(t *testing.T, raw string) *jsvalue.Object {
	t.Helper()
	v, err := jsvalue.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*jsvalue.Object)
}

func objs(t *testing.T, raws ...string) []*jsvalue.Object {
	var out []*jsvalue.Object
	for _, r := range raws {
		out = append(out, obj(t, r))
	}
	return out
}

// tests/plugins/falco/mark-paid.test.ts
func TestResolveMarkPaidTarget(t *testing.T) {
	inv := `{"id":"inv-1","peppolInvoiceId":"pep-1","invoiceReference":"INV-1","paymentStatus":"NotPaid"}`
	pep := `{"id":"pep-2","documentNumber":"DT20261474","invoiceReference":"DT20261474","fiduciaryDocumentId":"fid-1","paymentReference":"+++123/456/789+++"}`
	r, err := resolveMarkPaidTarget("pep-1", objs(t, inv), objs(t, strings.Replace(pep, "pep-2", "pep-1", 1)))
	if err != nil || r.invoice == nil {
		t.Fatal("invoice register first")
	}
	for _, ref := range []string{"inv-1", "pep-1", "INV-1"} {
		if r, _ := resolveMarkPaidTarget(ref, objs(t, inv), nil); r.invoice == nil {
			t.Fatal(ref)
		}
	}
	for _, ref := range []string{"pep-2", "DT20261474", "fid-1", "+++123/456/789+++"} {
		if r, _ := resolveMarkPaidTarget(ref, objs(t, inv), objs(t, pep)); r.document == nil {
			t.Fatal(ref)
		}
	}
	_, err = resolveMarkPaidTarget("missing", objs(t, inv), objs(t, pep))
	if ae := apiErr(t, err); ae.code != "NOT_FOUND" || ae.message != `No invoice or Peppol document matches "missing"` {
		t.Fatalf("%#v", ae)
	}
	_, err = resolveMarkPaidTarget("INV-1", objs(t, strings.Replace(inv, "inv-1", "a", 1), strings.Replace(inv, "inv-1", "b", 1)), nil)
	if ae := apiErr(t, err); ae.code != "INVALID_PARAMS" ||
		ae.message != "\"INV-1\" matches 2 invoices:\n  INV-1  id=a  peppol=pep-1\n  INV-1  id=b  peppol=pep-1" {
		t.Fatalf("%#v", ae)
	}
	_, err = resolveMarkPaidTarget("DT20261474", nil, objs(t, strings.Replace(pep, "pep-2", "a", 1), `{"id":"b","documentNumber":"DT20261474"}`))
	if ae := apiErr(t, err); ae.code != "INVALID_PARAMS" ||
		ae.message != "\"DT20261474\" matches 2 Peppol documents:\n  DT20261474  id=a  fiduciary=fid-1\n  DT20261474  id=b  fiduciary=-" {
		t.Fatalf("%#v", ae)
	}
}

// tests/plugins/falco/peppol-import.test.ts
func TestResolveImportPeppolDocument(t *testing.T) {
	doc := `{"id":"pep-2","documentNumber":"DT20261474","invoiceReference":"DT20261474","fiduciaryDocumentId":"fid-1","paymentReference":"+++123/456/789+++","importState":"NotImported"}`
	for _, ref := range []string{"pep-2", "DT20261474", "fid-1", "+++123/456/789+++"} {
		if d, err := resolveImportPeppolDocument(ref, objs(t, doc)); err != nil || !is(d, "id", "pep-2") {
			t.Fatal(ref)
		}
	}
	_, err := resolveImportPeppolDocument("SAME", objs(t, `{"id":"a","invoiceReference":"SAME"}`, `{"id":"b","invoiceReference":"SAME","documentNumber":"OTHER"}`))
	if ae := apiErr(t, err); ae.code != "INVALID_PARAMS" ||
		ae.message != "\"SAME\" matches 2 Peppol documents:\n  SAME  id=a  state=-\n  SAME  id=b  state=-" ||
		ae.suggestion != "Re-run with the Peppol document id" {
		t.Fatalf("%#v", ae)
	}
	_, err = resolveImportPeppolDocument("missing", objs(t, doc))
	if ae := apiErr(t, err); ae.code != "NOT_FOUND" {
		t.Fatalf("%#v", ae)
	}
}

// tests/plugins/falco/naming.test.ts
func TestBasenames(t *testing.T) {
	base := `{"id":"7f2c1e90-1111-2222-3333-444455556666","documentNumber":"2026-0042","documentDate":"2026-07-14T00:00:00Z","downloadDate":null,"supplierName":"Acme BV","invoiceReference":null}`
	with := func(field, value string) *jsvalue.Object {
		o := obj(t, base)
		v, _ := jsvalue.Parse([]byte(value))
		o.Set(field, v)
		return o
	}
	cases := map[string]*jsvalue.Object{
		"2026-07-14_acme-bv_2026-0042":           obj(t, base),
		"2026-07-14_losson-associes_2026-0042":   with("supplierName", `"Losson & Associés"`),
		"2026-07-14_acme-bv_INV-2026-9":          with("invoiceReference", `"INV/2026/9"`),
		"2026-07-14_unknown_2026-0042":           with("supplierName", "null"),
		"0000-00-00_acme-bv_2026-0042":           with("documentDate", "null"),
		"2026-07-14_acme-bv_a-b-c-d-e-f-g-h-i-j": with("invoiceReference", `" a:b*c?d\"e<f>g|h\\i j "`),
	}
	noNumber := with("documentNumber", "null")
	cases["2026-07-14_acme-bv_7f2c1e90"] = noNumber
	download := with("documentDate", "null")
	download.Set("downloadDate", "2026-08-01T10:00:00Z")
	cases["2026-08-01_acme-bv_2026-0042"] = download
	for want, doc := range cases {
		if got := buildBasename(doc); got != want {
			t.Errorf("got %s want %s", got, want)
		}
	}
	if got := buildBasename(with("supplierName", `"`+strings.Repeat("abc ", 20)+`"`)); got != "2026-07-14_abc-abc-abc-abc-abc-abc-abc-abc-abc-abc_2026-0042" {
		t.Errorf("long supplier %s", got)
	}
	if uniqueBasename("a", func(string) bool { return false }) != "a" ||
		uniqueBasename("a", func(c string) bool { return c == "a" }) != "a_2" ||
		uniqueBasename("a", func(c string) bool { return c == "a" || c == "a_2" }) != "a_3" {
		t.Fatal("uniqueBasename")
	}
	bill := obj(t, `{"Id":"bill-0002-yyyy","Type":"CreditNote","DocumentNumber":7,"CreationDate":"2026-07-03T00:00:00","SendDate":null,"CustomerName":"Café Réunion"}`)
	if got := buildBillingBasename(bill); got != "2026-07-03_cafe-reunion_CN_7" {
		t.Fatal(got)
	}
	if slugifyOrganization("Acme BV") != "acme-bv" || slugifyOrganization("!!!") != "falco" ||
		slugifyOrganization("Société Générale") != "societe-generale" || slugifyOrganization(strings.Repeat("ab-", 40)) != strings.Repeat("ab-", 21)+"a" ||
		slugifyOrganization(strings.Repeat("a", 63)+"-b") != strings.Repeat("a", 63) {
		t.Fatal("slugifyOrganization")
	}
}

// tests/plugins/falco/output.test.ts
func TestDescribeInvoice(t *testing.T) {
	inv := `{"id":"inv-1","amount":"1210.00","invoiceCurrency":"EUR","invoiceReference":"INV-2026-0042","supplierName":"Acme BV"}`
	if got := describeInvoice(obj(t, inv)); got != "INV-2026-0042 (Acme BV, 1210.00 €)" {
		t.Fatal(got)
	}
	if got := describeInvoice(obj(t, strings.Replace(inv, `"EUR"`, `"USD"`, 1))); got != "INV-2026-0042 (Acme BV, 1210.00 USD)" {
		t.Fatal(got)
	}
	if got := describeInvoice(obj(t, strings.Replace(inv, `"INV-2026-0042"`, "null", 1))); !strings.HasPrefix(got, "inv-1 (") {
		t.Fatal(got)
	}
	if got := describeInvoice(obj(t, strings.Replace(inv, `"1210.00"`, "null", 1))); got != "INV-2026-0042 (Acme BV, —)" {
		t.Fatal(got)
	}
}

const testUBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ID>INV-2026-0042</cbc:ID>
  <cbc:IssueDate>2026-07-14</cbc:IssueDate>
  <cbc:DueDate>2026-08-13</cbc:DueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Acme BV</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>Kerkstraat 1</cbc:StreetName>
        <cbc:CityName>Gent</cbc:CityName>
        <cbc:PostalZone>9000</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>BE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>BE0123456789</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Losson &amp; Associ&#233;s</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cbc:PaymentID>RF18539007547034</cbc:PaymentID>
    <cac:PayeeFinancialAccount><cbc:ID>BE68539007547034</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1210.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">1210.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="HUR">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Consulting</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`

// tests/plugins/falco/ubl.test.ts
func TestUBLParsing(t *testing.T) {
	inv, err := parseUbl(testUBL)
	if err != nil {
		t.Fatal(err)
	}
	s := func(p *string) string { return deref(p, "<nil>") }
	if inv.number != "INV-2026-0042" || s(inv.issueDate) != "2026-07-14" || s(inv.dueDate) != "2026-08-13" || inv.currency != "EUR" ||
		inv.kind != "Invoice" || s(inv.customization) != "urn:cen.eu:en16931:2017" {
		t.Fatalf("header %#v", inv)
	}
	if s(inv.seller.name) != "Acme BV" || s(inv.seller.vatNumber) != "BE0123456789" || s(inv.seller.city) != "Gent" ||
		s(inv.buyer.name) != "Losson & Associés" {
		t.Fatalf("parties %#v %#v", inv.seller, inv.buyer)
	}
	if s(inv.totals.taxExclusiveAmount) != "1000.00" || s(inv.totals.taxInclusiveAmount) != "1210.00" || s(inv.totals.payableAmount) != "1210.00" {
		t.Fatalf("totals %#v", inv.totals)
	}
	if s(inv.payment.iban) != "BE68539007547034" || s(inv.payment.meansCode) != "30" || s(inv.payment.reference) != "RF18539007547034" ||
		s(inv.payment.referenceType) != "free" {
		t.Fatalf("payment %#v", inv.payment)
	}
	if len(inv.lines) != 1 || inv.lines[0].description != "Consulting" || inv.lines[0].quantity != "10" || inv.lines[0].unitPrice != "100.00" ||
		s(inv.lines[0].unitCode) != "HUR" || s(inv.lines[0].currency) != "EUR" {
		t.Fatalf("lines %#v", inv.lines)
	}
	credit, err := parseUbl(`<CreditNote><ID>C-1</ID><CreditNoteLine><CreditedQuantity>2</CreditedQuantity></CreditNoteLine></CreditNote>`)
	if err != nil || credit.kind != "CreditNote" || credit.currency != "EUR" || credit.lines[0].quantity != "2" {
		t.Fatalf("%#v %v", credit, err)
	}
	if _, err := parseUbl(`<Order><ID>1</ID></Order>`); err == nil || err.Error() != "Not a UBL Invoice or CreditNote document" {
		t.Fatal(err)
	}
}

// Bun decodes the download as UTF-8 whatever the XML declaration says, and
// fast-xml-parser does not validate: a bare &, an unknown entity, a control
// character or a stray closing tag is kept or skipped, never an error. The
// expected values are what Bun's parseUbl returns for the same bytes.
func TestUBLParsingIsLenientLikeFastXMLParser(t *testing.T) {
	invoice := func(seller string) string {
		return `<Invoice xmlns:cac="urn:cac" xmlns:cbc="urn:cbc"><cbc:ID>INV-1</cbc:ID><cac:AccountingSupplierParty><cac:Party>` +
			`<cac:PartyName><cbc:Name>` + seller + `</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty></Invoice>`
	}
	cases := []struct {
		name          string
		raw           []byte
		number        string
		seller        string
		sellerMissing bool
	}{
		{"latin-1 declaration", []byte("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?>\r\n" + invoice("Caf\xe9")), "INV-1", "Caf�", false},
		{"bare ampersand", []byte(invoice("Smith & Sons")), "INV-1", "Smith & Sons", false},
		{"entities", []byte(invoice("Caf&eacute; &euro; &nbsp;x &foo; &#233; &#x1; &#0; &#xD800; &#1114112; &#12ab; &amp;lt;")),
			"INV-1", "Caf&eacute; €  x &foo; é    &#1114112;  &lt;", false},
		{"byte order mark", []byte("\xef\xbb\xbf<?xml version=\"1.0\"?>" + invoice("BOM")), "INV-1", "BOM", false},
		{"line endings", []byte(invoice("Line1\r\nLine2\rLine3")), "INV-1", "Line1\nLine2\nLine3", false},
		{"control characters", []byte(invoice("A\x01B\x00C")), "INV-1", "A\x01B\x00C", false},
		{"stray closing tag", []byte(`<Invoice><ID>1</Wrong><Note>n</Note>`), "1", "", true},
		{"mixed content", []byte(`<Invoice><ID> a <b/> c </ID></Invoice>`), "ac", "", true},
		{"doctype entity", []byte(`<!DOCTYPE Invoice [<!ENTITY co "ACME">]><Invoice><ID>&co;</ID></Invoice>`), "ACME", "", true},
	}
	for _, c := range cases {
		inv, err := parseUbl(jsvalue.DecodeUTF8(c.raw))
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if inv.number != c.number || (inv.seller.name == nil) != c.sellerMissing || deref(inv.seller.name, "") != c.seller {
			t.Errorf("%s: number %q seller %q", c.name, inv.number, deref(inv.seller.name, "<nil>"))
		}
	}
}

func TestEmbeddedPDFExtraction(t *testing.T) {
	embed := func(attrs, body string) string {
		return strings.Replace(testUBL, "</Invoice>", `<cac:AdditionalDocumentReference><cac:Attachment>`+
			`<cbc:EmbeddedDocumentBinaryObject `+attrs+`>`+body+`</cbc:EmbeddedDocumentBinaryObject>`+
			`</cac:Attachment></cac:AdditionalDocumentReference></Invoice>`, 1)
	}
	payload := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))
	if extractEmbeddedPdf(testUBL) != nil {
		t.Fatal("nothing embedded")
	}
	found := extractEmbeddedPdf(embed(`mimeCode="application/pdf" filename="invoice.pdf"`, payload))
	if found == nil || deref(found.filename, "") != "invoice.pdf" || string(found.bytes) != "%PDF-1.4 fake" {
		t.Fatalf("%#v", found)
	}
	found = extractEmbeddedPdf(embed(`mimeCode="application/pdf"`, payload[:4]+"\n  "+payload[4:]))
	if found == nil || string(found.bytes) != "%PDF-1.4 fake" || found.filename != nil {
		t.Fatalf("%#v", found)
	}
	notPDF := base64.StdEncoding.EncodeToString([]byte("not-a-pdf"))
	// Either quote style is read, so a non-PDF never fails open.
	if extractEmbeddedPdf(embed(`mimeCode="image/png" filename="logo.png"`, notPDF)) != nil ||
		extractEmbeddedPdf(embed(`mimeCode='image/png' filename='logo.png'`, notPDF)) != nil {
		t.Fatal("non-PDF accepted")
	}
	if found := extractEmbeddedPdf(embed(`mimeCode='application/pdf' filename='invoice.pdf'`, payload)); deref(found.filename, "") != "invoice.pdf" {
		t.Fatal("single-quoted filename")
	}
	// Buffer.from(s, 'base64') semantics.
	for in, want := range map[string]string{"QUJD": "ABC", "QU$JD": "ABC", "QUJ": "AB", "QQ==QUJD": "A", "-_-_": "\xfb\xff\xbf", "$$$": "", "Q": ""} {
		if got := string(decodeBase64Lenient(in)); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestRenderingFollowsPdfLib(t *testing.T) {
	pdf, err := renderUblXMLToPdf(testUBL)
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatalf("%v", err)
	}
	// pdf-lib's standard fonts are WinAnsi; anything else fails the rendition.
	_, err = renderUblXMLToPdf(strings.Replace(testUBL, "Acme BV", "Acme ✓", 1))
	if err == nil || err.Error() != `WinAnsi cannot encode "✓" (0x2713)` {
		t.Fatalf("%v", err)
	}
	if enc, err := winAnsi("é€—…"); err != nil || enc != "\xe9\x80\x97\x85" {
		t.Fatalf("%q %v", enc, err)
	}
	for in, want := range map[string]string{"1210": "1210.00 EUR", "1.005": "1.00 EUR", "0.125": "0.13 EUR", " 7 ": "7.00 EUR", "abc": "abc EUR", "": "—"} {
		v := in
		if got := formatMoney(&v, "EUR"); got != want {
			t.Errorf("formatMoney(%q) = %q, want %q", in, got, want)
		}
	}
	d := "2026-07-14T00:00:00Z"
	if formatDate(&d) != "14/07/2026" || formatDate(nil) != "—" {
		t.Fatal("formatDate")
	}
}
