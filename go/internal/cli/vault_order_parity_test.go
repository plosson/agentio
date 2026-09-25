package cli

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/daemon"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Go must write the vault Bun writes: every level of the document, every
// credential object, key for key and byte for byte. Each case seeds one
// vault (keys out of alphabetical order at every level, nested objects,
// members Go does not model, strings JSON.stringify leaves unescaped), runs
// the same change through the Bun code and through the Go code, and compares
// the two decrypted documents. Token endpoints, userinfo and webhooks are a
// local mock on both sides; the Bun side runs under `bun test` with its
// prompts, browser and OAuth callback replaced. Only the expiry numbers the
// two clocks compute are masked.

const parityPassphrase = "parity-pass-123"

// bunOrderHarness runs one scenario through the Bun code. Every request goes
// to the mock, which is told the host it was meant for.
const bunOrderHarness = `
import { mock, test } from 'bun:test';
const ROOT = process.env.AGENTIO_ROOT!;
const MOCK = process.env.MOCK_URL!;
const S = JSON.parse(process.env.SCENARIO!);
const src = (p: string) => ROOT + '/src/' + p;

const realFetch = globalThis.fetch.bind(globalThis);
async function mockFetch(input: any, init?: any): Promise<Response> {
  const req = new Request(input, init);
  const u = new URL(req.url);
  if (u.origin === MOCK) return realFetch(req);
  const headers = new Headers(req.headers);
  headers.set('x-mock-host', u.host);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  return realFetch(MOCK + u.pathname + u.search, { method: req.method, headers, body });
}
globalThis.fetch = mockFetch as typeof fetch;
mock.module('node-fetch', () => ({ default: mockFetch, Headers, Request, Response }));

const answer = (q: string): string => {
  for (const [re, a] of S.answers) if (new RegExp(re, 'i').test(q)) return a;
  throw new Error('unscripted prompt: ' + q);
};
const pick = (m: string): number => {
  for (const [re, i] of S.selects) if (new RegExp(re, 'i').test(m)) return i;
  throw new Error('unscripted select: ' + m);
};
const stdin = await import(src('utils/stdin.ts'));
mock.module(src('utils/stdin.ts'), () => ({ ...stdin, prompt: async (q: string) => answer(q), confirm: async () => true, readStdin: async () => null }));
const interactive = await import(src('utils/interactive.ts'));
mock.module(src('utils/interactive.ts'), () => ({
  ...interactive,
  isInteractive: () => true,
  interactiveSelect: async (o: any) => o.choices[pick(o.message)].value,
  interactiveInput: async (o: any) => answer(o.message),
  interactiveConfirm: async () => true,
}));
const oauth = await import(src('auth/oauth-server.ts'));
mock.module(src('auth/oauth-server.ts'), () => ({
  ...oauth,
  findAvailablePort: async () => 3000,
  launchBrowser: () => true,
  awaitOAuthCode: async (c: any) => ({ code: 'code-' + S.service, state: new URL(c.authUrl).searchParams.get('state') ?? undefined }),
}));
const falcoPrompts = await import(src('plugins/falco/prompts.ts'));
mock.module(src('plugins/falco/prompts.ts'), () => ({
  ...falcoPrompts,
  promptText: async (m: string) => answer(m),
  promptPassword: async (m: string) => answer(m),
  promptChoice: async (m: string, choices: any[]) => choices[pick(m)].value,
}));

test('scenario', async () => {
  const { findServicePlugin } = await import(src('plugins/registry.ts'));
  switch (S.op) {
    case 'add': {
      const { addProfileFromPlugin } = await import(src('plugins/profile-host.ts'));
      await addProfileFromPlugin(findServicePlugin(S.service)!, { ...S.bunOptions });
      break;
    }
    case 'refresh': {
      const { getFreshCredentials } = await import(src('auth/refresh.ts'));
      const r = await getFreshCredentials(S.service, S.profile, { force: true });
      if (!r.refreshed) throw new Error('not refreshed');
      break;
    }
    case 'reauth': {
      const { reauthProfile } = await import(src('commands/reauth.ts'));
      await reauthProfile(S.service, S.profile);
      break;
    }
    case 'rename': {
      const { renameProfile } = await import(src('config/profile-store.ts'));
      const outcome = await renameProfile(S.service, S.profile, S.to);
      if (outcome !== 'ok') throw new Error('rename: ' + outcome);
      break;
    }
    case 'update': {
      const { setProfileReadOnly } = await import(src('config/config-manager.ts'));
      if (!(await setProfileReadOnly(S.service, S.profile, S.readOnly))) throw new Error('no profile');
      break;
    }
    case 'remove': {
      const { deleteProfile } = await import(src('config/profile-store.ts'));
      if (!(await deleteProfile(S.service, S.profile))) throw new Error('no profile');
      break;
    }
    case 'touch': {
      const { listApiKeys, touchApiKey } = await import(src('auth/api-keys.ts'));
      await touchApiKey((await listApiKeys())[0]);
      break;
    }
    case 'keepalive': {
      const { runRefreshPass } = await import(src('daemon/keepalive.ts'));
      const r = await runRefreshPass();
      console.error('keepalive', JSON.stringify(r));
      break;
    }
    default:
      throw new Error('unknown op ' + S.op);
  }
}, 60000);
`

