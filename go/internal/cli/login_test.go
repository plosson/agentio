package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// fakeHub answers the device endpoints like the daemon (device.go): start
// returns a code, each poll takes the next scripted answer.
type fakeHub struct {
	t        *testing.T
	start    func(w http.ResponseWriter, body map[string]any)
	polls    []func(w http.ResponseWriter)
	mu       sync.Mutex
	names    []string
	pollAt   []time.Time
	requests int
}

func (h *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.requests++
	var body map[string]any
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &body)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/device":
		if name, ok := body["name"].(string); ok {
			h.names = append(h.names, name)
		}
		h.start(w, body)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/device/token":
		if body["deviceCode"] != "dev-code" {
			h.t.Errorf("poll with device code %v", body["deviceCode"])
		}
		h.pollAt = append(h.pollAt, time.Now())
		if len(h.polls) == 0 {
			writeJSON(w, 200, `{"status":"pending"}`)
			return
		}
		next := h.polls[0]
		if len(h.polls) > 1 {
			h.polls = h.polls[1:]
		}
		next(w)
	default:
		writeJSON(w, 404, `{"error":"Not found","code":"NOT_FOUND"}`)
	}
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func started(expiresIn, interval string) func(http.ResponseWriter, map[string]any) {
	return func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, 200, `{"userCode":"BCDF-GHJK","deviceCode":"dev-code","expiresIn":`+expiresIn+`,"interval":`+interval+`}`)
	}
}

func answer(status int, body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) { writeJSON(w, status, body) }
}

const approved = `{"status":"approved","token":"agio1.test-token","key":{"id":"k1","name":"box","allowedProfiles":["slack/ops"],"readOnly":true,"createdAt":"2026-01-01T00:00:00.000Z","canManageProfiles":false}}`

// loginEnv isolates HOME, records browser opens, and polls every 5 ms.
func loginEnv(t *testing.T, hub *fakeHub) (string, *[]string) {
	t.Helper()
	testbox.Isolate(t)
	hub.t = t
	srv := httptest.NewServer(hub)
	t.Cleanup(srv.Close)
	var opened []string
	savedOpen, savedPoll := openBrowser, loginPoll
	openBrowser = func(u string) bool { opened = append(opened, u); return true }
	loginPoll = 5 * time.Millisecond
	t.Cleanup(func() { openBrowser, loginPoll = savedOpen, savedPoll })
	return srv.URL, &opened
}

func TestLoginApprovedStoresTheTokenAndSaysWhatBunSays(t *testing.T) {
	hub := &fakeHub{start: started("600", "3"), polls: []func(http.ResponseWriter){
		answer(200, `{"status":"pending"}`), answer(200, `{"status":"pending"}`), answer(200, approved)}}
	url, opened := loginEnv(t, hub)
	code, out, errOut := run(t, "login", url+"/ui/", "--name", "  build-box  ")
	wantErr := "Your code: BCDF-GHJK\nApprove it at " + url + "/ui#authorize=BCDF-GHJK within 10 minutes.\nOpened it in your browser.\nWaiting for approval…\n"
	wantOut := "Signed in to " + url + " as key \"box\" (k1): slack/ops, read-only\nToken stored in " + vault.TokenPath() + ". Every agentio command on this machine now uses the hub.\n"
	if code != 0 || out != wantOut || errOut != wantErr {
		t.Fatalf("code %d\nstdout %q\nwant   %q\nstderr %q\nwant   %q", code, out, wantOut, errOut, wantErr)
	}
	if len(*opened) != 1 || (*opened)[0] != url+"/ui#authorize=BCDF-GHJK" {
		t.Errorf("opened %v", *opened)
	}
	if len(hub.names) != 1 || hub.names[0] != "build-box" {
		t.Errorf("name sent %v", hub.names)
	}
	if len(hub.pollAt) != 3 {
		t.Errorf("polled %d times, want 3", len(hub.pollAt))
	}
	raw, err := os.ReadFile(vault.TokenPath())
	info, _ := os.Stat(vault.TokenPath())
	if err != nil || string(raw) != "agio1.test-token\n" || info.Mode().Perm() != 0o600 {
		t.Errorf("token file %q %v %v", raw, err, info.Mode())
	}
}

