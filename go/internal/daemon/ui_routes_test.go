package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/ping"
	"github.com/plosson/agentio/go/internal/vault"
)

// The UI routes answer with the bytes Bun's routes-ui.ts sends: the same
// status, the same fields in the same order, JSON.stringify's spacing.

type uiReply struct {
	status int
	header http.Header
	body   string
}

type uiClient struct {
	t      *testing.T
	base   string
	cookie string
}

func (c *uiClient) call(method, path, body string, header ...string) uiReply {
	c.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cookie != "" {
		req.Header.Set("Cookie", "agentio_session="+c.cookie)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if set := res.Header.Get("Set-Cookie"); set != "" {
		c.cookie = strings.TrimPrefix(strings.SplitN(set, ";", 2)[0], "agentio_session=")
	}
	return uiReply{res.StatusCode, res.Header, string(raw)}
}

func (c *uiClient) want(method, path, body string, status int, want string) uiReply {
	c.t.Helper()
	got := c.call(method, path, body)
	if got.status != status || got.body != want {
		c.t.Errorf("%s %s %s\n got %d %s\nwant %d %s", method, path, body, got.status, got.body, status, want)
	}
	if want != "" && (got.header.Get("Content-Type") != "application/json" || got.header.Get("Cache-Control") != "no-store") {
		c.t.Errorf("%s %s: headers %v", method, path, got.header)
	}
	return got
}

func errBody(code clierr.Code, message, suggestion string) string {
	body := `{"error":` + string(marshalJS(message)) + `,"code":"` + string(code) + `"`
	if suggestion != "" {
		body += `,"suggestion":` + string(marshalJS(suggestion))
	}
	return body + "}"
}

func uiServer(t *testing.T, now func() time.Time) (*httptest.Server, func() *uiClient) {
	t.Helper()
	isolate(t)
	var c vault.Contents
	if err := json.Unmarshal([]byte(`{"version":1,"config":{"profiles":{"acme":["ada",{"name":"bob","readOnly":true}]}},
		"credentials":{"acme":{"ada":{"account":"ada","accessToken":"a","expiryDate":9999999999999}}}}`), &c); err != nil {
		t.Fatal(err)
	}
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", &c); err != nil {
		t.Fatal(err)
	}
	// Locked, as `agentio daemon start` begins without AGENTIO_PASSPHRASE.
	t.Setenv("AGENTIO_PASSPHRASE", "")
	vault.Reset()
	vault.SetMemoryOnly(true)
	t.Cleanup(vault.Reset)
	reg, err := plugins.NewRegistry(acme.New(), ping.New())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&Server{Registry: reg, Version: "test", Now: now}).Handler())
	t.Cleanup(srv.Close)
	return srv, func() *uiClient { return &uiClient{t: t, base: srv.URL} }
}

const (
	unauthorized = `{"error":"Unauthorized","code":"AUTH_FAILED"}`
	notFound     = `{"error":"Not found","code":"NOT_FOUND"}`
	badBody      = `{"error":"Body must be JSON","code":"INVALID_PARAMS"}`
)

var keyShape = regexp.MustCompile(`^\{"id":"[A-Za-z0-9_-]{8}","name":"[^"]*","hint":"[A-Za-z0-9_-]{4}","allowedProfiles":(?:"\*"|\[[^\]]*\]),"readOnly":(?:true|false),"createdAt":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z","canManageProfiles":(?:true|false)\}$`)

