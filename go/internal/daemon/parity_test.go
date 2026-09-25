package daemon

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/confluence"
	"github.com/plosson/agentio/go/internal/plugins/discourse"
	"github.com/plosson/agentio/go/internal/plugins/dropbox"
	"github.com/plosson/agentio/go/internal/plugins/falco"
	"github.com/plosson/agentio/go/internal/plugins/github"
	"github.com/plosson/agentio/go/internal/plugins/google/gcal"
	"github.com/plosson/agentio/go/internal/plugins/google/gchat"
	"github.com/plosson/agentio/go/internal/plugins/google/gdocs"
	"github.com/plosson/agentio/go/internal/plugins/google/gdrive"
	"github.com/plosson/agentio/go/internal/plugins/google/gmail"
	"github.com/plosson/agentio/go/internal/plugins/google/gscript"
	"github.com/plosson/agentio/go/internal/plugins/google/gsheets"
	"github.com/plosson/agentio/go/internal/plugins/google/gslides"
	"github.com/plosson/agentio/go/internal/plugins/google/gtasks"
	"github.com/plosson/agentio/go/internal/plugins/jira"
	"github.com/plosson/agentio/go/internal/plugins/revolut"
	"github.com/plosson/agentio/go/internal/plugins/rss"
	"github.com/plosson/agentio/go/internal/plugins/slack"
	sqlplugin "github.com/plosson/agentio/go/internal/plugins/sql"
	"github.com/plosson/agentio/go/internal/vault"
)

// The Bun daemon, served on a random loopback port by the real request
// handler, the way `agentio daemon start` wires it minus the fixed port.
const bunParityServer = `
import { createRequestHandler } from './src/daemon/api';
import { memoryOnlyProvider, setPassphraseProvider } from './src/vault/passphrase';
setPassphraseProvider(memoryOnlyProvider());
const handle = createRequestHandler({ version: 'parity' });
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request, srv) => handle(request, srv) });
console.log(server.port);
`

const parityPass = "parity-pass-123"

// One vault, written into whichever HOME is current: a bare-string profile, a
// read-only one, one without credentials, and a name that needs encoding.
const parityVault = `{"version":1,"config":{"profiles":{
  "rss":["news"],
  "jira":[{"name":"work","readOnly":true}],
  "slack":[{"name":"team"},"x/y"],
  "github":[{"name":"org/repo"},{"name":"other"}]
}},"credentials":{
  "rss":{"news":{"feeds":["https://example.invalid/feed"]}},
  "jira":{"work":{"host":"https://example.invalid","email":"a@example.invalid","apiToken":"t"}},
  "github":{"org/repo":{"token":"t"},"other":{"token":"t"}}
}}`

func seedParityVault(t *testing.T) {
	t.Helper()
	var c vault.Contents
	if err := json.Unmarshal([]byte(parityVault), &c); err != nil {
		t.Fatal(err)
	}
	vault.Reset()
	if err := vault.Create(vault.DefaultVaultPath(), parityPass, &c); err != nil {
		t.Fatal(err)
	}
	vault.Reset()
}

// The same catalog as the Bun registry, in its order, as far as Go has it.
func parityRegistry(t *testing.T) *plugins.Registry {
	t.Helper()
	reg, err := plugins.NewRegistry(
		confluence.New(), discourse.New(), dropbox.New(), falco.New(), gcal.New(), gchat.New(),
		gdocs.New(), gdrive.New(), github.New(), gmail.New(), gsheets.New(), gslides.New(),
		gscript.New(), gtasks.New(), jira.New(), revolut.New(), rss.New(), slack.New(), sqlplugin.New(),
	)
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func startBunDaemon(t *testing.T, home string) string {
	t.Helper()
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("bun is not installed")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bun, "-e", bunParityServer)
	cmd.Dir = root
	cmd.Env = []string{
		"HOME=" + home, "PATH=" + os.Getenv("PATH"), "TMPDIR=" + os.TempDir(),
		"AGENTIO_TEST=1", "AGENTIO_KEEPALIVE_HOURS=0", "AGENTIO_TRUSTED_IP_HEADER=X-Test-Ip",
		"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	port := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		port <- strings.TrimSpace(line)
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case p := <-port:
		if p == "" {
			t.Fatal("the Bun daemon did not start")
		}
		return "http://127.0.0.1:" + p
	case <-time.After(30 * time.Second):
		t.Fatal("the Bun daemon did not report its port")
	}
	return ""
}