func TestLoginNoBrowserBlankNameAndABareHost(t *testing.T) {
	hub := &fakeHub{start: started("90", "3"), polls: []func(http.ResponseWriter){answer(200, approved)}}
	url, opened := loginEnv(t, hub)
	code, _, errOut := run(t, "login", url, "--no-browser", "--name", "   ")
	host, _ := os.Hostname()
	if code != 0 || len(*opened) != 0 || strings.Contains(errOut, "Opened") || !strings.Contains(errOut, " within 2 minutes.\n") {
		t.Fatalf("code %d opened %v\n%s", code, *opened, errOut)
	}
	if len(hub.names) != 1 || hub.names[0] != host {
		t.Errorf("name %v, want the hostname %q", hub.names, host)
	}
	// A browser that cannot open says nothing about it.
	openBrowser = func(string) bool { return false }
	hub.polls = []func(http.ResponseWriter){answer(200, approved)}
	if code, _, errOut := run(t, "login", url); code != 0 || strings.Contains(errOut, "Opened") {
		t.Errorf("code %d\n%s", code, errOut)
	}
	// Without a scheme the hub is https: the plain-http fake cannot answer it.
	bare := strings.TrimPrefix(url, "http://")
	code, out, errOut := run(t, "login", bare)
	if code == 0 || out != "" || !strings.HasPrefix(errOut, "Error [NETWORK_ERROR]: Cannot reach the vault hub at https://"+bare+": ") {
		t.Errorf("bare host: %d %q %q", code, out, errOut)
	}
	if origin, err := profile.HubOrigin("vault.example.com"); err != nil || origin != "https://vault.example.com" {
		t.Errorf("HubOrigin: %q %v", origin, err)
	}
	if origin, err := profile.HubOrigin("HTTP://Vault.Example.com:8443/ui/"); err != nil || origin != "http://vault.example.com:8443" {
		t.Errorf("HubOrigin keeps the scheme: %q %v", origin, err)
	}
	for _, bad := range []string{"ftp://x", "not a url"} {
		if _, err := profile.HubOrigin(bad); err == nil {
			t.Errorf("HubOrigin(%q) accepted", bad)
		}
	}
}

func TestLoginRefusesWhenAgentioTokenIsSet(t *testing.T) {
	hub := &fakeHub{start: started("600", "3")}
	url, _ := loginEnv(t, hub)
	t.Setenv("AGENTIO_TOKEN", "agio1.from-env")
	code, out, errOut := run(t, "login", url)
	want := "Error [CONFIG_ERROR]: AGENTIO_TOKEN is set, so a stored login would be ignored\nSuggestion: Unset AGENTIO_TOKEN first, or keep using it\n"
	if code != 3 || out != "" || errOut != want || hub.requests != 0 {
		t.Fatalf("code %d %q %q, %d requests", code, out, errOut, hub.requests)
	}
}

func TestLoginExplainsAServerThatIsNoHub(t *testing.T) {
	for name, start := range map[string]func(http.ResponseWriter, map[string]any){
		"404": func(w http.ResponseWriter, _ map[string]any) { http.NotFound(w, nil) },
		"old hub 401": func(w http.ResponseWriter, _ map[string]any) {
			writeJSON(w, 401, `{"error":"Missing token","code":"AUTH_FAILED"}`)
		},
		"landing page":   func(w http.ResponseWriter, _ map[string]any) { _, _ = io.WriteString(w, "<html>hi</html>") },
		"empty 200":      func(w http.ResponseWriter, _ map[string]any) {},
		"no device code": func(w http.ResponseWriter, _ map[string]any) { writeJSON(w, 200, `{"userCode":"X"}`) },
		"numeric code":   func(w http.ResponseWriter, _ map[string]any) { writeJSON(w, 200, `{"userCode":1,"deviceCode":"d"}`) },
		"json array":     func(w http.ResponseWriter, _ map[string]any) { writeJSON(w, 200, `[]`) },
	} {
		t.Run(name, func(t *testing.T) {
			url, opened := loginEnv(t, &fakeHub{start: start})
			code, out, errOut := run(t, "login", url)
			want := "Error [CONFIG_ERROR]: " + url + " does not offer device login\nSuggestion: Is this the hub URL, and is the hub up to date?\n"
			if code != 3 || out != "" || errOut != want || len(*opened) != 0 {
				t.Fatalf("code %d %q\n got %q\nwant %q", code, out, errOut, want)
			}
		})
	}
	// Any other refusal is the hub's own error.
	url, _ := loginEnv(t, &fakeHub{start: func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, 429, `{"error":"Too many logins waiting for approval, try again in a few minutes","code":"RATE_LIMITED"}`)
	}})
	if code, _, errOut := run(t, "login", url); code != 5 || errOut != "Error [RATE_LIMITED]: Too many logins waiting for approval, try again in a few minutes\n" {
		t.Errorf("rate-limited start: %d %q", code, errOut)
	}
}

