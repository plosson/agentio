package revolut

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
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

// Expected output strings below were printed by the Bun CLI against the same
// fixtures. Every key is a throwaway generated per test run.

var (
	keyOnce sync.Once
	testRSA *rsa.PrivateKey
	testPEM string
)

func throwawayKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	keyOnce.Do(func() {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		der, _ := x509.MarshalPKCS8PrivateKey(k)
		testRSA, testPEM = k, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	})
	return testRSA, testPEM
}

// hit is one request that reached the fake Revolut API.
type hit struct {
	Host, Method, Path, Auth, Accept, ContentType string
	Body                                          []byte
}

func (h hit) form(t *testing.T) url.Values {
	t.Helper()
	v, err := url.ParseQuery(string(h.Body))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

type fakeRevolut struct {
	mu     sync.Mutex
	hits   []hit
	handle func(w http.ResponseWriter, h hit)
}

func (f *fakeRevolut) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

func (f *fakeRevolut) calls() string {
	var out []string
	for _, h := range f.recorded() {
		out = append(out, h.Method+" "+h.Path)
	}
	return strings.Join(out, " | ")
}

type rewrite struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == "b2b.revolut.com" || req.URL.Host == "sandbox-b2b.revolut.com" {
		out := req.Clone(req.Context())
		out.URL.Scheme, out.URL.Host, out.Host = r.target.Scheme, r.target.Host, r.target.Host
		out.Header.Set("X-Orig-Host", req.URL.Host)
		return r.base.RoundTrip(out)
	}
	return nil, io.ErrUnexpectedEOF // nothing else may leave the test
}

// newFake stands in for both Revolut environments; paths keep the /api/1.0
// prefix off so assertions read like the Bun tests.
func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fakeRevolut {
	t.Helper()
	f := &fakeRevolut{handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		path := strings.TrimPrefix(r.URL.EscapedPath(), "/api/1.0")
		if r.URL.RawQuery != "" {
			path += "?" + r.URL.RawQuery
		}
		h := hit{
			Host: r.Header.Get("X-Orig-Host"), Method: r.Method, Path: path, Auth: r.Header.Get("Authorization"),
			Accept: r.Header.Get("Accept"), ContentType: r.Header.Get("Content-Type"), Body: raw,
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

func storedCreds(t *testing.T, expiry any) map[string]any {
	_, key := throwawayKey(t)
	return map[string]any{
		"environment":  "sandbox",
		"clientId":     "client-1",
		"privateKey":   key,
		"redirectUri":  "https://Example.test:8443/cb",
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
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
	return c.Credentials["revolut"][name]
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

func input(args, options map[string]any) plugins.CommandInput {
	if args == nil {
		args = map[string]any{}
	}
	if options == nil {
		options = map[string]any{}
	}
	return plugins.CommandInput{Args: args, Options: options}
}

// withDefaults adds the Bun default of every option not given, as the host does.
func withDefaults(t *testing.T, path string, in plugins.CommandInput) plugins.CommandInput {
	t.Helper()
	for _, o := range spec(t, path).Options {
		name := strings.TrimPrefix(strings.Fields(o.Flags)[0], "--")
		if _, given := in.Options[name]; !given && o.DefaultValue != nil {
			in.Options[name] = o.DefaultValue
		}
	}
	return in
}

func execCmd(t *testing.T, reg *plugins.Registry, path string, in plugins.CommandInput) (any, error) {
	t.Helper()
	return host.Execute(context.Background(), reg, reg.Find("revolut"), spec(t, path), withDefaults(t, path, in))
}

// runCmd runs a handler directly with the given credentials.
func runCmd(t *testing.T, path string, in plugins.CommandInput, configure func(*plugins.RunContext)) (any, error) {
	t.Helper()
	run := host.NewRunContext(storedCreds(t, farFuture()), "biz", context.Background())
	run.Confirm = func(q string) (bool, error) { t.Fatalf("unexpected prompt %q", q); return false, nil }
	if configure != nil {
		configure(run)
	}
	return host.Invoke(context.Background(), spec(t, path), withDefaults(t, path, in), run)
}

func render(t *testing.T, path string, v any) string {
	t.Helper()
	return spec(t, path).Format(v)
}

func cliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	ce, ok := err.(*clierr.Error)
	if !ok {
		t.Fatalf("want a clierr, got %#v", err)
	}
	return ce
}

func stringify(v any) string { return string(jsvalue.Stringify(v)) }

// The command table is the Bun surface. A renamed flag, a lost default, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct{ args, flags, access, op string }
	format := "--format <format>=text"
	want := map[string]row{
		"accounts":     {"", format, "read", ""},
		"transactions": {"", "--from <date> --to <date> --account <id> --counterparty <id> --type <type> --count <number>=100 --format <format>=text", "read", ""},
		"transaction":  {"<id>", format, "read", ""},
		"expenses":     {"", "--from <date> --to <date> --count <number>=100 --receipts <dir> --format <format>=text", "read", ""},
		"expense":      {"<id>", format, "read", ""},
		"receipt":      {"<expense-id>", "--receipt <id> --output <dir>=.", "read", ""},
		"pay": {"", "--from <account-id>! --to <id>! --amount <number>! --currency <code>! --reference <text> --to-account <id> --to-card <id> " +
			"--title <text> --on <date> --charge-bearer <who> --reason-code <code> --request-id <id> --force " + format, "write", "move money"},
		"counterparties list": {"", format, "read", ""},
		"counterparties get":  {"<id>", format, "read", ""},
		"counterparties add": {"", "--company-name <name> --first-name <name> --last-name <name> --bank-country <code>! --currency <code>! --iban <iban> " +
			"--bic <bic> --account-no <number> --sort-code <code> --routing-number <number> --email <email> --phone <phone>", "write", "add a counterparty"},
		"counterparties delete": {"<id>", "--force", "write", "delete a counterparty"},
		"drafts list":           {"", "--source <source>=api " + format, "read", ""},
		"drafts get":            {"<id>", format, "read", ""},
		"drafts delete":         {"<id>", "--force", "write", "delete a payment draft"},
		"links list":            {"", "--created-before <timestamp> --limit <number>=100 " + format, "read", ""},
		"links get":             {"<id>", format, "read", ""},
		"links cancel":          {"<id>", "--force", "write", "cancel a payout link"},
	}
	p := New()
	if p.ID != "revolut" || p.DisplayName != "Revolut" || p.Description != "Use when interacting with Revolut Business via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	// tests/plugins/registry.test.ts: revolut reauthenticates and has a lifecycle.
	if p.Profile.Reauthenticate == nil || p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken,privateKey" {
		t.Fatal("profile hooks")
	}
	var setupFlags []string
	for _, o := range p.Profile.SetupOptions {
		setupFlags = append(setupFlags, o.Flags)
	}
	if strings.Join(setupFlags, " ") != "--environment <env> --client-id <id> --private-key <path> --redirect-uri <uri>" {
		t.Fatalf("profile add flags %v", setupFlags)
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
			args = append(args, "<"+a.Name+">")
			if !a.Required {
				t.Errorf("%s: %s is required in Bun", c.Path, a.Name)
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
}

// --- setup, reauth, refresh ------------------------------------------------------------

func setupContext(prompts map[string]string, opened *[]string) *plugins.SetupContext {
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Prompt = func(q string, _ bool) (string, error) {
		if answer, ok := prompts[q]; ok {
			return answer, nil
		}
		return "", io.EOF
	}
	sc.OpenURL = func(u string) bool {
		if opened != nil {
			*opened = append(*opened, u)
		}
		return true
	}
	return sc
}

func accountsJSON() []any {
	return []any{
		map[string]any{"id": "acc-eur", "name": "Main", "balance": 10, "currency": "EUR", "state": "active", "public": false, "created_at": "c", "updated_at": "u"},
		map[string]any{"id": "acc-gbp", "balance": 1.005, "currency": "GBP", "state": "active", "public": true, "created_at": "c", "updated_at": "u"},
		map[string]any{"id": "acc-eur2", "name": "Spare", "balance": -0.5, "currency": "EUR", "state": "inactive", "public": false, "created_at": "c", "updated_at": "u"},
	}
}

// verifyAssertion checks the JWT Bun would build: header and payload bytes,
// the issuer taken from the redirect URI host, and a signature by the key.
func verifyAssertion(t *testing.T, key *rsa.PrivateKey, assertion, issuer, clientID string) {
	t.Helper()
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("assertion %q", assertion)
	}
	header, _ := base64.RawURLEncoding.DecodeString(parts[0])
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if string(header) != `{"alg":"RS256","typ":"JWT"}` {
		t.Fatalf("header %s", header)
	}
	var claims struct {
		Iss, Sub, Aud string
		Exp           int64
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	prefix := `{"iss":"` + issuer + `","sub":"` + clientID + `","aud":"https://revolut.com","exp":`
	if !strings.HasPrefix(string(payload), prefix) {
		t.Fatalf("payload %s", payload)
	}
	if d := claims.Exp - time.Now().Unix() - 3600; d > 5 || d < -5 {
		t.Fatalf("exp %d is not an hour out", claims.Exp)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatalf("signature: %v", err)
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	key, keyPEM := throwawayKey(t)
	// A certificate before the key, as a combined PEM file has it: OpenSSL
	// finds the key, and the file is stored byte for byte.
	dir := t.TempDir()
	certDER := makeCert(t, key)
	file := "\uFEFF" + string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})) + keyPEM
	keyPath := filepath.Join(dir, "combined.pem")
	if err := os.WriteFile(keyPath, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/auth/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "token_type": "bearer", "expires_in": 2400})
		case "/accounts":
			writeJSON(w, 200, accountsJSON())
		default:
			w.WriteHeader(404)
		}
	})
	var opened []string
	sc := setupContext(map[string]string{"? Paste the redirect URL (or just the code): ": " https://example.test/cb?code=c%2B1&state=x \n"}, &opened)
	var logged []string
	sc.Log = func(parts ...any) { logged = append(logged, parts[0].(string)) }
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	opts := plugins.SetupOptions{Options: map[string]any{
		"environment": "Prod", "client-id": " client-1 ", "private-key": keyPath, "redirect-uri": " https://Example.TEST:8443/cb ",
	}}
	if err := host.AddProfile(context.Background(), New(), opts, sc, &out); err != nil {
		t.Fatal(err)
	}
	if len(opened) != 1 || opened[0] != "https://business.revolut.com/app-confirm?client_id=client-1&redirect_uri=https%3A%2F%2FExample.TEST%3A8443%2Fcb&response_type=code" {
		t.Fatalf("consent url %v", opened)
	}
	hits := fake.recorded()
	token := hits[0]
	if token.Host != "b2b.revolut.com" || token.Method != "POST" || token.ContentType != "application/x-www-form-urlencoded" || token.Accept != "application/json" {
		t.Fatalf("token request %#v", token)
	}
	form := token.form(t)
	if !strings.HasPrefix(string(token.Body), "grant_type=authorization_code&code=c%2B1&client_id=client-1&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=") {
		t.Fatalf("token body %s", token.Body)
	}
	verifyAssertion(t, key, form.Get("client_assertion"), "example.test", "client-1")
	if acct := hits[1]; acct.Path != "/accounts" || acct.Auth != "Bearer at-1" {
		t.Fatalf("validation call %#v", acct)
	}

	// The suggested name is the environment, and the host saved it.
	stored := loadCreds(t, "production")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,clientId,environment,expiryDate,privateKey,redirectUri,refreshToken" {
		t.Fatalf("keys %v", keys)
	}
	if stored["environment"] != "production" || stored["clientId"] != "client-1" || stored["redirectUri"] != "https://Example.TEST:8443/cb" ||
		stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" || stored["privateKey"] != file {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiryDate"].(json.Number)
	if !ok {
		t.Fatalf("expiryDate is %T, want a JSON number", stored["expiryDate"])
	}
	if n, _ := exp.Int64(); n < before+2400_000 || n > time.Now().UnixMilli()+2400_000 {
		t.Fatalf("expiry %d", n)
	}
	if out.String() != "Profile \"production\" configured!\nTest with: agentio revolut accounts\n" {
		t.Fatalf("%q", out.String())
	}
	if last := logged[len(logged)-1]; last != "production - 3 account(s): EUR, GBP\n" {
		t.Fatalf("%q", logged)
	}
}