type parityTarget struct {
	name    string
	base    string
	session string
	vars    map[string]string
}

type parityResult struct {
	Status  int
	Headers map[string]string
	Body    any
	Keys    string
	Raw     string
}

// keyOrder lists every object key in document order, so field order is compared too.
func keyOrder(raw []byte) string {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	var keys []string
	// Inside an object, a string token alternates between key and value.
	type frame struct{ object, wantKey bool }
	var stack []frame
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		top := len(stack) - 1
		isKey := false
		if top >= 0 && stack[top].object {
			if stack[top].wantKey {
				if k, ok := tok.(string); ok {
					keys = append(keys, k)
					isKey = true
				}
			}
		}
		switch tok {
		case json.Delim('{'):
			stack = append(stack, frame{object: true, wantKey: true})
			continue
		case json.Delim('['):
			stack = append(stack, frame{})
			continue
		case json.Delim('}'), json.Delim(']'):
			stack = stack[:top]
		}
		if top = len(stack) - 1; top >= 0 && stack[top].object && tok != json.Delim('{') {
			if isKey {
				stack[top].wantKey = false
			} else {
				stack[top].wantKey = true
			}
		}
	}
	return strings.Join(keys, ",")
}

type parityStep struct {
	method, path, body string
	header             map[string]string
	noCookie           bool
	capture            func(vars map[string]string, body map[string]any)
}

var (
	nonceValue  = regexp.MustCompile(`nonce-[A-Za-z0-9+/=]+`)
	nonceHTML   = regexp.MustCompile(`nonce="[A-Za-z0-9+/=]+"`)
	metadataRow = regexp.MustCompile(`const PLUGIN_METADATA = (.*);`)
	cookieValue = regexp.MustCompile(`^agentio_session=[^;]+`)
)

// Values that are random or time-dependent on either side.
var volatileKeys = map[string]bool{
	"id": true, "token": true, "hint": true, "createdAt": true, "lastUsedAt": true,
	"expiresAt": true, "userCode": true, "deviceCode": true, "timestamp": true, "uptime": true,
}

func normalizeJSON(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			// A token is random but for the hub URL it carries, which must match.
			if tok, ok := val.(string); ok && k == "token" {
				parts, err := auth.DecodeToken(tok)
				out[k] = "<token for " + parts.URL + ">"
				if err != nil {
					out[k] = "<malformed token>"
				}
				continue
			}
			if volatileKeys[k] && val != nil {
				out[k] = "<volatile>"
				continue
			}
			out[k] = normalizeJSON(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeJSON(val)
		}
		return out
	}
	return v
}

func (p *parityTarget) expand(s string) string {
	for k, v := range p.vars {
		s = strings.ReplaceAll(s, "{"+k+"}", v)
	}
	return s
}