func TestLoginDeniedExpiredAndForgotten(t *testing.T) {
	expired := "Error [AUTH_FAILED]: The login code expired before it was approved\nSuggestion: Run `agentio login` again and approve within ten minutes\n"
	cases := []struct {
		name, expiresIn string
		polls           []func(http.ResponseWriter)
		want            string
		maxPolls        int
	}{
		{"denied", "600", []func(http.ResponseWriter){answer(200, `{"status":"pending"}`), answer(200, `{"status":"denied"}`)},
			"Error [AUTH_FAILED]: The hub owner denied this login\n", 2},
		// The hub forgot the code (restart, expiry): the wait ends at once.
		{"forgotten", "600", []func(http.ResponseWriter){answer(404, `{"error":"Unknown or expired code","code":"NOT_FOUND"}`)}, expired, 1},
		// Never decided: the wait ends at the hub's expiry.
		{"never decided", "0.2", nil, expired, 1000},
		// No expiry from the hub: nothing is polled.
		{"no expiry", "null", nil, expired, 0},
		{"server error", "600", []func(http.ResponseWriter){answer(500, `{"error":"boom"}`)}, "Error [API_ERROR]: boom\n", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			hub := &fakeHub{start: started(c.expiresIn, "3"), polls: c.polls}
			url, _ := loginEnv(t, hub)
			began := time.Now()
			code, out, errOut := run(t, "login", url)
			if code == 0 || out != "" || !strings.HasSuffix(errOut, "Waiting for approval…\n"+c.want) {
				t.Fatalf("code %d %q\n%s", code, out, errOut)
			}
			if len(hub.pollAt) > c.maxPolls || time.Since(began) > 5*time.Second {
				t.Errorf("%d polls in %v", len(hub.pollAt), time.Since(began))
			}
			if _, err := os.Stat(vault.TokenPath()); err == nil {
				t.Error("a token was stored")
			}
		})
	}
	// "within N minutes" is Math.round(expiresIn / 60); no expiry is NaN.
	hub := &fakeHub{start: started("null", "3")}
	url, _ := loginEnv(t, hub)
	hub.start = func(w http.ResponseWriter, _ map[string]any) {
		writeJSON(w, 200, `{"userCode":"BCDF-GHJK","deviceCode":"dev-code"}`)
	}
	if _, _, errOut := run(t, "login", url); !strings.Contains(errOut, " within NaN minutes.\n") {
		t.Errorf("no expiresIn:\n%s", errOut)
	}
}

// RATE_LIMITED doubles the wait before the next poll; the hub's interval is
// the starting wait.
func TestLoginBacksOffWhenThePollIsRateLimited(t *testing.T) {
	slow := answer(429, `{"error":"Too many login requests from this address, slow down","code":"RATE_LIMITED"}`)
	hub := &fakeHub{start: started("600", "0.02"), polls: []func(http.ResponseWriter){slow, slow, slow, answer(200, approved)}}
	url, _ := loginEnv(t, hub)
	loginPoll = 0
	var waits []time.Duration
	savedSleep := loginSleep
	loginSleep = func(d time.Duration) { waits = append(waits, d) }
	t.Cleanup(func() { loginSleep = savedSleep })
	if code, _, errOut := run(t, "login", url); code != 0 {
		t.Fatalf("code %d\n%s", code, errOut)
	}
	want := []time.Duration{20 * time.Millisecond, 40 * time.Millisecond, 80 * time.Millisecond, 160 * time.Millisecond}
	if len(waits) != len(want) {
		t.Fatalf("waits %v, want %v", waits, want)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits %v, want %v", waits, want)
		}
	}
}

func TestLogoutSaysWhatBunSays(t *testing.T) {
	testbox.Isolate(t)
	if code, out, errOut := run(t, "logout"); code != 0 || out != "No stored login on this machine.\n" || errOut != "" {
		t.Errorf("no login: %d %q %q", code, out, errOut)
	}
	t.Setenv("AGENTIO_TOKEN", "agio1.from-env")
	if code, out, _ := run(t, "logout"); code != 0 || out != "No stored login. This machine uses AGENTIO_TOKEN; unset it to leave remote mode.\n" {
		t.Errorf("env token: %d %q", code, out)
	}
	path, err := auth.SaveRemoteToken("agio1.stored")
	if err != nil {
		t.Fatal(err)
	}
	// A stored file is removed even while AGENTIO_TOKEN is set.
	if code, out, _ := run(t, "logout"); code != 0 || out != "Removed "+path+". The key still exists on the hub; revoke it there if it should stop working.\n" {
		t.Errorf("stored: %d %q", code, out)
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("token file still there")
	}
}