func makeCert(t *testing.T, key *rsa.PrivateKey) []byte {
	t.Helper()
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestSetupRefusalsMatchBunAndWriteNothing(t *testing.T) {
	setupVault(t)
	_, keyPEM := throwawayKey(t)
	dir := t.TempDir()
	good := filepath.Join(dir, "key.pem")
	notKey := filepath.Join(dir, "cert-only.pem")
	_ = os.WriteFile(good, []byte(keyPEM), 0o600)
	_ = os.WriteFile(notKey, []byte("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"), 0o600)
	missing := filepath.Join(dir, "missing.pem")
	var tokenBody map[string]any
	var tokenStatus int
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/auth/token" {
			writeJSON(w, tokenStatus, tokenBody)
			return
		}
		writeJSON(w, 401, map[string]any{"message": "bad token"})
	})
	paste := "? Paste the redirect URL (or just the code): "
	base := map[string]any{"environment": "sandbox", "client-id": "c", "private-key": good, "redirect-uri": "https://example.test/cb"}
	with := func(k string, v any) map[string]any {
		m := map[string]any{}
		for key, val := range base {
			m[key] = val
		}
		m[k] = v
		return m
	}
	cases := []struct {
		name                string
		options             map[string]any
		prompts             map[string]string
		status              int
		body                map[string]any
		code                clierr.Code
		message, suggestion string
	}{
		{"unknown environment", with("environment", "staging"), nil, 0, nil, clierr.InvalidParams, `Unknown environment "staging"`, "Use production or sandbox"},
		{"no client id", with("client-id", ""), map[string]string{"? Client ID: ": "   "}, 0, nil, clierr.InvalidParams, "Client ID is required", ""},
		{"no key path", with("private-key", ""), nil, 0, nil, clierr.InvalidParams, "Private key path is required", ""},
		{"key file missing", with("private-key", missing), nil, 0, nil, clierr.InvalidParams,
			"Could not read the private key: ENOENT: no such file or directory, open '" + missing + "'", ""},
		{"not a private key", with("private-key", notKey), nil, 0, nil, clierr.InvalidParams, `The file "` + notKey + `" is not a valid PEM private key`,
			"Point --private-key at the key you generated alongside the certificate uploaded to Revolut"},
		{"no scheme", with("redirect-uri", "example.test/cb"), nil, 0, nil, clierr.InvalidParams, `Redirect URI "example.test/cb" is not a valid URL`,
			"Use the full URI registered with Revolut, e.g. https://example.com/callback"},
		{"no host", with("redirect-uri", "https://"), nil, 0, nil, clierr.InvalidParams, `Redirect URI "https://" is not a valid URL`,
			"Use the full URI registered with Revolut, e.g. https://example.com/callback"},
		{"denied", base, map[string]string{paste: "https://example.test/cb?error=access_denied&code=x"}, 0, nil, clierr.AuthFailed, "Revolut denied the authorisation: access_denied", ""},
		{"no code in url", base, map[string]string{paste: "https://example.test/cb?state=1"}, 0, nil, clierr.InvalidParams,
			`No "code" parameter found in the pasted redirect URL`, "Copy the full URL from the browser address bar after approving access"},
		{"closed stdin", base, nil, 0, nil, clierr.InvalidParams, "Authorisation code is required", ""},
		{"no refresh token", base, map[string]string{paste: "c"}, 200, map[string]any{"access_token": "a", "expires_in": 1}, clierr.AuthFailed,
			"Revolut did not return a refresh token", "Authorisation codes are single-use and expire within two minutes - request a fresh one"},
		{"assertion rejected", base, map[string]string{paste: "c"}, 401, map[string]any{"error": "invalid_client"}, clierr.AuthFailed,
			`Revolut token request failed (401): {"error":"invalid_client"}` + "\n",
			"Check the client ID, the private key, and that the JWT issuer matches your registered redirect URI host"},
		{"accounts unreadable", base, map[string]string{paste: "c"}, 200, map[string]any{"access_token": "a", "refresh_token": "r", "expires_in": 1}, clierr.AuthFailed,
			`Could not read accounts: Revolut API error (401): {"message":"bad token"}` + "\n", ""},
	}
	for _, c := range cases {
		tokenStatus, tokenBody = c.status, c.body
		_, err := setup(context.Background(), plugins.SetupOptions{Options: c.options}, setupContext(c.prompts, nil))
		ce := cliErr(t, err)
		if ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Errorf("%s: %#v", c.name, ce)
		}
	}
	if got := fake.calls(); got != "POST /auth/token | POST /auth/token | POST /auth/token | GET /accounts" {
		t.Fatalf("refusals before the exchange must not call Revolut: %s", got)
	}
	c, _ := vault.Load()
	if len(c.Credentials["revolut"]) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

func TestReauthenticateKeepsTheConfigurationAndReplacesTokens(t *testing.T) {
	key, _ := throwawayKey(t)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/auth/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		writeJSON(w, 200, accountsJSON())
	})
	var opened []string
	sc := setupContext(map[string]string{"? Paste the redirect URL (or just the code): ": "code-2"}, &opened)
	got, err := reauth(context.Background(), storedCreds(t, int64(1)), "biz", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["legacyField"] != "kept" || got["clientId"] != "client-1" || got["accessToken"] != "at-2" || got["refreshToken"] != "rt-2" ||
		got["privateKey"] != storedCreds(t, 0)["privateKey"] {
		t.Fatalf("%#v", got)
	}
	if len(opened) != 1 || opened[0] != "https://sandbox-business.revolut.com/app-confirm?client_id=client-1&redirect_uri=https%3A%2F%2FExample.test%3A8443%2Fcb&response_type=code" {
		t.Fatalf("%v", opened)
	}
	token := fake.recorded()[0]
	if token.Host != "sandbox-b2b.revolut.com" || token.form(t).Get("code") != "code-2" {
		t.Fatalf("%#v", token)
	}
	verifyAssertion(t, key, token.form(t).Get("client_assertion"), "example.test", "client-1")

	_, err = reauth(context.Background(), nil, "biz", sc)
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed || ce.Message != "Revolut client configuration is missing" {
		t.Fatalf("%#v", ce)
	}
}