// orderScenario is one change applied to one seeded vault.
type orderScenario struct {
	Service string `json:"service"`
	Op      string `json:"op"`
	Profile string `json:"profile,omitempty"`
	To      string `json:"to,omitempty"`
	// ReadOnly is the value `profile update` sets.
	ReadOnly bool `json:"readOnly"`
	// Answers are [pattern, answer] pairs for prompts; Selects [pattern, index].
	Answers [][2]any `json:"answers"`
	Selects [][2]any `json:"selects"`
	// BunOptions and GoOptions are the same setup flags in each CLI's form.
	BunOptions map[string]any `json:"bunOptions"`
	GoOptions  map[string]any `json:"-"`
	// Mode tells the mock which variant of the token response to send.
	Mode string `json:"-"`
	// Stored is the target profile's credential object in the seed.
	Stored *jsvalue.Object `json:"-"`
	// Unchanged is set when both sides are expected to leave the vault as seeded.
	Unchanged bool `json:"-"`
}

func (s orderScenario) name() string {
	parts := []string{s.Service, s.Op}
	if s.Mode != "" {
		parts = append(parts, s.Mode)
	}
	return strings.Join(parts, "/")
}

// seedDocument is the vault both CLIs start from. Nothing in it is in
// alphabetical order, and it carries what Go does not model.
func seedDocument(s orderScenario) *jsvalue.Object {
	svc := s.Service
	stored := s.Stored
	if stored == nil {
		stored = jsvalue.ObjectOf("zeta", "z", "alpha", jsvalue.ObjectOf("y", 1, "x", []any{jsvalue.ObjectOf("q", 2, "p", 1)}))
	}
	credentials := jsvalue.ObjectOf(
		"zeta", jsvalue.ObjectOf("z1", jsvalue.ObjectOf("b", "&<> ", "a", jsvalue.ObjectOf("y", 1, "x", []any{jsvalue.ObjectOf("q", 2, "p", 1)}))),
		svc, jsvalue.ObjectOf(
			"work", stored,
			"bare", jsvalue.ObjectOf("token", "t&t", "note", "keep"),
		),
	)
	profiles := jsvalue.ObjectOf(
		"zeta", []any{jsvalue.ObjectOf("note", "x", "name", "z1")},
		svc, []any{
			jsvalue.ObjectOf("extra", jsvalue.ObjectOf("b", 1, "a", 2), "name", "work", "readOnly", false),
			"bare",
		},
	)
	config := jsvalue.ObjectOf(
		"server", jsvalue.ObjectOf("z", 1, "a", 2),
		"profiles", profiles,
		"apiKeys", []any{jsvalue.ObjectOf(
			"name", "k", "id", "k1", "secretHash", "h", "hint", "abcd",
			"allowedProfiles", []any{svc + "/work", svc + "/bare"},
			"readOnly", false, "createdAt", "2026-01-01T00:00:00.000Z", "canAddProfiles", true, "future", jsvalue.ObjectOf("b", []any{1, "é"}, "a", nil),
		)},
	)
	return jsvalue.ObjectOf(
		"credentials", credentials,
		"version", 1,
		"zzTop", jsvalue.ObjectOf("b", 1, "a", "é"),
		"config", config,
	)
}

// orderMock answers every provider the services talk to, on the host the
// request was meant for (x-mock-host), as that provider's API would.
type orderMock struct {
	mu   sync.Mutex
	mode string
	srv  *httptest.Server
	t    *testing.T
}

func (m *orderMock) setMode(mode string) {
	m.mu.Lock()
	m.mode = mode
	m.mu.Unlock()
}