func (p *parityTarget) do(t *testing.T, step parityStep) (parityResult, map[string]any) {
	t.Helper()
	var body io.Reader
	if step.body != "" {
		body = strings.NewReader(p.expand(step.body))
	}
	req, err := http.NewRequest(step.method, p.base+p.expand(step.path), body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range step.header {
		req.Header.Set(k, v)
	}
	if p.session != "" && !step.noCookie {
		req.Header.Set("Cookie", "agentio_session="+p.session)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s: %v", p.name, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	// Ids this side minted read the same on both, wherever they are echoed.
	for k, v := range p.vars {
		if v != "" && strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
			raw = []byte(strings.ReplaceAll(string(raw), v, "{"+k+"}"))
		}
	}
	out := parityResult{Status: res.StatusCode, Headers: map[string]string{}, Raw: string(raw)}
	for _, h := range []string{"Content-Type", "Cache-Control", "Location", "X-Frame-Options", "X-Content-Type-Options",
		"Referrer-Policy", "Strict-Transport-Security", "Content-Security-Policy"} {
		if v := res.Header.Get(h); v != "" {
			out.Headers[h] = nonceValue.ReplaceAllString(v, "nonce-N")
		}
	}
	for _, c := range res.Header.Values("Set-Cookie") {
		if strings.Contains(c, "Max-Age=0") {
			p.session = ""
		} else if m := cookieValue.FindString(c); m != "" {
			p.session = strings.TrimPrefix(m, "agentio_session=")
		}
		out.Headers["Set-Cookie"] += cookieValue.ReplaceAllStringFunc(c, func(s string) string {
			if s == "agentio_session=" {
				return s
			}
			return "agentio_session=<sid>"
		})
	}
	var decoded map[string]any
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		var anyBody any
		if err := json.Unmarshal(raw, &anyBody); err != nil {
			t.Fatalf("%s %s %s: bad JSON %q", p.name, step.method, step.path, raw)
		}
		decoded, _ = anyBody.(map[string]any)
		out.Body = normalizeJSON(anyBody)
		out.Keys = keyOrder(raw)
		out.Raw = ""
		if strings.TrimSpace(string(raw)) != string(raw) {
			out.Raw = "trailing whitespace"
		}
	} else if m := metadataRow.FindStringSubmatch(out.Raw); m != nil {
		out.Body = m[1]
		out.Raw = nonceHTML.ReplaceAllString(strings.Replace(out.Raw, m[1], "__PLUGIN_METADATA__", 1), `nonce="N"`)
	}
	if step.capture != nil && decoded != nil {
		step.capture(p.vars, decoded)
	}
	return out, decoded
}