func TestStaleTokenRefreshesOnceAndKeepsTheRefreshToken(t *testing.T) {
	reg := setupVault(t)
	key, _ := throwawayKey(t)
	if err := profile.Save("revolut", "biz", storedCreds(t, int64(1)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	refreshes := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/auth/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			// Revolut does not rotate: a stray refresh_token is ignored, as in Bun.
			writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-ignored", "expires_in": 2400})
			return
		}
		writeJSON(w, 200, accountsJSON())
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(context.Background(), reg, "revolut", "biz", auth.RefreshOptions{})
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
	token := fake.recorded()[0]
	if !strings.HasPrefix(string(token.Body), "grant_type=refresh_token&refresh_token=rt-old&client_id=client-1&client_assertion_type=") {
		t.Fatalf("refresh request %q", token.Body)
	}
	verifyAssertion(t, key, token.form(t).Get("client_assertion"), "example.test", "client-1")
	stored := loadCreds(t, "biz")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-old" || stored["clientId"] != "client-1" ||
		stored["legacyField"] != "kept" || stored["privateKey"] != storedCreds(t, 0)["privateKey"] {
		t.Fatalf("%#v", stored)
	}
	if exp, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate %T", stored["expiryDate"])
	} else if n, _ := exp.Int64(); n < time.Now().UnixMilli()+2300_000 {
		t.Fatalf("expiry %d", n)
	}
	// The command then calls the API with the refreshed token and no second refresh.
	if _, err := execCmd(t, reg, "accounts", input(nil, nil)); err != nil {
		t.Fatal(err)
	}
	last := fake.recorded()[len(fake.recorded())-1]
	if last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestRefreshWithoutAnAccessTokenDropsTheKeyAndStoresNullExpiry(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, map[string]any{"token_type": "bearer"}) })
	got, err := refresh(context.Background(), storedCreds(t, int64(1)))
	if err != nil {
		t.Fatal(err)
	}
	// `{...credentials, accessToken: undefined, expiryDate: NaN}` stored by Bun.
	if _, has := got["accessToken"]; has {
		t.Fatalf("accessToken kept: %#v", got["accessToken"])
	}
	if v, has := got["expiryDate"]; !has || v != nil {
		t.Fatalf("expiryDate %#v", v)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("revolut", "biz", storedCreds(t, int64(1)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/auth/token" {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := execCmd(t, reg, "accounts", input(nil, nil))
	ce := cliErr(t, err)
	if ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for revolut profile "biz": Revolut token request failed (400): {"error":"invalid_grant"}` ||
		ce.Suggestion != "Re-authenticate with: agentio revolut profile add --profile biz" {
		t.Fatalf("%#v", ce)
	}
	stored := loadCreds(t, "biz")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if len(fake.recorded()) != 1 {
		t.Fatal(fake.calls())
	}
}

func TestABrokenKeyFailsTheRefreshWithBunsReason(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) { t.Errorf("no request may be sent: %s", h.Path) })
	creds := storedCreds(t, int64(1))
	creds["privateKey"] = "pem"
	_, err := refresh(context.Background(), creds)
	if err == nil || err.Error() != "Failed to sign the client assertion: error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE" {
		t.Fatalf("%v", err)
	}
}

func TestAnECKeySignsLikeNode(t *testing.T) {
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalECPrivateKey(ec)
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
	assertion, err := createClientAssertion("c", pemText, "https://h.test/cb")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(assertion, ".")
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.VerifyASN1(&ec.PublicKey, digest[:], sig) {
		t.Fatal("createSign('RSA-SHA256') with an EC key is a DER ECDSA signature")
	}
}

func TestStaleFollowsTheBunComparison(t *testing.T) {
	cases := []struct {
		name  string
		creds map[string]any
		want  bool
	}{
		{"missing expiry is stale", map[string]any{"refreshToken": "r"}, true},
		{"null expiry coerces to 0", map[string]any{"expiryDate": nil}, true},
		{"inside the buffer", map[string]any{"expiryDate": json.Number("1400")}, true},
		{"exactly at the buffer edge", map[string]any{"expiryDate": json.Number("1500")}, true},
		{"beyond the buffer", map[string]any{"expiryDate": json.Number("1501")}, false},
		{"a numeric string is compared as a number", map[string]any{"expiryDate": "1501"}, false},
		{"a string is NaN, never stale", map[string]any{"expiryDate": "soon"}, false},
	}
	for _, c := range cases {
		if got := stale(c.creds, 1000, 500); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
	if applies(map[string]any{"refreshToken": ""}) || applies(map[string]any{}) || applies(nil) || !applies(map[string]any{"refreshToken": "r"}) {
		t.Fatal("applies")
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := setupVault(t)
	if err := profile.Save("revolut", "ro", storedCreds(t, farFuture()), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	fake := newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, accountsJSON()) })
	valid := map[string]plugins.CommandInput{
		"pay":                   input(nil, map[string]any{"from": "acc-eur", "to": "acc-eur2", "amount": "5", "currency": "EUR", "force": true}),
		"counterparties add":    input(nil, map[string]any{"company-name": "X", "bank-country": "BE", "currency": "EUR", "iban": "BE00"}),
		"counterparties delete": input(map[string]any{"id": "cp-1"}, map[string]any{"force": true}),
		"drafts delete":         input(map[string]any{"id": "d-1"}, map[string]any{"force": true}),
		"links cancel":          input(map[string]any{"id": "l-1"}, map[string]any{"force": true}),
	}
	ops := map[string]string{
		"pay": "move money", "counterparties add": "add a counterparty", "counterparties delete": "delete a counterparty",
		"drafts delete": "delete a payment draft", "links cancel": "cancel a payout link",
	}
	for path, in := range valid {
		_, err := execCmd(t, reg, path, in)
		ce := cliErr(t, err)
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+ops[path]+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio revolut profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("a refused write reached the API: %s", fake.calls())
	}
	// Bun validates these inputs before enforceWriteAccess, so on a read-only
	// profile the input error wins, and nothing is sent either.
	invalid := []struct {
		path    string
		in      plugins.CommandInput
		message string
	}{
		{"pay", input(nil, map[string]any{"from": "a", "to": "b", "amount": "-5", "currency": "EUR"}), `--amount must be a positive number, got "-5"`},
		{"pay", input(nil, map[string]any{"from": "a", "to": "b", "amount": "5"}), "required option '--currency <code>' not specified"},
		{"counterparties add", input(nil, map[string]any{"first-name": "Jane", "bank-country": "BE", "currency": "EUR", "iban": "X"}), "A counterparty needs a name"},
	}
	for _, c := range invalid {
		_, err := execCmd(t, reg, c.path, c.in)
		if ce := cliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != c.message {
			t.Fatalf("%s: %#v", c.path, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("an invalid write reached the API: %s", fake.calls())
	}
	if _, err := execCmd(t, reg, "accounts", input(nil, nil)); err != nil {
		t.Fatal(err)
	}
	if fake.calls() != "GET /accounts" {
		t.Fatalf("read did not run: %s", fake.calls())
	}
}

func TestValidate(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if status != 200 {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, "unauthorised")
			return
		}
		writeJSON(w, 200, accountsJSON())
	})
	run := host.NewRunContext(storedCreds(t, int64(1)), "biz", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != "sandbox - 3 account(s): EUR, GBP" {
		t.Fatalf("%#v %v", res, err)
	}
	if h := fake.recorded()[0]; h.Host != "sandbox-b2b.revolut.com" || h.Path != "/accounts" || h.Auth != "Bearer at-old" || h.Accept != "application/json" {
		t.Fatalf("%#v", h)
	}
	status = 401
	res, err = validate(context.Background(), run)
	if err != nil || res.Valid || res.Error != "Revolut API error (401): unauthorised" {
		t.Fatalf("%#v %v", res, err)
	}
	status = 200
	fake.handle = func(w http.ResponseWriter, h hit) { writeJSON(w, 200, []any{}) }
	if res, _ := validate(context.Background(), run); res.Info != "sandbox - 0 account(s): no accounts" {
		t.Fatalf("%#v", res)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenAndThePrivateKey(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(t, int64(1))
	out := auth.RedactForRemote(reg, "revolut", creds)
	for _, secret := range []string{"refreshToken", "privateKey"} {
		if _, ok := out[secret]; ok {
			t.Fatalf("%s leaked to a remote caller", secret)
		}
		if _, ok := creds[secret]; !ok {
			t.Fatalf("%s removed from the caller's map", secret)
		}
	}
	if out["accessToken"] != "at-old" || out["clientId"] != "client-1" || out["environment"] != "sandbox" {
		t.Fatalf("%#v", out)
	}
	if listInfo(map[string]any{"environment": "sandbox"}) != " - sandbox" || listInfo(map[string]any{}) != " - undefined" || listInfo(nil) != "" {
		t.Fatal("listInfo")
	}
}

// --- tests/plugins/revolut/client.test.ts ----------------------------------------------

func TestCreateTransferSendsSourceAndTargetAccountIDs(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"id": "tx-3", "state": "completed", "created_at": "2026-09-06T10:00:00Z", "completed_at": "2026-09-06T10:00:01Z"})
	})
	c := newClient(context.Background(), storedCreds(t, 0), nil)
	res, err := c.createTransfer(transferInput{requestID: "req-3", sourceAccountID: "acc-1", targetAccountID: "acc-2", amount: 500, currency: "EUR", reference: "Top up"})
	if err != nil {
		t.Fatal(err)
	}
	h := fake.recorded()[0]
	if h.Method != "POST" || h.Path != "/transfer" || h.ContentType != "application/json" ||
		string(h.Body) != `{"request_id":"req-3","source_account_id":"acc-1","target_account_id":"acc-2","amount":500,"currency":"EUR","reference":"Top up"}` {
		t.Fatalf("%#v %s", h, h.Body)
	}
	if stringify(res) != `{"id":"tx-3","state":"completed","createdAt":"2026-09-06T10:00:00Z","completedAt":"2026-09-06T10:00:01Z"}` {
		t.Fatal(stringify(res))
	}
}

func TestPaymentDrafts(t *testing.T) {
	var reply any
	fake := newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, reply) })
	c := newClient(context.Background(), storedCreds(t, 0), nil)

	// The single payment is wrapped in a payments array; the draft ID comes back.
	reply = map[string]any{"id": "draft-1"}
	id, err := c.createPaymentDraft(draftInput{title: "October rent", scheduleFor: "2026-10-01", accountID: "acc-1", counterpartyID: "cp-1", amount: 1200, currency: "EUR", reference: "Rent"})
	if err != nil || id != "draft-1" {
		t.Fatalf("%v %v", id, err)
	}
	if h := fake.recorded()[0]; h.Path != "/payment-drafts" ||
		string(h.Body) != `{"payments":[{"account_id":"acc-1","receiver":{"counterparty_id":"cp-1"},"amount":1200,"currency":"EUR","reference":"Rent"}],"title":"October rent","schedule_for":"2026-10-01"}` {
		t.Fatalf("%s %s", h.Path, h.Body)
	}

	// List unwraps payment_orders and passes the source filter.
	reply = map[string]any{"payment_orders": []any{map[string]any{"id": "draft-1", "title": "Rent", "scheduled_for": "2026-10-01", "payments_count": 2, "source": "api"}}}
	drafts, err := c.listPaymentDrafts("all")
	if err != nil || fake.recorded()[1].Path != "/payment-drafts?source=all" ||
		stringify(values(drafts)) != `[{"id":"draft-1","title":"Rent","scheduledFor":"2026-10-01","paymentsCount":2,"source":"api"}]` {
		t.Fatalf("%s %v", stringify(values(drafts)), err)
	}

	// Get reads the amount out of its currency wrapper.
	reply = map[string]any{"title": "Rent", "payments": []any{map[string]any{
		"id": "pay-1", "amount": map[string]any{"amount": 123, "currency": "GBP"}, "account_id": "acc-1",
		"receiver": map[string]any{"counterparty_id": "cp-1"}, "state": "CREATED",
		"current_charge_options": map[string]any{
			"from": map[string]any{"amount": 123, "currency": "GBP"}, "to": map[string]any{"amount": 123, "currency": "GBP"},
			"rate": "1.0000", "fee": map[string]any{"amount": 0, "currency": "GBP"},
		},
	}}}
	draft, err := c.getPaymentDraft("draft 1")
	if err != nil || fake.recorded()[2].Path != "/payment-drafts/draft%201" ||
		stringify(draft) != `{"title":"Rent","payments":[{"id":"pay-1","amount":123,"currency":"GBP","accountId":"acc-1","counterpartyId":"cp-1","state":"CREATED",`+
			`"charge":{"fromAmount":123,"fromCurrency":"GBP","toAmount":123,"toCurrency":"GBP","rate":"1.0000","feeAmount":0,"feeCurrency":"GBP"}}]}` {
		t.Fatalf("%s %v", stringify(draft), err)
	}
}

func TestPayoutLinks(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if status == 204 {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, []any{map[string]any{
			"id": "link-1", "state": "active", "created_at": "2026-09-06T10:00:00Z", "updated_at": "2026-09-06T10:00:00Z",
			"counterparty_name": "Jane Doe", "request_id": "req-4", "account_id": "acc-1", "amount": 50, "currency": "EUR",
			"reference": "Expenses", "url": "https://pay.example.test/p/abc",
		}})
	})
	c := newClient(context.Background(), storedCreds(t, 0), nil)
	links, err := c.listPayoutLinks("", 10)
	if err != nil || fake.recorded()[0].Path != "/payout-links?limit=10" {
		t.Fatalf("%v %s", err, fake.calls())
	}
	// The absent fields default: no methods, not saved.
	if stringify(links[0]) != `{"id":"link-1","state":"active","createdAt":"2026-09-06T10:00:00Z","updatedAt":"2026-09-06T10:00:00Z","counterpartyName":"Jane Doe",`+
		`"saveCounterparty":false,"requestId":"req-4","payoutMethods":[],"accountId":"acc-1","amount":50,"currency":"EUR","url":"https://pay.example.test/p/abc","reference":"Expenses"}` {
		t.Fatal(stringify(links[0]))
	}
	// Cancel posts to the cancel path and tolerates an empty response.
	status = 204
	if err := c.cancelPayoutLink("link-1"); err != nil {
		t.Fatal(err)
	}
	if h := fake.recorded()[1]; h.Method != "POST" || h.Path != "/payout-links/link-1/cancel" || len(h.Body) != 0 || h.ContentType != "" {
		t.Fatalf("%#v", h)
	}
}

func TestExpenses(t *testing.T) {
	var reply any
	fake := newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, reply) })
	c := newClient(context.Background(), storedCreds(t, 0), nil)
	cases := []struct {
		name  string
		reply any
		want  string
	}{
		{"spent_amount, split category and receipt IDs", []any{map[string]any{
			"id": "exp-1", "state": "approved", "expense_date": "2026-08-14T09:30:00Z", "spent_amount": map[string]any{"amount": 42.5, "currency": "EUR"},
			"merchant": map[string]any{"name": "Coffee Bar"}, "splits": []any{map[string]any{"category": map[string]any{}}, map[string]any{"category": map[string]any{"name": "Meals"}}},
			"transaction_id": "tx-9", "receipt_ids": []any{"rec-1", "rec-2"},
		}}, `[{"id":"exp-1","state":"approved","expenseDate":"2026-08-14T09:30:00Z","amount":42.5,"currency":"EUR","category":"Meals","merchant":"Coffee Bar","transactionId":"tx-9","receiptIds":["rec-1","rec-2"]}]`},
		{"enveloped, with a missing receipt list", map[string]any{"expenses": []any{map[string]any{"id": "exp-2", "state": "awaiting_review"}}},
			`[{"id":"exp-2","state":"awaiting_review","receiptIds":[]}]`},
		{"bare numeric amount and a string merchant", []any{map[string]any{"id": "exp-3", "state": "approved", "amount": 12, "currency": "GBP", "merchant": "Taxi Co"}},
			`[{"id":"exp-3","state":"approved","amount":12,"currency":"GBP","merchant":"Taxi Co","receiptIds":[]}]`},
		{"spent_amount wins over a conflicting amount", []any{map[string]any{"id": "exp-5", "state": "approved",
			"spent_amount": map[string]any{"amount": 24.38, "currency": "GBP"}, "amount": map[string]any{"amount": 99, "currency": "EUR"}}},
			`[{"id":"exp-5","state":"approved","amount":24.38,"currency":"GBP","receiptIds":[]}]`},
		{"a non-numeric amount and an empty merchant are dropped; null is kept", []any{map[string]any{"id": "exp-6", "state": "s",
			"spent_amount": map[string]any{"amount": "12", "currency": nil}, "currency": "EUR", "merchant": "", "description": nil, "spender": "", "payer": map[string]any{"name": "", "last_name": "Solo"}}},
			`[{"id":"exp-6","state":"s","currency":"EUR","description":null,"spender":"Solo","receiptIds":[]}]`},
	}
	for _, tc := range cases {
		reply = tc.reply
		got, err := c.listExpenses("", "", 100)
		if err != nil || stringify(values(got)) != tc.want {
			t.Errorf("%s:\n got %s %v\nwant %s", tc.name, stringify(values(got)), err, tc.want)
		}
	}
	reply = []any{}
	if _, err := c.listExpenses("2026-08-01", "2026-08-31", 50); err != nil {
		t.Fatal(err)
	}
	if last := fake.recorded()[len(fake.recorded())-1]; last.Path != "/expenses?from=2026-08-01&to=2026-08-31&count=50" {
		t.Fatal(last.Path)
	}
	// Get builds the single-expense path and joins a split payer name.
	reply = map[string]any{"id": "exp 4", "state": "approved", "payer": map[string]any{"first_name": "Ada", "last_name": "Lovelace"}}
	e, err := c.getExpense("exp 4")
	if err != nil || fake.recorded()[len(fake.recorded())-1].Path != "/expenses/exp%204" || stringify(field(e, "spender")) != `"Ada Lovelace"` {
		t.Fatalf("%s %v", stringify(e), err)
	}
}

func TestReceipts(t *testing.T) {
	var headers map[string]string
	var body []byte
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		_, _ = w.Write(body)
	})
	c := newClient(context.Background(), storedCreds(t, 0), nil)
	cases := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{"named from the content type", map[string]string{"Content-Type": "application/pdf"}, "rec-1.pdf"},
		{"a parameterised, upper-case type", map[string]string{"Content-Type": " IMAGE/JPEG; charset=binary"}, "rec-1.jpg"},
		{"the Content-Disposition name wins", map[string]string{"Content-Type": "image/jpeg", "Content-Disposition": `attachment; filename="August lunch.jpg"`}, "August lunch.jpg"},
		{"RFC 5987 decoded, directory stripped", map[string]string{"Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd"}, "passwd"},
		{"a backslash path is stripped too", map[string]string{"Content-Disposition": `attachment; filename="..\..\win.ini"`}, "win.ini"},
		{"a malformed RFC 5987 name falls back to the plain one", map[string]string{"Content-Disposition": "attachment; filename*=UTF-8''%E0%A4%A; filename=\"plain.png\""}, "plain.png"},
		{"a name of .. is refused", map[string]string{"Content-Type": "image/png", "Content-Disposition": `attachment; filename=".."`}, "rec-1.png"},
		{"an unknown type is .bin", map[string]string{"Content-Type": "application/octet-stream"}, "rec-1.bin"},
		{"no type at all is .bin", nil, "rec-1.bin"},
	}
	body = []byte{1, 2, 3}
	for _, tc := range cases {
		headers = tc.headers
		r, err := c.getReceipt("exp-1", "rec-1")
		if err != nil || r.filename != tc.want || !bytes.Equal(r.data, body) {
			t.Errorf("%s: %q %v", tc.name, r.filename, err)
		}
	}
	if h := fake.recorded()[0]; h.Path != "/expenses/exp-1/receipts/rec-1/content" || h.Accept != "*/*" || h.Auth != "Bearer at-old" {
		t.Fatalf("%#v", h)
	}
	// A 403 explains the missing expenses permission.
	status, headers, body = 403, nil, []byte("nope")
	_, err := c.getReceipt("exp-1", "rec-1")
	ae, ok := err.(*apiError)
	if !ok || ae.code != "PERMISSION_DENIED" || ae.message != "Revolut API error (403): nope" ||
		ae.suggestion != "The Revolut API app needs read access to expenses; check its permissions in the Revolut Business app" {
		t.Fatalf("%#v", err)
	}
}

// --- commands ------------------------------------------------------------------------

func TestRequestFailuresFollowBun(t *testing.T) {
	var status int
	var reply string
	newFake(t, func(w http.ResponseWriter, h hit) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	})
	cases := []struct {
		status              int
		reply               string
		code                clierr.Code
		message, suggestion string
	}{
		{401, "expired", clierr.AuthFailed, "Revolut API error (401): expired", "Run: agentio revolut profile add to re-authorise"},
		{404, `{"message":"Transaction not found"}`, clierr.NotFound, `Revolut API error (404): {"message":"Transaction not found"}`, ""},
		{429, "", clierr.RateLimited, "Revolut API error (429): ", ""},
		{500, "boom", clierr.APIError, "Revolut API error (500): boom", ""},
	}
	for _, c := range cases {
		status, reply = c.status, c.reply
		_, err := runCmd(t, "transaction", input(map[string]any{"id": "tx-1"}, nil), nil)
		if ce := cliErr(t, err); ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Errorf("%d: %#v", c.status, ce)
		}
	}
	// A 200 that is not JSON fails as Response#json() does.
	status, reply = 200, ""
	if _, err := runCmd(t, "accounts", input(nil, nil), nil); err == nil || err.Error() != "Unexpected end of JSON input" {
		t.Fatalf("%v", err)
	}
	reply = "abc"
	if _, err := runCmd(t, "accounts", input(nil, nil), nil); err == nil || err.Error() != `JSON Parse error: Unexpected identifier "abc"` {
		t.Fatalf("%v", err)
	}
	for _, flag := range []string{"0", "abc", "-1"} {
		_, err := runCmd(t, "links list", input(nil, map[string]any{"limit": flag}), nil)
		if ce := cliErr(t, err); ce.Message != "--limit must be a positive number" {
			t.Fatalf("%s: %#v", flag, ce)
		}
		_, err = runCmd(t, "transactions", input(nil, map[string]any{"count": flag}), nil)
		if ce := cliErr(t, err); ce.Message != "--count must be a positive number" {
			t.Fatalf("%s: %#v", flag, ce)
		}
	}
}

func TestListCommandsSendTheBunQueries(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if strings.HasPrefix(h.Path, "/payment-drafts") {
			writeJSON(w, 200, map[string]any{})
			return
		}
		writeJSON(w, 200, []any{})
	})
	runs := []struct {
		path string
		in   plugins.CommandInput
	}{
		{"transactions", input(nil, map[string]any{"from": "2026-08-01", "to": "a b&c", "account": "acc", "counterparty": "cp", "type": "card_payment", "count": "07abc"})},
		{"transactions", input(nil, nil)},
		{"expenses", input(nil, map[string]any{"to": "2026-09-30"})},
		{"drafts list", input(nil, nil)},
		{"drafts list", input(nil, map[string]any{"source": ""})},
		{"links list", input(nil, map[string]any{"created-before": "2026-07-11T13:55:54Z", "limit": "3"})},
		{"transaction", input(map[string]any{"id": "tx 1/ü"}, nil)},
		{"counterparties get", input(map[string]any{"id": "cp?1"}, nil)},
		{"links get", input(map[string]any{"id": "l#1"}, nil)},
	}
	for _, r := range runs {
		if _, err := runCmd(t, r.path, r.in, nil); err != nil {
			t.Fatalf("%s: %v", r.path, err)
		}
	}
	want := "GET /transactions?from=2026-08-01&to=a+b%26c&counterparty=cp&account=acc&type=card_payment&count=7 | GET /transactions?count=100 | " +
		"GET /expenses?to=2026-09-30&count=100 | GET /payment-drafts?source=api | GET /payment-drafts | " +
		"GET /payout-links?created_before=2026-07-11T13%3A55%3A54Z&limit=3 | GET /transaction/tx%201%2F%C3%BC | GET /counterparty/cp%3F1 | GET /payout-links/l%231"
	if got := fake.calls(); got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
}

func TestCounterpartyAddSendsOnlyWhatWasGiven(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"id": "cp-new", "name": "Jane Doe", "state": "created", "created_at": "2026-09-01T00:00:00Z", "accounts": []any{}})
	})
	res, err := runCmd(t, "counterparties add", input(nil, map[string]any{
		"company-name": "", "first-name": "Jane", "last-name": "Doe", "bank-country": "GB", "currency": "GBP", "account-no": "1234", "sort-code": "000000", "iban": "",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if h := fake.recorded()[0]; h.Method != "POST" || h.Path != "/counterparty" ||
		string(h.Body) != `{"bank_country":"GB","currency":"GBP","individual_name":{"first_name":"Jane","last_name":"Doe"},"account_no":"1234","sort_code":"000000"}` {
		t.Fatalf("%s", h.Body)
	}
	// add has no --format: Bun always prints the counterparty.
	if got := render(t, "counterparties add", res); got != "ID: cp-new\nName: Jane Doe\nState: created\nCreated: 2026-09-01T00:00:00Z" {
		t.Fatalf("%q", got)
	}
	cases := []struct {
		options             map[string]any
		message, suggestion string
	}{
		{map[string]any{"bank-country": "GB", "currency": "GBP", "iban": "X", "last-name": "Doe"}, "A counterparty needs a name", "Pass --company-name, or both --first-name and --last-name"},
		{map[string]any{"bank-country": "GB", "currency": "GBP", "company-name": "X"}, "Pass --iban or --account-no", ""},
		{map[string]any{"currency": "GBP", "company-name": "X", "iban": "X"}, "required option '--bank-country <code>' not specified", ""},
	}
	for _, c := range cases {
		_, err := runCmd(t, "counterparties add", input(nil, c.options), nil)
		if ce := cliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%#v", ce)
		}
	}
	if len(fake.recorded()) != 1 {
		t.Fatal(fake.calls())
	}
}

// payFake serves accounts, counterparties, drafts and transfers.
func payFake(t *testing.T) *fakeRevolut {
	return newFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Path == "/accounts":
			writeJSON(w, 200, accountsJSON())
		case h.Path == "/counterparty/cp-missing":
			writeJSON(w, 404, map[string]any{"message": "nope"})
		case strings.HasPrefix(h.Path, "/counterparty/"):
			writeJSON(w, 200, map[string]any{"id": "cp-1", "name": "Acme BV", "state": "created"})
		case h.Path == "/payment-drafts":
			writeJSON(w, 200, map[string]any{"id": "draft-new"})
		case h.Path == "/transfer":
			writeJSON(w, 200, map[string]any{"id": "tr-1", "state": "completed", "created_at": "2026-09-06T10:00:00Z"})
		default:
			t.Errorf("unexpected %s %s", h.Method, h.Path)
		}
	})
}

func TestPayToACounterpartyOnlyEverDrafts(t *testing.T) {
	fake := payFake(t)
	res, err := runCmd(t, "pay", input(nil, map[string]any{
		"from": "acc-eur", "to": "cp-1", "amount": "1e3", "currency": " eur ", "reference": "Rent", "title": "October rent", "on": "2026-10-01",
		"charge-bearer": " Debtor ", "reason-code": "R1", "to-account": "cpa-1", "to-card": "card-1",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := fake.calls(); got != "GET /accounts | GET /counterparty/cp-1 | POST /payment-drafts" {
		t.Fatalf("a counterparty payment must never call /transfer: %s", got)
	}
	if body := string(fake.recorded()[2].Body); body != `{"payments":[{"account_id":"acc-eur","receiver":{"counterparty_id":"cp-1","account_id":"cpa-1","card_id":"card-1"},`+
		`"amount":1000,"currency":"EUR","reference":"Rent","charge_bearer":"debtor","transfer_reason_code":"R1"}],"title":"October rent","schedule_for":"2026-10-01"}` {
		t.Fatal(body)
	}
	if got := render(t, "pay", res); got != "Drafted 1000.00 EUR to Acme BV, scheduled for 2026-10-01, from \"Main\"\nDraft ID: draft-new\n"+
		"Nothing has moved yet - approve it in the Revolut Business app to send it." {
		t.Fatalf("%q", got)
	}
	res, _ = runCmd(t, "pay", input(nil, map[string]any{"from": "acc-gbp", "to": "cp-1", "amount": "5", "currency": "GBP", "reference": "x", "format": "json"}), nil)
	if got := render(t, "pay", res); got != "{\n  \"id\": \"draft-new\"\n}" {
		t.Fatalf("%q", got)
	}
}

func TestPayRefusalsFollowBun(t *testing.T) {
	fake := payFake(t)
	base := map[string]any{"from": "acc-eur", "to": "acc-eur2", "amount": "5", "currency": "EUR"}
	with := func(kv ...string) map[string]any {
		m := map[string]any{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	cases := []struct {
		options             map[string]any
		code                clierr.Code
		message, suggestion string
		calls               string
	}{
		{with("amount", "0"), clierr.InvalidParams, `--amount must be a positive number, got "0"`, "", ""},
		{with("amount", "Infinity"), clierr.InvalidParams, `--amount must be a positive number, got "Infinity"`, "", ""},
		{with("on", "2026-1-01"), clierr.InvalidParams, `--on must be a date as YYYY-MM-DD, got "2026-1-01"`, "", ""},
		{with("charge-bearer", "sha"), clierr.InvalidParams, `Unknown charge bearer "sha"`, "Use shared (SHA, fees split) or debtor (OUR, you pay all fees)", ""},
		{with("from", "acc-nope"), clierr.NotFound, `--from "acc-nope" is not one of your accounts`, "Run: agentio revolut accounts", "GET /accounts"},
		{with("to-card", "x"), clierr.InvalidParams, "--to-account and --to-card only apply to counterparty payments", "", "GET /accounts"},
		{with("reason-code", "R"), clierr.InvalidParams, "--charge-bearer and --reason-code only apply to counterparty payments", "", "GET /accounts"},
		{with("title", "t"), clierr.InvalidParams, "--on and --title only apply to counterparty payments",
			`"acc-eur2" is your own account, so the money moves immediately and there is no draft to schedule or name`, "GET /accounts"},
		{with("to", "acc-gbp"), clierr.InvalidParams,
			`Moving money between your own accounts needs a single currency: "Main" holds EUR, acc-gbp holds GBP, and --currency is EUR`,
			"Exchange the funds in the Revolut Business app first", "GET /accounts"},
		{with("to", "cp-1"), clierr.InvalidParams, "A payment draft requires --reference", "", "GET /accounts"},
		{with("to", "cp-missing", "reference", "x"), clierr.NotFound, `Revolut API error (404): {"message":"nope"}` + "\n", "", "GET /accounts | GET /counterparty/cp-missing"},
	}
	for _, c := range cases {
		before := len(fake.recorded())
		_, err := runCmd(t, "pay", input(nil, c.options), nil)
		ce := cliErr(t, err)
		var calls []string
		for _, h := range fake.recorded()[before:] {
			calls = append(calls, h.Method+" "+h.Path)
		}
		if ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion || strings.Join(calls, " | ") != c.calls {
			t.Errorf("%v: %#v %v", c.options, ce, calls)
		}
	}
}

func TestOwnAccountMoveAsksFirstAndACancelMovesNothing(t *testing.T) {
	fake := payFake(t)
	in := func(extra ...string) plugins.CommandInput {
		o := map[string]any{"from": "acc-eur", "to": "acc-eur2", "amount": "5", "currency": "EUR"}
		for i := 0; i < len(extra); i += 2 {
			o[extra[i]] = extra[i+1]
		}
		return input(nil, o)
	}
	question := `Move 5.00 EUR from "Main" to "Spare" (your own account)?`
	// Declined: "Cancelled" on stderr, no transfer.
	var logged, asked []string
	res, err := runCmd(t, "pay", in(), func(run *plugins.RunContext) {
		run.Confirm = func(q string) (bool, error) { asked = append(asked, q); return false, nil }
		run.Log = func(parts ...any) { logged = append(logged, parts[0].(string)) }
	})
	if err != nil || res != nil || strings.Join(asked, "") != question || strings.Join(logged, "") != "Cancelled" {
		t.Fatalf("%#v %v %q %q", res, err, asked, logged)
	}
	// An answer that cannot be read: nothing moves and nothing is printed.
	res, err = runCmd(t, "pay", in(), func(run *plugins.RunContext) {
		run.Confirm = func(string) (bool, error) { return false, errors.New("read failed") }
		run.Log = func(parts ...any) { t.Fatalf("logged %v on a failed read", parts) }
	})
	if err != nil || res != nil || strings.Contains(fake.calls(), "/transfer") {
		t.Fatalf("%#v %v %s", res, err, fake.calls())
	}
	// Accepted: one transfer with a generated UUID request ID.
	res, err = runCmd(t, "pay", in("reference", "Top up"), func(run *plugins.RunContext) {
		run.Confirm = func(string) (bool, error) { return true, nil }
	})
	if err != nil {
		t.Fatal(err)
	}
	transfer := fake.recorded()[len(fake.recorded())-1]
	var body map[string]any
	_ = json.Unmarshal(transfer.Body, &body)
	id, _ := body["request_id"].(string)
	if transfer.Path != "/transfer" || len(id) != 36 || id[14] != '4' || strings.IndexByte("89ab", id[19]) < 0 ||
		!strings.HasSuffix(string(transfer.Body), `"source_account_id":"acc-eur","target_account_id":"acc-eur2","amount":5,"currency":"EUR","reference":"Top up"}`) {
		t.Fatalf("%s", transfer.Body)
	}
	if got := render(t, "pay", res); got != "Move 5.00 EUR from \"Main\" to \"Spare\" (your own account)\nID: tr-1\nState: completed\nCreated: 2026-09-06T10:00:00Z" {
		t.Fatalf("%q", got)
	}
	// --force skips the prompt and a given request ID is trimmed.
	input := in("request-id", " req-1 ")
	input.Options["force"] = true
	if _, err := runCmd(t, "pay", input, nil); err != nil {
		t.Fatal(err)
	}
	if last := fake.recorded()[len(fake.recorded())-1]; !strings.HasPrefix(string(last.Body), `{"request_id":"req-1",`) {
		t.Fatalf("%s", last.Body)
	}
}

func TestDestructiveCommandsAskWithBunsQuestion(t *testing.T) {
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Method != "GET":
			w.WriteHeader(204)
		case strings.HasPrefix(h.Path, "/counterparty/"):
			writeJSON(w, 200, map[string]any{"id": "cp-1", "name": "Acme BV"})
		case strings.HasPrefix(h.Path, "/payment-drafts/"):
			writeJSON(w, 200, map[string]any{"payments": []any{map[string]any{}, map[string]any{}}})
		default:
			writeJSON(w, 200, map[string]any{"amount": 7.125, "currency": "GBP", "counterparty_name": "Bob"})
		}
	})
	cases := []struct{ path, id, question, done, call string }{
		{"counterparties delete", "cp-1", `Delete counterparty "Acme BV" (cp-1)?`, "Deleted counterparty: cp-1", "DELETE /counterparty/cp-1"},
		{"drafts delete", "d 1", "Delete payment draft d 1 (2 payment(s))?", "Deleted payment draft: d 1", "DELETE /payment-drafts/d%201"},
		{"links cancel", "l-1", "Cancel the 7.13 GBP payout link to Bob?", "Cancelled payout link: l-1", "POST /payout-links/l-1/cancel"},
	}
	for _, c := range cases {
		for _, answer := range []bool{false, true} {
			before := len(fake.recorded())
			var asked []string
			res, err := runCmd(t, c.path, input(map[string]any{"id": c.id}, nil), func(run *plugins.RunContext) {
				run.Confirm = func(q string) (bool, error) { asked = append(asked, q); return answer, nil }
				run.Log = func(...any) {}
			})
			if err != nil || strings.Join(asked, "") != c.question {
				t.Fatalf("%s: %v %q", c.path, err, asked)
			}
			last := fake.recorded()[len(fake.recorded())-1]
			if !answer {
				if res != nil || len(fake.recorded()) != before+1 {
					t.Fatalf("%s: a declined prompt acted: %s", c.path, fake.calls())
				}
				continue
			}
			if last.Method+" "+last.Path != c.call || render(t, c.path, res) != c.done {
				t.Fatalf("%s: %s %q", c.path, last.Path, render(t, c.path, res))
			}
		}
		// --force skips the lookup and the question.
		before := len(fake.recorded())
		if _, err := runCmd(t, c.path, input(map[string]any{"id": c.id}, map[string]any{"force": true}), nil); err != nil {
			t.Fatal(err)
		}
		if len(fake.recorded()) != before+1 {
			t.Fatalf("%s --force: %s", c.path, fake.calls())
		}
	}
}

func TestReceiptDownloadsAndReportsWhatWasWritten(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/expenses/exp-1":
			writeJSON(w, 200, map[string]any{"id": "exp-1", "state": "approved", "receipt_ids": []any{"rec-1", "rec-2", "rec-3"}})
		case "/expenses/exp-1/receipts/rec-1/content":
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write(bytes.Repeat([]byte{7}, 1536))
		case "/expenses/exp-1/receipts/rec-2/content":
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''..%2Frec-1.pdf")
			_, _ = w.Write([]byte{1, 2, 3})
		default:
			w.WriteHeader(403)
			_, _ = io.WriteString(w, "forbidden")
		}
	})
	dir := filepath.Join(t.TempDir(), "new", "dir")
	res, err := runCmd(t, "receipt", input(map[string]any{"expense-id": "exp-1"}, map[string]any{"output": dir}), nil)
	// rec-3 fails after two files were written: those stay printed, then the error.
	if ce := cliErr(t, err); ce.Code != clierr.PermissionDenied || ce.Message != "Revolut API error (403): forbidden" {
		t.Fatalf("%#v", ce)
	}
	want := "Downloading 3 receipt(s)...\n\nDownloaded: rec-1.pdf\n  Path: " + dir + "/rec-1.pdf\n  Size: 1.5 KB\n\n" +
		"Downloaded: rec-1-2.pdf\n  Path: " + dir + "/rec-1-2.pdf\n  Size: 3 B\n"
	if got := render(t, "receipt", res); got != want {
		t.Fatalf("\n got %q\nwant %q", got, want)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "rec-1-2.pdf")); !bytes.Equal(b, []byte{1, 2, 3}) {
		t.Fatal("deduplicated file not written")
	}
	// One named receipt; an unknown one is NOT_FOUND before any download.
	res, err = runCmd(t, "receipt", input(map[string]any{"expense-id": "exp-1"}, map[string]any{"receipt": "rec-2", "output": dir}), nil)
	if err != nil || render(t, "receipt", res) != "Downloaded: rec-1.pdf\n  Path: "+dir+"/rec-1.pdf\n  Size: 3 B" {
		t.Fatalf("%v %q", err, render(t, "receipt", res))
	}
	_, err = runCmd(t, "receipt", input(map[string]any{"expense-id": "exp-1"}, map[string]any{"receipt": "nope"}), nil)
	if ce := cliErr(t, err); ce.Code != clierr.NotFound || ce.Message != `Expense exp-1 has no receipt "nope"` || ce.Suggestion != "Run: agentio revolut expense exp-1" {
		t.Fatalf("%#v", ce)
	}
	// A single failing receipt prints nothing before the error.
	res, err = runCmd(t, "receipt", input(map[string]any{"expense-id": "exp-1"}, map[string]any{"receipt": "rec-3"}), nil)
	if res != nil || err == nil {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestExpensesReceiptsExportsToStderrAndKeepsGoing(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		switch h.Path {
		case "/expenses?count=100":
			writeJSON(w, 200, []any{
				map[string]any{"id": "e1", "state": "s", "receipt_ids": []any{"r1", "bad"}},
				map[string]any{"id": "e2", "state": "s"},
				map[string]any{"id": "e3", "state": "s", "receipt_ids": []any{"r1"}},
			})
		case "/expenses/e1/receipts/bad/content":
			w.WriteHeader(500)
			_, _ = io.WriteString(w, "boom")
		default:
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF"))
		}
	})
	dir := filepath.Join(t.TempDir(), "q3")
	var logged []string
	res, err := runCmd(t, "expenses", input(nil, map[string]any{"receipts": dir, "format": "csv"}), func(run *plugins.RunContext) {
		run.Log = func(parts ...any) { logged = append(logged, parts[0].(string)) }
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(logged, "\n") != "Failed to download receipt bad of expense e1: Revolut API error (500): boom\nDownloaded 2 receipt(s) to "+dir+", 1 failed" {
		t.Fatalf("%q", logged)
	}
	for _, name := range []string{"e1-r1.pdf", "e3-r1.pdf"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.HasPrefix(render(t, "expenses", res), "date,expense_id,") {
		t.Fatal(render(t, "expenses", res))
	}
	logged = nil
	_, _ = runCmd(t, "expenses", input(nil, map[string]any{"receipts": dir}), func(run *plugins.RunContext) {
		run.Log = func(parts ...any) { logged = append(logged, parts[0].(string)) }
	})
	newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, []any{map[string]any{"id": "e", "state": "s"}}) })
	logged = nil
	_, _ = runCmd(t, "expenses", input(nil, map[string]any{"receipts": dir}), func(run *plugins.RunContext) {
		run.Log = func(parts ...any) { logged = append(logged, parts[0].(string)) }
	})
	if strings.Join(logged, "") != "No receipts to download" {
		t.Fatalf("%q", logged)
	}
}

// --- output ------------------------------------------------------------------------

func fromJSON(t *testing.T, raw string) any {
	t.Helper()
	v, err := jsvalue.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestFormatMatchesBun(t *testing.T) {
	accounts := mapAll(fromJSON(t, `[
		{"id":"acc-eur","name":"Main EUR","balance":1234.5,"currency":"EUR","state":"active"},
		{"id":"acc-gbp","balance":1.005,"currency":"GBP","state":"active"},
		{"id":"acc-eur2","name":"Épargne \"réserve\"","balance":-0.5,"currency":"EUR","state":"inactive"},
		{"id":"acc-usd","name":null,"balance":1e21,"currency":"USD","state":"active"}]`), mapAccount)
	want := "Accounts (4)\n\nacc-eur | Main EUR\n    Balance: 1234.50 EUR\n\nacc-gbp | (unnamed)\n    Balance: 1.00 GBP\n\n" +
		"acc-eur2 | Épargne \"réserve\" [inactive]\n    Balance: -0.50 EUR\n\nacc-usd | (unnamed)\n    Balance: 1e+21 USD\n\n" +
		"Total: 1234.00 EUR | 1.00 GBP | 1e+21 USD"
	if got := accountListText(accounts); got != want {
		t.Fatalf("accounts\n%q\n%q", got, want)
	}

	tx := mapTransaction(fromJSON(t, `{"id":"tx-1","type":"card_payment","state":"completed","reference":"Lunch, \"team\"","created_at":"2026-08-01T10:00:00Z",
		"completed_at":"2026-08-02T11:00:00Z","legs":[{"leg_id":"leg-1","account_id":"acc-eur","amount":-12.345,"currency":"EUR","bill_amount":-10,
		"bill_currency":"GBP","description":"Café\nBar","balance":1222.155,"counterparty":{"id":"cp-9","type":"external"}}],
		"merchant":{"name":"Café Bar","city":"Brussels","category_code":"5812","country":"BE"},"card":{"first_name":"Ada","last_name":""}}`))
	want = "ID: tx-1\nType: card_payment\nState: completed\nCreated: 2026-08-01T10:00:00Z\nCompleted: 2026-08-02T11:00:00Z\nReference: Lunch, \"team\"\n" +
		"Card holder: Ada\nMerchant: Café Bar (Brussels, BE)\nCategory: 5812\n---\n\n[Leg leg-1]\nAccount: acc-eur\nAmount: -12.35 EUR\nBilled: -10.00 GBP\n" +
		"Balance after: 1222.15 EUR\nDescription: Café\nBar\nCounterparty: cp-9 (external)"
	if got := transactionText(tx); got != want {
		t.Fatalf("transaction\n%q\n%q", got, want)
	}
	tx2 := mapTransaction(fromJSON(t, `{"id":"tx-2","type":"transfer","state":"pending","created_at":"2026-08-03T10:00:00Z","legs":[
		{"leg_id":"leg-2a","account_id":"acc-eur","amount":100,"currency":"EUR","counterparty":{"account_id":"x"}},
		{"leg_id":"leg-2b","account_id":"acc-gbp","amount":-85.1,"currency":"GBP","description":"fx"}]}`))
	want = "date,transaction_id,leg_id,type,state,amount,currency,description,merchant,reference,account_id,counterparty_id\n" +
		"2026-08-02T11:00:00Z,tx-1,leg-1,card_payment,completed,-12.35,EUR,\"Café\nBar\",Café Bar,\"Lunch, \"\"team\"\"\",acc-eur,cp-9\n" +
		"2026-08-03T10:00:00Z,tx-2,leg-2a,transfer,pending,100.00,EUR,,,,acc-eur,\n" +
		"2026-08-03T10:00:00Z,tx-2,leg-2b,transfer,pending,-85.10,GBP,fx,,,acc-gbp,"
	if got := transactionsCSV([]*jsvalue.Object{tx, tx2}); got != want {
		t.Fatalf("csv\n%q\n%q", got, want)
	}

	expenses := mapAll(fromJSON(t, `[
		{"id":"exp-1","state":"approved","expense_date":"2026-08-14T09:30:00Z","spent_amount":{"amount":42.5,"currency":"EUR"},"merchant":{"name":"Coffee, Bar"},
		 "splits":[{"category":{}},{"category":{"name":"Meals"}}],"transaction_id":"tx-9","payer":{"first_name":"Ada","last_name":"Lovelace"},"receipt_ids":["rec-1","rec-2"]},
		{"id":"exp-2","state":"awaiting_review"},
		{"id":"exp-3","state":"approved","amount":12,"currency":"GBP","merchant":"Taxi Co","completed_at":"2026-08-15T00:00:00Z","spender":"Bob","description":"ride \"home\"","receipt_ids":["rec-3"]},
		{"id":"exp-4","state":"approved","spent_amount":{"amount":24.38,"currency":"GBP"},"amount":{"amount":99,"currency":"EUR"},"category":"Travel","merchant":"","receipt_ids":["rec-bad"]}]`), mapExpense)
	want = "Expenses (4)\n\n2026-08-14 | 42.50 EUR | approved\n    Coffee, Bar\n    Receipts: 2\n    ID: exp-1\n\n- | - | awaiting_review\n    Receipts: none\n    ID: exp-2\n\n" +
		"2026-08-15 | 12.00 GBP | approved\n    Taxi Co\n    Receipts: 1\n    ID: exp-3\n\n- | 24.38 GBP | approved\n    Travel\n    Receipts: 1\n    ID: exp-4\n\n3 of 4 have a receipt"
	if got := expenseListText(expenses); got != want {
		t.Fatalf("expenses\n%q\n%q", got, want)
	}
	want = "date,expense_id,state,amount,currency,merchant,category,description,spender,transaction_id,receipt_count,receipt_ids\n" +
		"2026-08-14T09:30:00Z,exp-1,approved,42.50,EUR,\"Coffee, Bar\",Meals,,Ada Lovelace,tx-9,2,rec-1 rec-2\n" +
		",exp-2,awaiting_review,,,,,,,,0,\n2026-08-15T00:00:00Z,exp-3,approved,12.00,GBP,Taxi Co,,\"ride \"\"home\"\"\",Bob,,1,rec-3\n" +
		",exp-4,approved,24.38,GBP,,Travel,,,,1,rec-bad"
	if got := expensesCSV(expenses); got != want {
		t.Fatalf("expenses csv\n%q\n%q", got, want)
	}
	if got := expenseText(expenses[0]); got != "ID: exp-1\nState: approved\nDate: 2026-08-14T09:30:00Z\nAmount: 42.50 EUR\nMerchant: Coffee, Bar\n"+
		"Category: Meals\nSpender: Ada Lovelace\nTransaction: tx-9\nReceipts (2):\n  rec-1\n  rec-2\n\nDownload them with: agentio revolut receipt exp-1" {
		t.Fatalf("%q", got)
	}

	draft := jsvalue.NewObject()
	raw := fromJSON(t, `{"title":"October rent","scheduled_for":"2026-10-01","source":"api","payments":[
		{"id":"pay-1","amount":{"amount":1200,"currency":"EUR"},"account_id":"acc-eur","receiver":{"counterparty_id":"cp-1","account_id":"cpa-1"},"state":"CREATED","reference":"Rent",
		 "current_charge_options":{"from":{"amount":1200,"currency":"EUR"},"to":{"amount":1030.5,"currency":"GBP"},"rate":"0.8588","fee":{"amount":0.3,"currency":"EUR"}}},
		{"id":"pay-2","account_id":"acc-gbp","state":"FAILED","reason":"no funds","error_message":"Insufficient","current_charge_options":{"rate":"1.0","from":{"currency":"GBP"},"to":{"currency":"GBP"}}}]}`)
	put(draft, "title", field(raw, "title"))
	put(draft, "scheduledFor", field(raw, "scheduled_for"))
	put(draft, "source", field(raw, "source"))
	draft.Set("payments", values(mapAll(field(raw, "payments"), mapDraftPayment)))
	want = "ID: draft-1\nTitle: October rent\nScheduled for: 2026-10-01\nSource: api\n\n[Payment pay-1]\nAmount: 1200.00 EUR\nState: CREATED\nFrom account: acc-eur\n" +
		"Counterparty: cp-1\nCounterparty account: cpa-1\nReference: Rent\nRate: 0.8588\nFee: 0.30 EUR\n\n[Payment pay-2]\nAmount: 0.00\nState: FAILED\n" +
		"From account: acc-gbp\nReason: no funds\nError: Insufficient"
	if got := draftText("draft-1", draft); got != want {
		t.Fatalf("draft\n%q\n%q", got, want)
	}

	link := mapPayoutLink(fromJSON(t, `{"id":"link-1","state":"active","created_at":"2026-07-11T13:55:54.834963Z","counterparty_name":"Jane Doe","account_id":"acc-eur",
		"amount":50,"currency":"EUR","reference":"Expenses","url":"https://pay.example.test/p/abc","expiry_date":"2026-07-18T00:00:00Z","payout_methods":["revolut","bank_account"],"save_counterparty":true}`))
	want = "ID: link-1\nState: active\nRecipient: Jane Doe\nAmount: 50.00 EUR\nReference: Expenses\nURL: https://pay.example.test/p/abc\nFrom account: acc-eur\n" +
		"Payout methods: revolut, bank_account\nSave counterparty: yes\nExpires: 2026-07-18T00:00:00Z\nCreated: 2026-07-11T13:55:54.834963Z"
	if got := payoutLinkText(link); got != want {
		t.Fatalf("link\n%q\n%q", got, want)
	}

	for text, fn := range map[string]func() string{
		"No accounts found":       func() string { return accountListText(nil) },
		"No transactions found":   func() string { return transactionListText(nil) },
		"No expenses found":       func() string { return expenseListText(nil) },
		"No counterparties found": func() string { return counterpartyListText(nil) },
		"No payment drafts found": func() string { return draftListText(nil) },
		"No payout links found":   func() string { return payoutLinkListText(nil) },
	} {
		if got := fn(); got != text {
			t.Errorf("%q != %q", got, text)
		}
	}
	for n, want := range map[int]string{0: "0 B", 3: "3 B", 1536: "1.5 KB", 1024 * 1024: "1 MB", 1100: "1.1 KB"} {
		if got := formatBytes(n); got != want {
			t.Errorf("formatBytes(%d) = %q, want %q", n, got, want)
		}
	}

	// --format json and the host's --json are the same value; text is Bun's printer.
	v := &view{value: values(accounts), asJSON: true, text: func() string { return "text" }}
	if got := formatView(v); !strings.HasPrefix(got, "[\n  {\n    \"id\": \"acc-eur\",\n    \"name\": \"Main EUR\",\n    \"balance\": 1234.5,") ||
		!strings.Contains(got, "\"name\": null,\n    \"balance\": 1e+21,") {
		t.Fatalf("%s", got)
	}
	if raw, _ := v.MarshalJSON(); !strings.HasPrefix(string(raw), `[{"id":"acc-eur","name":"Main EUR","balance":1234.5,"currency":"EUR","state":"active"},{"id":"acc-gbp","balance":1.005,`) {
		t.Fatalf("%s", raw)
	}
}

// Bun's response.arrayBuffer() rejects when the connection drops mid-body, so
// nothing is written and the plain TypeError reaches handleError.
func TestACutDownloadFailsLikeBunAndWritesNothing(t *testing.T) {
	testbox.Isolate(t)
	newFake(t, func(w http.ResponseWriter, h hit) {
		expense := map[string]any{"id": "exp-1", "state": "approved", "receipt_ids": []any{"rec-1"}}
		switch {
		case h.Path == "/expenses/exp-1":
			writeJSON(w, 200, expense)
		case strings.HasPrefix(h.Path, "/expenses?"):
			writeJSON(w, 200, []any{expense})
		default:
			testbox.CutShort(t, w, 200)
		}
	})
	dir := t.TempDir()
	res, err := runCmd(t, "receipt", input(map[string]any{"expense-id": "exp-1"}, map[string]any{"output": dir}), nil)
	if _, isCli := err.(*clierr.Error); isCli {
		t.Fatalf("%#v", err)
	}
	testbox.WantSocketClosed(t, err)
	if res != nil {
		t.Fatalf("%q", render(t, "receipt", res))
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("a truncated receipt was saved: %v", entries)
	}
	// The bulk export reports the receipt as failed and writes nothing.
	var logged []string
	_, err = runCmd(t, "expenses", input(nil, map[string]any{"receipts": dir}), func(run *plugins.RunContext) {
		run.Log = func(parts ...any) { logged = append(logged, fmt.Sprint(parts...)) }
	})
	if err != nil || !slices.Contains(logged, "Failed to download receipt rec-1 of expense exp-1: "+plugins.BunSocketClosed) {
		t.Fatalf("%v %q", err, logged)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("a truncated receipt was saved: %v", entries)
	}
}

// Bun reads the token response with response.text(), which rejects on a cut
// connection: a plain error, not "unexpected token response".
func TestACutTokenResponseFailsLikeBun(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) { testbox.CutShort(t, w, 200) })
	_, err := postTokenRequest(context.Background(), plugins.Fetch, "production", jsvalue.NewSearchParams())
	if _, isAPI := err.(*apiError); isAPI {
		t.Fatalf("%#v", err)
	}
	testbox.WantSocketClosed(t, err)
}