func (m *orderMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	mode := m.mode
	m.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	hostName := r.Header.Get("x-mock-host")
	grant := ""
	if form, err := url.ParseQuery(string(body)); err == nil {
		grant = form.Get("grant_type")
	}
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) == nil {
		if g, ok := parsed["grant_type"].(string); ok {
			grant = g
		}
	}
	reply := func(v string) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, v)
	}
	switch {
	case hostName == "oauth2.googleapis.com" && r.URL.Path == "/token":
		if grant == "authorization_code" {
			reply(`{"access_token":"ya29.new","expires_in":3599,"refresh_token":"1//new-refresh","scope":"openid email","token_type":"Bearer","id_token":"x.y.z"}`)
			return
		}
		switch mode {
		case "rotate":
			reply(`{"access_token":"ya29.refreshed","expires_in":3599,"refresh_token":"1//rotated","scope":"openid email","token_type":"Bearer"}`)
		case "noexpiry":
			reply(`{"access_token":"ya29.refreshed","token_type":"Bearer"}`)
		default:
			reply(`{"access_token":"ya29.refreshed","expires_in":3599,"scope":"openid email","token_type":"Bearer"}`)
		}
	case hostName == "www.googleapis.com" && r.URL.Path == "/oauth2/v2/userinfo":
		reply(`{"id":"1","email":"ada@example.com","verified_email":true}`)
	case hostName == "chat.googleapis.com" && r.Method == http.MethodPost:
		reply(`{"name":"spaces/AAA/messages/1"}`)
	case hostName == "chat.googleapis.com":
		reply(`{"spaces":[]}`)
	case hostName == "auth.atlassian.com" && r.URL.Path == "/oauth/token":
		switch {
		case grant == "authorization_code":
			reply(`{"access_token":"at-new","refresh_token":"rt-new","expires_in":3600,"scope":"read:jira-work offline_access","token_type":"Bearer"}`)
		case mode == "rotate":
			reply(`{"access_token":"at-refreshed","refresh_token":"rt-rotated","expires_in":3600,"token_type":"Bearer"}`)
		default:
			reply(`{"access_token":"at-refreshed","expires_in":3600,"token_type":"Bearer"}`)
		}
	case hostName == "api.atlassian.com" && r.URL.Path == "/oauth/token/accessible-resources":
		reply(`[{"id":"cloud-1","url":"https://one.atlassian.net","name":"one","scopes":["read:jira-work"]},{"id":"cloud-2","url":"https://two.atlassian.net","name":"two","scopes":["read:jira-work"]}]`)
	case hostName == "github.com" && r.URL.Path == "/login/oauth/access_token":
		reply(`{"access_token":"gho_new","token_type":"bearer","scope":"repo"}`)
	case hostName == "api.github.com" && r.URL.Path == "/user":
		reply(`{"login":"octocat","id":1,"email":null}`)
	case hostName == "api.dropboxapi.com" && r.URL.Path == "/oauth2/token":
		if grant == "authorization_code" {
			reply(`{"access_token":"sl.new","token_type":"bearer","expires_in":14400,"refresh_token":"db-refresh","scope":"files.metadata.read","uid":"1","account_id":"dbid:TOKEN"}`)
			return
		}
		reply(`{"access_token":"sl.refreshed","token_type":"bearer","expires_in":14400}`)
	case hostName == "api.dropboxapi.com" && r.URL.Path == "/2/users/get_current_account":
		reply(`{"account_id":"dbid:ACCOUNT","name":{"display_name":"Ada"},"email":"ada@example.com","email_verified":true,"account_type":{".tag":"basic"}}`)
	case strings.HasSuffix(hostName, "b2b.revolut.com") && r.URL.Path == "/api/1.0/auth/token":
		if grant == "authorization_code" {
			reply(`{"access_token":"oa_new","token_type":"bearer","expires_in":2399,"refresh_token":"oa_refresh"}`)
			return
		}
		reply(`{"access_token":"oa_refreshed","token_type":"bearer","expires_in":2399}`)
	case strings.HasSuffix(hostName, "b2b.revolut.com") && r.URL.Path == "/api/1.0/accounts":
		reply(`[{"id":"a1","name":"Main","balance":10,"currency":"EUR","state":"active","public":false,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]`)
	case hostName == "accounts.horus-software.be" && (r.URL.Path == "/login" || r.URL.Path == "/oauth2/token"):
		reply(`{"access_token":"f-at","refresh_token":"f-rt-` + grant + `","expires_in":3600,"refresh_token_expires_in":2592000,"token_type":"Bearer"}`)
	case hostName == "accounts.horus-software.be" && r.URL.Path == "/revoke-refresh-token":
		reply(`{}`)
	case hostName == "api.my-falco.be" && r.URL.Path == "/user/me":
		reply(`{"id":"u1","email":"ada@example.com","firstName":"Ada","lastName":"L","organizations":[{"id":"org-1","name":"Acme BV","vatNumber":"BE1"},{"id":"org-2","name":"Other","vatNumber":null}]}`)
	case hostName == "hooks.slack.com":
		_, _ = io.WriteString(w, "ok")
	case hostName == "" && r.URL.Path == "/categories.json":
		reply(`{"category_list":{"categories":[{"id":1,"name":"General","slug":"general","topic_count":1,"post_count":1,"description":null}]}}`)
	default:
		m.t.Errorf("mock: unexpected %s %s%s", r.Method, hostName, r.URL.Path)
		http.Error(w, "unexpected", http.StatusNotFound)
	}
}