func TestUIRoutesAnswerLikeBun(t *testing.T) {
	_, client := uiServer(t, nil)
	c := client()

	// Locked and signed out: only the session probe and unlock answer.
	c.want("GET", "/ui/api/session", "", 200, `{"authenticated":false,"locked":true}`)
	for _, route := range [][2]string{{"GET", "/ui/api/profiles"}, {"GET", "/ui/api/status"}, {"GET", "/ui/api/keys"},
		{"POST", "/ui/api/lock"}, {"POST", "/ui/api/logout"}, {"GET", "/ui/api/authorize/X"}, {"DELETE", "/ui/api/profiles/acme/ada"}} {
		c.want(route[0], route[1], "", 401, unauthorized)
	}
	c.want("POST", "/ui/api/unlock", "", 400, badBody)
	c.want("POST", "/ui/api/unlock", `{"passphrase":true}`, 400, `{"error":"passphrase is required","code":"INVALID_PARAMS"}`)
	if got := c.call("POST", "/ui/api/unlock", `{"passphrase":"wrong-pass-1"}`); got.status != 401 || !strings.Contains(got.body, `"code":"AUTH_FAILED"`) || c.cookie != "" {
		t.Fatalf("wrong passphrase: %d %s cookie=%q", got.status, got.body, c.cookie)
	}
	ok := c.want("POST", "/ui/api/unlock", `{"passphrase":"test-pass-123"}`, 200, `{"ok":true}`)
	if set := ok.header.Get("Set-Cookie"); !regexp.MustCompile(`^agentio_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`).MatchString(set) {
		t.Fatalf("session cookie %q", set)
	}
	c.want("GET", "/ui/api/session", "", 200, `{"authenticated":true,"locked":false}`)

	// Profiles tab.
	c.want("GET", "/ui/api/profiles", "", 200, `{"profiles":[{"service":"acme","name":"ada","readOnly":false},{"service":"acme","name":"bob","readOnly":true}]}`)
	c.want("GET", "/ui/api/status?test=false", "", 200, `{"version":"test","services":{"acme":[{"profile":"ada","status":"skipped"},{"profile":"bob","readOnly":true,"status":"no-creds"}]}}`)
	c.want("GET", "/ui/api/profiles/acme/bob/status", "", 200, `{"profile":"bob","readOnly":true,"status":"no-creds"}`)
	missing := clierr.ProfileNotFoundError("acme", "zed")
	c.want("GET", "/ui/api/profiles/acme/zed/status", "", 404, errBody(missing.Code, missing.Message, missing.Suggestion))
	c.want("GET", "/ui/api/profiles/acme/ada/other", "", 404, notFound)
	c.want("PATCH", "/ui/api/profiles/acme/ada", `{"readOnly":true}`, 200, `{"service":"acme","name":"ada","readOnly":true}`)
	c.want("PATCH", "/ui/api/profiles/acme/ada", `{"readOnly":1}`, 400, `{"error":"readOnly must be true or false","code":"INVALID_PARAMS"}`)
	c.want("PATCH", "/ui/api/profiles/acme/ada", `{"name":null,"readOnly":false}`, 400, `{"error":"name must be a string","code":"INVALID_PARAMS"}`)
	c.want("PATCH", "/ui/api/profiles/acme/ada", `"ada"`, 400, `{"error":"readOnly must be true or false","code":"INVALID_PARAMS"}`)
	c.want("PATCH", "/ui/api/profiles/acme/ada", `{"name":"ada2"}`, 200, `{"service":"acme","name":"ada2"}`)
	c.want("DELETE", "/ui/api/profiles/acme/ada2", "", 204, "")
	gone := clierr.ProfileNotFoundError("acme", "ada2")
	c.want("DELETE", "/ui/api/profiles/acme/ada2", "", 404, errBody(gone.Code, gone.Message, gone.Suggestion))

	// Keys tab.
	c.want("GET", "/ui/api/keys", "", 200, `{"keys":[]}`)
	created := c.call("POST", "/ui/api/keys", `{"name":" ci ","allowedProfiles":["acme/bob"],"readOnly":true,"canManageProfiles":false,"url":"HTTP://Hub.Example:80/ui"}`)
	var issued struct {
		Key   map[string]any `json:"key"`
		Token string         `json:"token"`
	}
	_ = json.Unmarshal([]byte(created.body), &issued)
	keyJSON := strings.TrimSuffix(strings.TrimPrefix(created.body, `{"key":`), `,"token":"`+issued.Token+`"}`)
	if created.status != 201 || !keyShape.MatchString(keyJSON) || issued.Key["name"] != "ci" || !strings.HasPrefix(issued.Token, "agio1.") {
		t.Fatalf("create key: %d %s", created.status, created.body)
	}
	if parts, err := auth.DecodeToken(issued.Token); err != nil || parts.URL != "http://hub.example" {
		t.Fatalf("token hub URL %q %v, want the origin as a browser reports it", parts.URL, err)
	}
	id := issued.Key["id"].(string)
	c.want("POST", "/ui/api/keys", `{"name":"x","allowedProfiles":["acme/bob",1],"url":"http://h"}`, 400, `{"error":"allowedProfiles must be \"*\" or a non-empty list of service/name","code":"INVALID_PARAMS"}`)
	c.want("POST", "/ui/api/keys", `{"name":"x","allowedProfiles":"*","url":7}`, 400, `{"error":"The hub URL must be absolute, e.g. https://vault.example.com","code":"INVALID_PARAMS"}`)
	c.want("POST", "/ui/api/keys", `{"name":7}`, 400, `{"error":"A key needs a name of 1 to 64 characters","code":"INVALID_PARAMS"}`)
	c.want("PATCH", "/ui/api/keys/"+id, `{"name":null}`, 400, `{"error":"A key needs a name of 1 to 64 characters","code":"INVALID_PARAMS"}`)
	c.want("PATCH", "/ui/api/keys/"+id, `{"canManageProfiles":null}`, 400, `{"error":"canManageProfiles must be true or false","code":"INVALID_PARAMS"}`)
	if got := c.call("PATCH", "/ui/api/keys/"+id, `{"canManageProfiles":true}`); got.status != 200 || !keyShape.MatchString(got.body) || !strings.HasSuffix(got.body, `"canManageProfiles":true}`) {
		t.Fatalf("update key: %d %s", got.status, got.body)
	}
	c.want("POST", "/ui/api/keys/"+id+"/rotate", `{}`, 400, `{"error":"The hub URL must be absolute, e.g. https://vault.example.com","code":"INVALID_PARAMS"}`)
	if got := c.call("POST", "/ui/api/keys/"+id+"/rotate", `{"url":"https://hub.example"}`); got.status != 200 || !strings.Contains(got.body, `"token":"agio1.`) {
		t.Fatalf("rotate: %d %s", got.status, got.body)
	}
	c.want("DELETE", "/ui/api/keys/"+id, "", 204, "")
	c.want("DELETE", "/ui/api/keys/"+id, "", 404, errBody(clierr.NotFound, "No key with id "+id, "Run: agentio key list"))

	// Sign-in approval page.
	unknown := errBody(clierr.NotFound, "Unknown or expired login code", "Run `agentio login` again to get a new one")
	c.want("GET", "/ui/api/authorize/BCDF-GHJK", "", 404, unknown)
	started, err := StartDevice("laptop", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	view := c.call("GET", "/ui/api/authorize/"+strings.ToLower(strings.ReplaceAll(started.UserCode, "-", "")), "")
	iso := `\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`
	if view.status != 200 || !regexp.MustCompile(`^\{"userCode":"`+started.UserCode+`","name":"laptop","createdAt":"`+iso+`","expiresAt":"`+iso+`"\}$`).MatchString(view.body) {
		t.Fatalf("describe: %d %s", view.status, view.body)
	}
	c.want("POST", "/ui/api/authorize/"+started.UserCode, `{"approve":"yes"}`, 204, "")
	c.want("POST", "/ui/api/authorize/"+started.UserCode, `{"approve":false}`, 404, unknown)
	if poll, err := PollDevice(started.DeviceCode, time.Now()); err != nil || poll.Status != "denied" {
		t.Fatalf("poll after deny: %+v %v", poll, err)
	}

	c.want("GET", "/ui/api/nothing", "", 404, notFound)
	c.want("PUT", "/ui/api/keys", "", 404, notFound)

	// Log out ends this browser only; lock ends every session.
	other := client()
	other.want("POST", "/ui/api/unlock", `{"passphrase":"test-pass-123"}`, 200, `{"ok":true}`)
	out := c.call("POST", "/ui/api/logout", "")
	if out.status != 204 || out.header.Get("Set-Cookie") != "agentio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" || out.body != "" {
		t.Fatalf("logout: %d %q %q", out.status, out.header.Get("Set-Cookie"), out.body)
	}
	c.want("GET", "/ui/api/session", "", 200, `{"authenticated":false,"locked":false}`)
	other.want("GET", "/ui/api/session", "", 200, `{"authenticated":true,"locked":false}`)
	locked := other.call("POST", "/ui/api/lock", "", "X-Forwarded-Proto", "https")
	if locked.status != 204 || locked.header.Get("Set-Cookie") != "agentio_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" {
		t.Fatalf("lock: %d %q", locked.status, locked.header.Get("Set-Cookie"))
	}
	other.want("GET", "/ui/api/session", "", 200, `{"authenticated":false,"locked":true}`)
	if vault.Unlocked() || KeepaliveRunning() {
		t.Fatal("lock left the vault or the keepalive running")
	}
}

func TestUISessionCookieIsSecureOnlyForExactHTTPS(t *testing.T) {
	_, client := uiServer(t, nil)
	for proto, secure := range map[string]bool{"https": true, "HTTPS": false, "http": false, "": false} {
		ResetLimiters()
		c := client()
		got := c.call("POST", "/ui/api/unlock", `{"passphrase":"test-pass-123"}`, "X-Forwarded-Proto", proto)
		if strings.Contains(got.header.Get("Set-Cookie"), "; Secure;") != secure {
			t.Errorf("X-Forwarded-Proto %q: %q", proto, got.header.Get("Set-Cookie"))
		}
	}
}

func TestUISessionExpiresAfterThirtyIdleMinutes(t *testing.T) {
	var mu sync.Mutex
	now := time.Unix(1_800_000_000, 0)
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	_, client := uiServer(t, clock)
	c := client()
	c.want("POST", "/ui/api/unlock", `{"passphrase":"test-pass-123"}`, 200, `{"ok":true}`)
	// Use keeps it alive past thirty minutes in total.
	advance(29 * time.Minute)
	c.want("GET", "/ui/api/session", "", 200, `{"authenticated":true,"locked":false}`)
	advance(30 * time.Minute)
	c.want("GET", "/ui/api/keys", "", 200, `{"keys":[]}`)
	advance(30*time.Minute + time.Millisecond)
	c.want("GET", "/ui/api/keys", "", 401, unauthorized)
	// The vault itself stays unlocked.
	c.want("GET", "/ui/api/session", "", 200, `{"authenticated":false,"locked":false}`)
}

func TestUIUnlockIsLimitedPerAddress(t *testing.T) {
	_, client := uiServer(t, nil)
	c := client()
	for i := 0; i < 5; i++ {
		c.want("POST", "/ui/api/unlock", `{}`, 400, `{"error":"passphrase is required","code":"INVALID_PARAMS"}`)
	}
	// Counted before the body is read, so even the right passphrase waits.
	c.want("POST", "/ui/api/unlock", `{"passphrase":"test-pass-123"}`, 429, `{"error":"Too many attempts, try again in a minute","code":"RATE_LIMITED"}`)
	if vault.Unlocked() {
		t.Fatal("a limited attempt unlocked the vault")
	}
}