// Every request the admin UI makes, and the daemon behaviour behind it, sent
// to the Bun daemon and the Go daemon in turn. Anything that differs, other
// than ids, secrets, timestamps and nonces, fails.
func TestUIParityWithBunDaemon(t *testing.T) {
	if testing.Short() {
		t.Skip("starts the Bun daemon")
	}
	isolate(t)
	bunHome := t.TempDir()
	goHome := os.Getenv("HOME")
	t.Setenv("HOME", bunHome)
	seedParityVault(t)
	t.Setenv("HOME", goHome)
	seedParityVault(t)
	// Both daemons start locked, as `agentio daemon start` does without AGENTIO_PASSPHRASE.
	t.Setenv("AGENTIO_PASSPHRASE", "")
	vault.Reset()
	vault.SetMemoryOnly(true)
	t.Cleanup(vault.Reset)
	t.Setenv("AGENTIO_TRUSTED_IP_HEADER", "X-Test-Ip")

	bun := &parityTarget{name: "bun", base: startBunDaemon(t, bunHome), vars: map[string]string{}}
	srv := httptest.NewServer((&Server{Registry: parityRegistry(t), Version: "parity"}).Handler())
	defer srv.Close()
	gos := &parityTarget{name: "go", base: srv.URL, vars: map[string]string{}}

	keyID := func(vars map[string]string, body map[string]any) {
		if key, ok := body["key"].(map[string]any); ok {
			vars["key"], _ = key["id"].(string)
		}
	}
	device := func(vars map[string]string, body map[string]any) {
		vars["code"], _ = body["userCode"].(string)
		vars["device"], _ = body["deviceCode"].(string)
		vars["loose"] = strings.ToLower(strings.ReplaceAll(vars["code"], "-", " "))
	}
	h := func(kv ...string) map[string]string {
		m := map[string]string{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	steps := []parityStep{
		// Public surface, locked.
		{method: "GET", path: "/"},
		{method: "GET", path: "/health"},
		{method: "GET", path: "/ui"},
		{method: "GET", path: "/ui/"},
		{method: "POST", path: "/ui"},
		{method: "GET", path: "/nope"},
		{method: "GET", path: "/uix"},
		{method: "GET", path: "/ui/api/session"},
		{method: "GET", path: "/ui/api/profiles"},
		{method: "GET", path: "/ui/api/status?test=false"},
		{method: "POST", path: "/ui/api/lock"},
		{method: "POST", path: "/ui/api/logout"},
		// Unlock: bad bodies, a wrong passphrase, then the right one.
		// These come from another address, so they spend its allowance, not ours.
		{method: "POST", path: "/ui/api/unlock", header: h("X-Test-Ip", "10.0.0.1")},
		{method: "POST", path: "/ui/api/unlock", body: `not json`, header: h("X-Test-Ip", "10.0.0.1")},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":5}`, header: h("X-Test-Ip", "10.0.0.1")},
		{method: "POST", path: "/ui/api/unlock", body: `[]`, header: h("X-Test-Ip", "1.1.1.1, 10.0.0.1")},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"wrong-pass-123"}`, header: h("X-Test-Ip", "10.0.0.1")},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`, header: h("X-Test-Ip", "10.0.0.1")},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":""}`, header: h("X-Test-Ip", "10.0.0.2")},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`},
		{method: "GET", path: "/ui/api/session"},
		{method: "GET", path: "/ui/api/session", noCookie: true},
		{method: "GET", path: "/ui/api/profiles", header: h("Cookie", "agentio_session=forged")},
		{method: "GET", path: "/health"},
		// Unlocked already: a wrong passphrase fails and leaves the vault as it was.
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"wrong-pass-123"}`, header: h("X-Test-Ip", "10.0.0.3")},
		{method: "GET", path: "/ui/api/session"},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`, header: h("X-Test-Ip", "10.0.0.3", "X-Forwarded-Proto", "HTTPS")},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`, header: h("X-Test-Ip", "10.0.0.3", "X-Forwarded-Proto", "http")},
		{method: "GET", path: "/ui/api/session", header: h("Cookie", "other=1; agentio_session=")},
		// What the profiles tab reads and tests.
		{method: "GET", path: "/ui/api/profiles"},
		{method: "GET", path: "/ui/api/status?test=false"},
		{method: "GET", path: "/ui/api/profiles/slack/team/status"},
		{method: "GET", path: "/ui/api/profiles/slack/x%2Fy/status"},
		{method: "GET", path: "/ui/api/profiles/rss/ghost/status"},
		{method: "GET", path: "/ui/api/profiles/rss/news/bogus"},
		{method: "GET", path: "/ui/api/profiles/rss/news"},
		{method: "GET", path: "/ui/api/profiles/Bad/news/status"},
		{method: "PUT", path: "/ui/api/profiles/rss/news", body: `{}`},
		// Read-only toggle and rename.
		{method: "PATCH", path: "/ui/api/profiles/rss/news", body: `{"readOnly":true}`},
		{method: "PATCH", path: "/ui/api/profiles/rss/news", body: `{"readOnly":"yes"}`},
		{method: "PATCH", path: "/ui/api/profiles/rss/news", body: `{}`},
		{method: "PATCH", path: "/ui/api/profiles/rss/news", body: `{"name":null}`},
		{method: "PATCH", path: "/ui/api/profiles/rss/news", body: `{"name":5,"readOnly":true}`},
		{method: "PATCH", path: "/ui/api/profiles/rss/news", body: `nope`},
		{method: "PATCH", path: "/ui/api/profiles/rss/ghost", body: `{"readOnly":false}`},
		{method: "PATCH", path: "/ui/api/profiles/jira/work", body: `{"readOnly":false}`},
		{method: "PATCH", path: "/ui/api/profiles/github/other", body: `{"name":"org/repo"}`},
		{method: "PATCH", path: "/ui/api/profiles/github/other", body: `{"name":""}`},
		{method: "PATCH", path: "/ui/api/profiles/github/other", body: `{"name":"  "}`},
		{method: "PATCH", path: "/ui/api/profiles/github/other", body: `{"name":"renamed"}`},
		{method: "PATCH", path: "/ui/api/profiles/github/ghost", body: `{"name":"x"}`},
		{method: "GET", path: "/ui/api/status?test=false"},
		// Keys: create, bad input, update, rotate, revoke.
		{method: "GET", path: "/ui/api/keys"},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"laptop","allowedProfiles":"*","readOnly":false,"canManageProfiles":false,"url":"http://127.0.0.1:7890"}`, capture: keyID},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"","allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":5,"allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":"*"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":"*","url":5}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":"*","url":"ftp://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":[],"url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":["rss/news",5],"url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":["rss/ghost","x/y"],"url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":"*","readOnly":"no","url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":"*","readOnly":null,"canManageProfiles":null,"url":"https://h.example/x?y"}`},
		{method: "POST", path: "/ui/api/keys", body: `[1]`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"` + strings.Repeat("é", 64) + `","allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"` + strings.Repeat("é", 65) + `","allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"` + strings.Repeat("😀", 33) + `","allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/keys", body: "{\"name\":\"\u00a0\u2003nbsp\\r\u00a0\",\"allowedProfiles\":\"*\",\"url\":[\"http://h:80/p\"]}"},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"a","allowedProfiles":"*","url":{}}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"HTTP://H.Example:443/x"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"https://User:pw@H:443/"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"http:host/p"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"http:\\\\host\\p"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"mailto:x"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"  http://h  "}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"http://"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"https://h:0443"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"u","allowedProfiles":"*","url":"http://[::1]:80/"}`},
		{method: "POST", path: "/ui/api/keys", body: `{"name":"scoped","allowedProfiles":["rss/news","rss/news","jira/work"],"readOnly":true,"canManageProfiles":true,"url":"http://h"}`},
		{method: "GET", path: "/ui/api/keys"},
		{method: "PATCH", path: "/ui/api/keys/{key}", body: `{}`},
		{method: "PATCH", path: "/ui/api/keys/{key}", body: `{"name":""}`},
		{method: "PATCH", path: "/ui/api/keys/{key}", body: `{"name":null}`},
		{method: "PATCH", path: "/ui/api/keys/{key}", body: `{"allowedProfiles":null}`},
		{method: "PATCH", path: "/ui/api/keys/{key}", body: `{"readOnly":null}`},
		{method: "PATCH", path: "/ui/api/keys/{key}", body: `{"name":" renamed ","allowedProfiles":["rss/news"],"readOnly":true,"canManageProfiles":true}`},
		{method: "PATCH", path: "/ui/api/keys/nokey", body: `{}`},
		{method: "POST", path: "/ui/api/keys/{key}/rotate", body: `{"url":"http://127.0.0.1:7890"}`},
		{method: "POST", path: "/ui/api/keys/{key}/rotate", body: `{}`},
		{method: "POST", path: "/ui/api/keys/nokey/rotate", body: `{"url":"http://h"}`},
		{method: "GET", path: "/ui/api/keys/{key}/rotate"},
		{method: "GET", path: "/ui/api/keys"},
		// Deleting a profile drops it from scoped keys.
		{method: "DELETE", path: "/ui/api/profiles/rss/news"},
		{method: "DELETE", path: "/ui/api/profiles/rss/news"},
		{method: "GET", path: "/ui/api/keys"},
		{method: "GET", path: "/ui/api/profiles"},
		// Device login: approve one, deny one.
		{method: "GET", path: "/ui/api/authorize/BCDF-GHJK"},
		{method: "POST", path: "/v1/device", body: `{"name":"  build-box  "}`, capture: device},
		{method: "GET", path: "/ui/api/authorize/{code}"},
		{method: "GET", path: "/ui/api/authorize/{loose}"},
		{method: "POST", path: "/v1/device/token", body: `{"deviceCode":"{device}"}`},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `{"approve":true,"name":"","allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `{"approve":true,"name":"build-box","allowedProfiles":"*","readOnly":false,"canManageProfiles":false,"url":"http://127.0.0.1:7890"}`},
		{method: "POST", path: "/v1/device/token", body: `{"deviceCode":"{device}"}`},
		{method: "POST", path: "/v1/device/token", body: `{"deviceCode":"{device}"}`},
		{method: "GET", path: "/ui/api/authorize/{code}"},
		{method: "POST", path: "/v1/device", body: `{"name":"other"}`, capture: device},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `{"approve":"true"}`},
		{method: "POST", path: "/v1/device/token", body: `{"deviceCode":"{device}"}`},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `{"approve":false}`},
		{method: "POST", path: "/v1/device", body: `{"name":""}`},
		{method: "POST", path: "/v1/device", body: `{"name":5}`},
		{method: "POST", path: "/v1/device", body: `nope`},
		{method: "POST", path: "/v1/device/token", body: `{"deviceCode":5}`},
		{method: "POST", path: "/v1/device", body: `{"name":"third"}`, capture: device},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `{"approve":true,"name":7,"allowedProfiles":"*","url":"http://h"}`},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `{"approve":true,"name":"third","allowedProfiles":["jira/work"],"readOnly":true,"url":"http://h"}`},
		{method: "POST", path: "/ui/api/authorize/{code}", body: `nope`},
		{method: "GET", path: "/ui/api/keys"},
		{method: "DELETE", path: "/ui/api/keys/{key}"},
		{method: "DELETE", path: "/ui/api/keys/{key}"},
		{method: "GET", path: "/ui/api/nothing"},
		// Sign out, sign back in over "HTTPS", lock.
		{method: "POST", path: "/ui/api/logout"},
		{method: "GET", path: "/ui/api/session"},
		{method: "GET", path: "/ui/api/keys"},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`, header: h("X-Forwarded-Proto", "https")},
		{method: "GET", path: "/ui/api/session"},
		{method: "POST", path: "/ui/api/lock", header: h("X-Forwarded-Proto", "https")},
		{method: "GET", path: "/ui/api/session"},
		{method: "GET", path: "/health"},
		// The fifth attempt in the minute is the last one allowed.
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`},
		{method: "GET", path: "/ui/api/keys"},
		{method: "POST", path: "/ui/api/lock"},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`},
		{method: "POST", path: "/ui/api/unlock", body: `not json`},
		{method: "POST", path: "/ui/api/unlock", body: `{"passphrase":"` + parityPass + `"}`},
		{method: "GET", path: "/ui/api/session"},
	}

	var diffs []string
	for i, step := range steps {
		b, _ := bun.do(t, step)
		g, _ := gos.do(t, step)
		label := fmt.Sprintf("#%d %s %s %s", i, step.method, step.path, step.body)
		t.Logf("%s -> bun %d, go %d", label, b.Status, g.Status)
		if b.Status != g.Status {
			diffs = append(diffs, fmt.Sprintf("%s: status bun=%d go=%d\n  bun=%v\n  go=%v", label, b.Status, g.Status, b.Body, g.Body))
			continue
		}
		if !reflect.DeepEqual(b.Headers, g.Headers) {
			diffs = append(diffs, fmt.Sprintf("%s: headers\n  bun=%v\n  go=%v", label, b.Headers, g.Headers))
		}
		if b.Keys != g.Keys {
			diffs = append(diffs, fmt.Sprintf("%s: field order\n  bun=%s\n  go=%s", label, b.Keys, g.Keys))
		}
		if b.Raw != g.Raw {
			diffs = append(diffs, fmt.Sprintf("%s: raw body differs (%d vs %d bytes): bun=%.200q go=%.200q", label, len(b.Raw), len(g.Raw), b.Raw, g.Raw))
		}
		if bm, ok := b.Body.(string); ok {
			if d := compareMetadata(bm, g.Body.(string)); d != "" {
				diffs = append(diffs, label+": "+d)
			}
			continue
		}
		if !reflect.DeepEqual(b.Body, g.Body) {
			bj, _ := json.Marshal(b.Body)
			gj, _ := json.Marshal(g.Body)
			diffs = append(diffs, fmt.Sprintf("%s: body\n  bun=%s\n  go=%s", label, bj, gj))
		}
	}
	for _, d := range diffs {
		t.Error(d)
	}
}

// Every plugin Go has must read the same on the page; Bun may know more plugins.
func compareMetadata(bunRaw, goRaw string) string {
	var bunMeta, goMeta map[string]map[string]any
	if err := json.Unmarshal([]byte(bunRaw), &bunMeta); err != nil {
		return "bun metadata: " + err.Error()
	}
	if err := json.Unmarshal([]byte(goRaw), &goMeta); err != nil {
		return "go metadata: " + err.Error()
	}
	var out []string
	for id, g := range goMeta {
		if !reflect.DeepEqual(bunMeta[id], g) {
			out = append(out, fmt.Sprintf("metadata %s bun=%v go=%v", id, bunMeta[id], g))
		}
	}
	return strings.Join(out, "; ")
}