// rewrite sends every Go request to the mock, as the Bun harness does.
type rewrite struct{ mock *url.URL }

func (rw rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	out := req.Clone(req.Context())
	if req.URL.Host != rw.mock.Host {
		out.Header.Set("x-mock-host", req.URL.Host)
		out.URL.Scheme = rw.mock.Scheme
		out.URL.Host = rw.mock.Host
		out.Host = rw.mock.Host
	}
	return (&http.Transport{}).RoundTrip(out)
}

type orderEnv struct {
	root, mockURL, bin, tmp, sqlite, keyPath string
	mock                                     *orderMock
}

func newOrderEnv(t *testing.T) *orderEnv {
	t.Helper()
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("bun is not installed")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	m := &orderMock{t: t}
	m.srv = httptest.NewServer(m)
	t.Cleanup(m.srv.Close)
	tmp := t.TempDir()
	// A no-op browser opener first on PATH, for anything that would open one.
	bin := filepath.Join(tmp, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"open", "xdg-open"} {
		shim := "#!/bin/sh\ntouch " + filepath.Join(tmp, "opened") + "\n"
		if err := os.WriteFile(filepath.Join(bin, name), []byte(shim), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(tmp, "revolut.pem")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "harness.test.ts"), []byte(bunOrderHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	prev := http.DefaultTransport
	mockURL, _ := url.Parse(m.srv.URL)
	http.DefaultTransport = rewrite{mock: mockURL}
	t.Cleanup(func() { http.DefaultTransport = prev })
	return &orderEnv{root: root, mockURL: m.srv.URL, bin: bin, tmp: tmp, sqlite: filepath.Join(tmp, "parity.db"), keyPath: keyPath, mock: m}
}

// seedHome writes the seed document, encrypted, as the vault of home.
func seedHome(t *testing.T, home, plaintext string) string {
	t.Helper()
	dir := filepath.Join(home, ".config", "agentio")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "vault.enc")
	enc, err := vault.Encrypt(plaintext, parityPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(enc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "vault.path"), []byte(path+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func decryptVaultFile(t *testing.T, path string) string {
	t.Helper()
	enc, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := vault.Decrypt(string(enc), parityPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}

// clockFields are the numbers each CLI computes from its own clock.
var clockFields = regexp.MustCompile(`"(expiryDate|expiry_date|refreshExpiryDate)":\d+`)

func maskClock(s string) string { return clockFields.ReplaceAllString(s, `"$1":0`) }

func (e *orderEnv) runBun(t *testing.T, s orderScenario, home string) {
	t.Helper()
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bun", "test", filepath.Join(e.tmp, "harness.test.ts"))
	cmd.Dir = e.root
	cmd.Env = []string{
		"HOME=" + home, "TMPDIR=" + os.TempDir(), "PATH=" + e.bin + string(os.PathListSeparator) + os.Getenv("PATH"),
		"AGENTIO_PASSPHRASE=" + parityPassphrase, "AGENTIO_ROOT=" + e.root, "MOCK_URL=" + e.mockURL,
		"SCENARIO=" + string(raw), "AGENTIO_KEEPALIVE_HOURS=0",
		"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bun %s: %v\n%s", s.name(), err, out)
	}
}

func (e *orderEnv) runGo(t *testing.T, s orderScenario, home string) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("AGENTIO_PASSPHRASE", parityPassphrase)
	t.Setenv("PATH", e.bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	vault.Reset()
	auth.Reset()
	defer vault.Reset()
	ctx := context.Background()
	reg := plugins.Default
	answer := func(q string) (string, error) {
		for _, a := range s.Answers {
			if regexp.MustCompile("(?i)" + a[0].(string)).MatchString(q) {
				return a[1].(string), nil
			}
		}
		return "", fmt.Errorf("unscripted prompt: %s", q)
	}
	setup := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	setup.Log = func(...any) {}
	setup.OpenURL = func(string) bool { return true }
	setup.Prompt = func(q string, _ bool) (string, error) { return answer(q) }
	setup.Confirm = func(string) (bool, error) { return true, nil }
	setup.Select = func(message string, _ []plugins.Choice) (int, error) {
		for _, sel := range s.Selects {
			if regexp.MustCompile("(?i)" + sel[0].(string)).MatchString(message) {
				return sel[1].(int), nil
			}
		}
		return 0, fmt.Errorf("unscripted select: %s", message)
	}
	setup.OAuth = func(_ context.Context, opts plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		port := opts.Port
		if port == 0 {
			port = 3000
		}
		redirect := fmt.Sprintf("http://localhost:%d/callback", port)
		u, err := url.Parse(opts.AuthorizationURL(redirect))
		if err != nil {
			return plugins.OAuthSetupResult{}, err
		}
		return plugins.OAuthSetupResult{Code: "code-" + s.Service, State: u.Query().Get("state"), RedirectURI: redirect}, nil
	}
	var err error
	switch s.Op {
	case "add":
		name, _ := s.GoOptions["profile"].(string)
		err = host.AddProfile(ctx, reg.Find(s.Service), plugins.SetupOptions{Profile: name, Options: s.GoOptions}, setup, io.Discard)
	case "refresh":
		var fresh auth.Fresh
		fresh, err = auth.GetFresh(ctx, reg, s.Service, s.Profile, auth.RefreshOptions{Force: true})
		if err == nil && !fresh.Refreshed {
			err = fmt.Errorf("not refreshed")
		}
	case "reauth":
		err = host.Reauth(ctx, reg, s.Service, s.Profile, setup, io.Discard)
	case "rename":
		var outcome profile.WriteOutcome
		outcome, err = profile.Rename(s.Service, s.Profile, s.To)
		if err == nil && outcome != profile.WriteOK {
			err = fmt.Errorf("rename: %s", outcome)
		}
	case "update":
		var found bool
		found, err = profile.SetReadOnly(s.Service, s.Profile, s.ReadOnly)
		if err == nil && !found {
			err = fmt.Errorf("no profile")
		}
	case "remove":
		var removed bool
		removed, err = profile.Delete(s.Service, s.Profile)
		if err == nil && !removed {
			err = fmt.Errorf("no profile")
		}
	case "touch":
		var keys []profile.KeyView
		if keys, err = profile.ListKeys(); err == nil {
			err = profile.TouchKey(keys[0], time.Now())
		}
	case "keepalive":
		daemon.RunRefreshPass(ctx, reg)
	default:
		err = fmt.Errorf("unknown op %s", s.Op)
	}
	if err != nil {
		t.Fatalf("go %s: %v", s.name(), err)
	}
}

// keyFields are what each CLI draws at random or from its clock for a key.
var keyFields = regexp.MustCompile(`"(id|secretHash|hint|createdAt|lastUsedAt)":"[^"]*"`)

func maskKeys(s string) string { return keyFields.ReplaceAllString(s, `"$1":""`) }

func (e *orderEnv) compare(t *testing.T, s orderScenario) {
	t.Helper()
	e.mock.setMode(s.Mode)
	seed := string(jsvalue.Stringify(seedDocument(s)))
	bunHome, goHome := filepath.Join(t.TempDir(), "bun"), filepath.Join(t.TempDir(), "go")
	bunVault, goVault := seedHome(t, bunHome, seed), seedHome(t, goHome, seed)
	e.runBun(t, s, bunHome)
	e.runGo(t, s, goHome)
	bun, got := maskClock(decryptVaultFile(t, bunVault)), maskClock(decryptVaultFile(t, goVault))
	if s.Op == "touch" {
		bun, got, seed = maskKeys(bun), maskKeys(got), maskKeys(seed)
	}
	if got != bun {
		t.Fatalf("%s: the Go vault differs from Bun's\n bun: %s\n  go: %s", s.name(), bun, got)
	}
	if changed := bun != maskClock(seed); changed == s.Unchanged {
		t.Fatalf("%s: vault changed=%v, expected changed=%v\n%s", s.name(), changed, !s.Unchanged, bun)
	}
	if _, err := os.Stat(filepath.Join(e.tmp, "opened")); err == nil {
		t.Fatalf("%s: a browser was opened", s.name())
	}
}

// expiry is a stored expiry in the past, so a keepalive pass refreshes it.
var pastExpiry = json.Number("1700000000000")

// futureExpiry is a stored refresh expiry far ahead.
var futureExpiry = json.Number("4102444800000")

// storedFor is each service's stored credential object, keys in an order no
// code would produce on its own, with a nested member of its own.
func storedFor(service string, e *orderEnv) *jsvalue.Object {
	nested := jsvalue.ObjectOf("b", 1, "a", jsvalue.ObjectOf("d", true, "c", []any{2, 1}))
	switch service {
	case "gmail", "gcal", "gtasks":
		return jsvalue.ObjectOf("email", "ada@example.com", "scope", "old scope", "zNested", nested,
			"token_type", "Bearer", "refresh_token", "1//stored", "expiry_date", pastExpiry, "access_token", "ya29.old")
	case "gdocs", "gsheets", "gslides", "gscript", "gdrive":
		o := jsvalue.ObjectOf("email", "ada@example.com", "scope", "old scope", "zNested", nested,
			"tokenType", "Bearer", "refreshToken", "1//stored", "expiryDate", pastExpiry, "accessToken", "ya29.old")
		if service == "gdrive" {
			o.Set("accessLevel", "full")
		}
		return o
	case "gchat":
		return jsvalue.ObjectOf("email", "ada@example.com", "zNested", nested, "refreshToken", "1//stored",
			"expiryDate", pastExpiry, "type", "oauth", "accessToken", "ya29.old", "tokenType", "Bearer")
	case "jira", "confluence":
		return jsvalue.ObjectOf("siteUrl", "https://old.atlassian.net", "zNested", nested, "cloudId", "cloud-old",
			"expiryDate", pastExpiry, "refreshToken", "rt-stored", "accessToken", "at-old")
	case "github":
		return jsvalue.ObjectOf("username", "old", "zNested", nested, "email", "old@example.com", "accessToken", "gho_old")
	case "dropbox":
		return jsvalue.ObjectOf("name", "Old", "email", "old@example.com", "zNested", nested, "accountId", "dbid:OLD",
			"expiryDate", pastExpiry, "refreshToken", "db-stored", "accessToken", "sl.old", "appKey", "appkey-1")
	case "revolut":
		key, _ := os.ReadFile(e.keyPath)
		return jsvalue.ObjectOf("expiryDate", pastExpiry, "zNested", nested, "refreshToken", "oa_stored", "accessToken", "oa_old",
			"redirectUri", "https://example.com/callback", "privateKey", string(key), "clientId", "cid-1", "environment", "sandbox")
	case "falco":
		return jsvalue.ObjectOf("userEmail", "ada@example.com", "userId", "u1", "zNested", nested, "organizationName", "Old Name",
			"organizationId", "org-1", "expiryDate", pastExpiry, "accessToken", "f-old", "refreshExpiryDate", futureExpiry, "refreshToken", "f-rt-stored")
	case "slack":
		return jsvalue.ObjectOf("channelName", "general", "zNested", nested, "webhookUrl", "https://hooks.slack.com/services/T/B/X", "type", "webhook")
	case "discourse":
		return jsvalue.ObjectOf("username", "ada", "zNested", nested, "apiKey", "k", "baseUrl", e.mockURL)
	case "sql":
		return jsvalue.ObjectOf("displayName", "parity.db", "zNested", nested, "url", "sqlite://"+e.sqlite)
	}
	return nil
}

// setupAnswers are the prompts each service's profile add asks, answered.
func setupAnswers(service string, e *orderEnv) ([][2]any, [][2]any, map[string]any, map[string]any) {
	switch service {
	case "gdrive":
		return [][2]any{{"access level", "2"}}, nil, nil, nil
	case "gchat":
		return [][2]any{{"webhook URL", "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t"}}, [][2]any{{"profile type", 1}}, nil, nil
	case "jira", "confluence":
		return nil, [][2]any{{"site", 1}}, nil, nil
	case "dropbox":
		return [][2]any{{"App key", "appkey-1"}, {"authorisation code", "db-code"}}, nil, nil, nil
	case "revolut":
		return [][2]any{
			{"Environment", "sandbox"}, {"Client ID", "cid-1"}, {"private key", e.keyPath},
			{"OAuth redirect URI", "https://example.com/callback"}, {"redirect URL", "https://example.com/callback?code=rev-code"},
		}, nil, nil, nil
	case "falco":
		return [][2]any{{"email", "ada@example.com"}, {"password", "pw"}}, [][2]any{{"organization", 1}}, nil, nil
	case "slack":
		return [][2]any{{"webhook URL", "https://hooks.slack.com/services/T0/B0/XYZ&x"}, {"Channel name", ""}}, nil, nil, nil
	case "discourse":
		return [][2]any{{"Forum URL", e.mockURL}, {"API Key", "key-1"}, {"Username", "ada"}}, nil, nil, nil
	case "sql":
		// The display name of a file URL holds "/", which no profile name may.
		return [][2]any{{"Connection URL", "sqlite://" + e.sqlite}}, nil, map[string]any{"profile": "db"}, map[string]any{"profile": "db"}
	}
	return nil, nil, nil, nil
}

func reauthSelects(service string) [][2]any {
	if service == "jira" || service == "confluence" {
		return [][2]any{{"site", 0}}
	}
	return nil
}

func reauthAnswers(service string, e *orderEnv) [][2]any {
	switch service {
	case "dropbox":
		return [][2]any{{"authorisation code", "db-code"}}
	case "revolut":
		return [][2]any{{"redirect URL", "https://example.com/callback?code=rev-code"}}
	case "falco":
		return [][2]any{{"password", "pw"}}
	}
	return nil
}

var orderServices = []string{
	"gmail", "gcal", "gtasks", "gdocs", "gsheets", "gslides", "gscript", "gdrive", "gchat",
	"github", "jira", "confluence", "slack", "discourse", "dropbox", "sql", "revolut", "falco",
}

// refreshable are the services with a credential lifecycle, and the token
// response variants each is refreshed with.
var refreshModes = map[string][]string{
	"gmail": {"plain", "rotate", "noexpiry"}, "gcal": {"plain"}, "gtasks": {"plain"},
	"gdocs": {"plain", "rotate", "noexpiry"}, "gsheets": {"plain"}, "gslides": {"plain"}, "gscript": {"plain"},
	"gdrive": {"plain"}, "gchat": {"plain"},
	"jira": {"plain", "rotate"}, "confluence": {"plain", "rotate"},
	"dropbox": {"plain"}, "revolut": {"plain"}, "falco": {"rotate"},
}

func TestVaultBytesMatchBunForEveryService(t *testing.T) {
	testbox.Isolate(t)
	e := newOrderEnv(t)
	for _, service := range orderServices {
		answers, selects, bunOpts, goOpts := setupAnswers(service, e)
		var scenarios []orderScenario
		scenarios = append(scenarios, orderScenario{Service: service, Op: "add", Answers: answers, Selects: selects, BunOptions: bunOpts, GoOptions: goOpts})
		for _, mode := range refreshModes[service] {
			scenarios = append(scenarios, orderScenario{Service: service, Op: "refresh", Profile: "work", Mode: mode, Stored: storedFor(service, e)})
		}
		_, hasReauth := map[string]bool{"slack": true, "discourse": true, "sql": true}[service]
		scenarios = append(scenarios,
			orderScenario{Service: service, Op: "reauth", Profile: "work", Stored: storedFor(service, e), Answers: reauthAnswers(service, e), Selects: reauthSelects(service), Unchanged: hasReauth},
			orderScenario{Service: service, Op: "rename", Profile: "work", To: "renamed", Stored: storedFor(service, e)},
			orderScenario{Service: service, Op: "rename", Profile: "bare", To: "bare2", Stored: storedFor(service, e)},
			orderScenario{Service: service, Op: "update", Profile: "work", ReadOnly: true, Stored: storedFor(service, e)},
			orderScenario{Service: service, Op: "update", Profile: "bare", ReadOnly: true, Stored: storedFor(service, e)},
			orderScenario{Service: service, Op: "remove", Profile: "work", Stored: storedFor(service, e)},
			orderScenario{Service: service, Op: "keepalive", Stored: storedFor(service, e), Mode: "plain", Unchanged: refreshModes[service] == nil},
		)
		if service == "gchat" {
			scenarios = append(scenarios, orderScenario{Service: service, Op: "add", Answers: answers, Selects: [][2]any{{"profile type", 0}}})
		}
		if service == "slack" {
			scenarios = append(scenarios, orderScenario{Service: service, Op: "add", Answers: [][2]any{{"webhook URL", "https://hooks.slack.com/services/T0/B0/XYZ"}, {"Channel name", "general"}}})
		}
		if service == "gmail" {
			scenarios = append(scenarios,
				orderScenario{Service: service, Op: "update", Profile: "work", ReadOnly: false, Stored: storedFor(service, e), Unchanged: true},
				orderScenario{Service: service, Op: "touch", Stored: storedFor(service, e)},
			)
		}
		for _, s := range scenarios {
			label := s.name()
			if s.Profile != "" {
				label += "/" + s.Profile
			}
			t.Run(label, func(t *testing.T) { e.compare(t, s) })
		}
	}
}

// cliRun runs one agentio command line through each CLI against its home.
func (e *orderEnv) runBunCLI(t *testing.T, home string, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bun", append([]string{"run", "src/index.ts"}, args...)...)
	cmd.Dir = e.root
	cmd.Env = []string{
		"HOME=" + home, "TMPDIR=" + os.TempDir(), "PATH=" + e.bin + string(os.PathListSeparator) + os.Getenv("PATH"),
		"AGENTIO_PASSPHRASE=" + parityPassphrase, "AGENTIO_KEEPALIVE_HOURS=0",
		"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
	}
	cmd.Stdin = strings.NewReader("")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("bun %v: %v\n%s", args, err, out)
	}
}

func (e *orderEnv) runGoCLI(t *testing.T, home string, args ...string) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("AGENTIO_PASSPHRASE", parityPassphrase)
	vault.Reset()
	auth.Reset()
	defer vault.Reset()
	var out, errOut strings.Builder
	if code := Execute(plugins.Default, args, &out, &errOut, strings.NewReader("")); code != 0 {
		t.Fatalf("go %v: exit %d\n%s%s", args, code, out.String(), errOut.String())
	}
}

const parityExportKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

// exportFixture is an export as another vault could have written it: keys out
// of order, a profile that exists in the seed, one that does not, a new
// service, and a top-level member an import does not carry over.
const exportFixture = `{"config":{"profiles":{"gmail":["n1",{"readOnly":true,"name":"work"}],"new":["x"]},"z":1},"version":1,"credentials":{"new":{"x":{"z":1,"a":{"d":1,"c":2}}},"gmail":{"work":{"replaced":true},"n1":{"b":"&","a":1}}},"extraTop":1}`

// The vault commands that rewrite the whole document or large parts of it:
// export, import (fresh, replace and merge), clear, and the key commands.
func TestVaultCommandsMatchBun(t *testing.T) {
	testbox.Isolate(t)
	e := newOrderEnv(t)
	enc, err := vault.Encrypt(exportFixture, parityExportKey)
	if err != nil {
		t.Fatal(err)
	}
	exportIn := filepath.Join(e.tmp, "in.enc")
	if err := os.WriteFile(exportIn, []byte(enc), 0o600); err != nil {
		t.Fatal(err)
	}
	seed := string(jsvalue.Stringify(seedDocument(orderScenario{Service: "gmail", Stored: storedFor("gmail", e)})))
	cases := []struct {
		name    string
		args    []string
		noVault bool
		mask    func(string) string
		export  bool
	}{
		{name: "import replace", args: []string{"vault", "import", exportIn, "--key", parityExportKey}},
		{name: "import merge", args: []string{"vault", "import", exportIn, "--key", parityExportKey, "--merge"}},
		{name: "import fresh", args: []string{"vault", "import", exportIn, "--key", parityExportKey, "--passphrase", parityPassphrase}, noVault: true},
		{name: "clear", args: []string{"vault", "clear", "--force"}},
		{name: "export", args: []string{"vault", "export", "--all", "--key", parityExportKey, "--file", "OUT"}, export: true},
		{name: "key create", args: []string{"key", "create", "agent", "--url", "https://hub.example.com", "--profiles", "gmail/work,gmail/bare", "--can-manage-profiles"}, mask: maskKeys},
		{name: "key update", args: []string{"key", "update", "k1", "--name", "renamed", "--read-only", "--profiles", "gmail/bare"}},
		{name: "key rotate", args: []string{"key", "rotate", "k1", "--url", "https://hub.example.com"}, mask: maskKeys},
		{name: "key revoke", args: []string{"key", "revoke", "k1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bunHome, goHome := filepath.Join(t.TempDir(), "bun"), filepath.Join(t.TempDir(), "go")
			bunVault, goVault := filepath.Join(bunHome, ".config", "agentio", "vault.enc"), filepath.Join(goHome, ".config", "agentio", "vault.enc")
			if !tc.noVault {
				seedHome(t, bunHome, seed)
				seedHome(t, goHome, seed)
			}
			bunArgs, goArgs := append([]string(nil), tc.args...), append([]string(nil), tc.args...)
			bunOut, goOut := filepath.Join(bunHome, "out.enc"), filepath.Join(goHome, "out.enc")
			for i, a := range tc.args {
				if a == "OUT" {
					bunArgs[i], goArgs[i] = bunOut, goOut
				}
			}
			e.runBunCLI(t, bunHome, bunArgs...)
			e.runGoCLI(t, goHome, goArgs...)
			var bun, got string
			if tc.export {
				bun, got = decryptWith(t, bunOut, parityExportKey), decryptWith(t, goOut, parityExportKey)
			} else {
				bun, got = decryptVaultFile(t, bunVault), decryptVaultFile(t, goVault)
			}
			if tc.mask != nil {
				bun, got = tc.mask(bun), tc.mask(got)
			}
			if got != bun {
				t.Fatalf("the Go result differs from Bun's\n bun: %s\n  go: %s", bun, got)
			}
			if !tc.export && bun == seed {
				t.Fatalf("nothing changed: %s", bun)
			}
		})
	}
}

func decryptWith(t *testing.T, path, key string) string {
	t.Helper()
	enc, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := vault.Decrypt(strings.TrimSpace(string(enc)), key)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}
