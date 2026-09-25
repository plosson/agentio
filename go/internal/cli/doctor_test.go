package cli

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/daemon"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// No cli test may reach a daemon the user runs on 7890: unless a test says
// otherwise, the probe dials port 0, where nothing answers.
func init() { daemon.Port = 0 }

// probeAt moves the daemon probe off the fixed port 7890 to a loopback port
// answered by h, or to a closed port when h is nil. No test reaches 7890.
func probeAt(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	saved := daemon.Port
	t.Cleanup(func() { daemon.Port = saved })
	if h == nil {
		daemon.Port = testbox.FreePort(t)
		return
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &httptest.Server{Listener: ln, Config: &http.Server{Handler: h}}
	srv.Start()
	t.Cleanup(srv.Close)
	daemon.Port = ln.Addr().(*net.TCPAddr).Port
}

func healthSays(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(404)
			return
		}
		writeJSON(w, status, body)
	}
}

// doctorVault stores three profiles over two services, one of them without a
// plugin, and an empty service list.
func doctorVault(t *testing.T) {
	t.Helper()
	withVault(t)
	err := vault.Update(func(c *vault.Contents) error {
		var gmail, custom []vault.ProfileValue
		_ = json.Unmarshal([]byte(`["a",{"name":"b","readOnly":true}]`), &gmail)
		_ = json.Unmarshal([]byte(`["x"]`), &custom)
		c.Config.Profiles["gmail"] = gmail
		c.Config.Profiles["custom"] = custom
		c.Config.Profiles["slack"] = []vault.ProfileValue{}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

const (
	vaultMissing  = "✗ Vault              — not configured\n    fix: agentio vault init\n"
	daemonDown    = "! Daemon             — not running\n    fix: agentio daemon start\n"
	daemonUp      = "✓ Daemon             — running\n"
	daemonLocked  = "! Daemon             — running, vault locked\n"
	profilesNone  = "! Profiles           — no services configured\n    fix: agentio <service> profile add (e.g. gmail, slack, telegram)\n"
	profilesThree = "✓ Profiles           — 3 configured\n"
	configUnread  = "✗ Profiles           — cannot read config\n"
)

func vaultAt() string {
	return "✓ Vault              — at " + vault.DefaultVaultPath() + "\n"
}

// Bun's doctor: the vault, the daemon's /health and the profile count, each
// rendered ✓/!/✗ with a fix line; exit 1 only when a check is an error.
func TestDoctorIsBuns(t *testing.T) {
	testbox.Isolate(t)
	probeAt(t, nil)
	code, out, errOut := run(t, "doctor")
	if want := vaultMissing + daemonDown + configUnread; code != 1 || out != want || errOut != "" {
		t.Fatalf("no vault: %d %q\n got %q\nwant %q", code, errOut, out, want)
	}

	withVault(t)
	code, out, errOut = run(t, "doctor")
	if want := vaultAt() + daemonDown + profilesNone; code != 0 || out != want || errOut != "" {
		t.Fatalf("empty vault: %d %q\n got %q\nwant %q", code, errOut, out, want)
	}

	doctorVault(t)
	health := []struct {
		name, body string
		status     int
		want       string
	}{
		{"ok", `{"status":"ok","timestamp":1,"uptime":1,"locked":false}`, 200, daemonUp},
		{"locked", `{"status":"ok","locked":true}`, 200, daemonLocked},
		{"no locked field", `{"status":"ok"}`, 200, daemonUp},
		{"truthy locked", `{"locked":"no"}`, 200, daemonLocked},
		{"falsy locked", `{"locked":0}`, 200, daemonUp},
		{"a string body", `"up"`, 200, daemonUp},
		{"an array body", `[]`, 200, daemonUp},
		{"null body", `null`, 200, daemonDown},
		{"false body", `false`, 200, daemonDown},
		{"not JSON", `not json`, 200, daemonDown},
		{"a 500", `{"status":"ok","locked":false}`, 500, daemonDown},
		{"a 204", ``, 204, daemonDown},
	}
	for _, h := range health {
		probeAt(t, healthSays(h.status, h.body))
		code, out, errOut = run(t, "doctor")
		if want := vaultAt() + h.want + profilesThree; code != 0 || out != want || errOut != "" {
			t.Errorf("%s: %d %q\n got %q\nwant %q", h.name, code, errOut, out, want)
		}
	}

	// A daemon that never answers is not running after Bun's 1.5 s.
	probeAt(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	started := time.Now()
	code, out, _ = run(t, "doctor")
	if want := vaultAt() + daemonDown + profilesThree; code != 0 || out != want {
		t.Errorf("hanging daemon: %d\n got %q\nwant %q", code, out, want)
	}
	if took := time.Since(started); took < 1400*time.Millisecond || took > 3*time.Second {
		t.Errorf("hanging daemon took %v, want about 1.5s", took)
	}

	// Without the passphrase the config cannot be read: an error.
	probeAt(t, nil)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	vault.Reset()
	if err := os.Remove(vault.PassphrasePath()); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	code, out, errOut = run(t, "doctor")
	if want := vaultAt() + daemonDown + configUnread; code != 1 || out != want || errOut != "" {
		t.Errorf("no passphrase: %d %q\n got %q\nwant %q", code, errOut, out, want)
	}

	// The pointer is read with trim(); a missing vault file is not configured.
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := os.WriteFile(vault.PointerPath(), []byte("  "+vault.DefaultVaultPath()+" \n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, _ = run(t, "doctor")
	if want := vaultAt() + daemonDown + profilesThree; code != 0 || out != want {
		t.Errorf("padded pointer: %d\n got %q\nwant %q", code, out, want)
	}
	if err := os.Rename(vault.DefaultVaultPath(), vault.DefaultVaultPath()+".away"); err != nil {
		t.Fatal(err)
	}
	code, out, _ = run(t, "doctor")
	if want := vaultMissing + daemonDown + configUnread; code != 1 || out != want {
		t.Errorf("vault file gone: %d\n got %q\nwant %q", code, out, want)
	}

	// An unreadable pointer is Node's read error, not "not configured".
	if err := os.Remove(vault.PointerPath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(vault.PointerPath(), 0o700); err != nil {
		t.Fatal(err)
	}
	code, out, errOut = run(t, "doctor")
	if code != 1 || out != "" || errOut != "Error: EISDIR: illegal operation on a directory, read\n" {
		t.Errorf("pointer is a directory: %d %q %q", code, out, errOut)
	}
}

// In remote mode doctor asks the hub once and checks nothing local.
func TestDoctorInRemoteModeChecksTheHub(t *testing.T) {
	testbox.Isolate(t)
	probeAt(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("remote doctor probed the daemon: %s", r.URL)
	})
	listing := `{"profiles":[{"service":"gmail","name":"a","readOnly":false,"hasCredentials":true},{"service":"slack","name":"b","readOnly":true,"hasCredentials":false}]`
	cases := []struct {
		name   string
		status int
		body   string
		code   int
		want   func(url string) string
	}{
		{"ok", 200, listing + `,"canManageProfiles":false}`, 0, func(u string) string {
			return "✓ Hub                — " + u + ", 2 profile(s) allowed for this token\n"
		}},
		{"manage", 200, listing + `,"canManageProfiles":true}`, 0, func(u string) string {
			return "✓ Hub                — " + u + ", 2 profile(s) allowed for this token, can manage profiles\n"
		}},
		{"old hub", 200, listing + `}`, 0, func(u string) string {
			return "✓ Hub                — " + u + ", 2 profile(s) allowed for this token\n"
		}},
		{"rejected", 401, `{"error":"Invalid or missing token","code":"AUTH_FAILED","suggestion":"Set AGENTIO_TOKEN to a token from the hub"}`, 1, func(string) string {
			return "✗ Hub                — The vault hub rejected this token: Invalid or missing token\n    fix: Get a new token from the hub admin UI, or `agentio key create` on the hub host\n"
		}},
		{"locked", 503, `{"error":"Vault is locked","code":"VAULT_LOCKED","suggestion":"Unlock it at /ui"}`, 1, func(u string) string {
			return "✗ Hub                — The vault is locked on the hub\n    fix: Unlock it at " + u + "/ui\n"
		}},
		{"plain 500", 500, "boom  ", 1, func(string) string { return "✗ Hub                — HTTP 500\n" }},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/profiles" {
				t.Errorf("%s: hub asked for %s", c.name, r.URL)
			}
			w.WriteHeader(c.status)
			_, _ = io.WriteString(w, c.body)
		}))
		token, _ := auth.EncodeToken(auth.TokenParts{URL: srv.URL, Kid: "k1", Secret: "sec"})
		t.Setenv("AGENTIO_TOKEN", token)
		auth.Reset()
		code, out, errOut := run(t, "doctor")
		if want := c.want(srv.URL); code != c.code || out != want || errOut != "" {
			t.Errorf("%s: %d %q\n got %q\nwant %q", c.name, code, errOut, out, want)
		}
		srv.Close()
	}

	down := "http://127.0.0.1:" + strconv.Itoa(testbox.FreePort(t))
	token, _ := auth.EncodeToken(auth.TokenParts{URL: down, Kid: "k1", Secret: "sec"})
	t.Setenv("AGENTIO_TOKEN", token)
	auth.Reset()
	code, out, _ := run(t, "doctor")
	want := "✗ Hub                — Cannot reach the vault hub at " + down + ": Unable to connect. Is the computer able to access the url?\n    fix: Check the network, and that the hub daemon is running\n"
	if code != 1 || out != want {
		t.Errorf("hub down: %d\n got %q\nwant %q", code, out, want)
	}

	t.Setenv("AGENTIO_TOKEN", "agio1.xx")
	auth.Reset()
	code, out, errOut := run(t, "doctor")
	if code != 3 || out != "" || errOut != "Error [CONFIG_ERROR]: Malformed AGENTIO_TOKEN\nSuggestion: Paste the token exactly as the hub showed it\n" {
		t.Errorf("malformed token: %d %q %q", code, out, errOut)
	}
}

// Bun's daemon status is doctor's daemon check alone, exit 0 either way.
func TestDaemonStatusProbesTheDaemon(t *testing.T) {
	withVault(t)
	probeAt(t, nil)
	cases := []struct {
		name string
		h    http.HandlerFunc
		want string
	}{
		{"down", nil, daemonDown},
		{"up", healthSays(200, `{"status":"ok","locked":false}`), daemonUp},
		{"locked", healthSays(200, `{"status":"ok","locked":true}`), daemonLocked},
		{"unhealthy", healthSays(503, `{"status":"ok","locked":false}`), daemonDown},
	}
	for _, c := range cases {
		probeAt(t, c.h)
		code, out, errOut := run(t, "daemon", "status")
		if code != 0 || out != c.want || errOut != "" {
			t.Errorf("%s: %d %q\n got %q\nwant %q", c.name, code, errOut, out, c.want)
		}
	}
	// It stays gated on the vault and refused in remote mode, like Bun.
	testbox.Isolate(t)
	probeAt(t, func(w http.ResponseWriter, r *http.Request) { t.Error("gated daemon status probed the daemon") })
	code, out, errOut := run(t, "daemon", "status")
	if code != 2 || out != "" || !strings.HasPrefix(errOut, "Error [VAULT_NOT_CONFIGURED]: No vault configured\n") {
		t.Errorf("no vault: %d %q %q", code, out, errOut)
	}
	// Naming the hub in the remote-mode refusal needs the token: a malformed
	// one is its own error, as for every owner-only command.
	t.Setenv("AGENTIO_TOKEN", "agio1.xx")
	auth.Reset()
	for _, args := range [][]string{{"daemon", "status"}, {"vault", "status"}} {
		code, out, errOut = run(t, args...)
		if code != 3 || out != "" || errOut != "Error [CONFIG_ERROR]: Malformed AGENTIO_TOKEN\nSuggestion: Paste the token exactly as the hub showed it\n" {
			t.Errorf("%v with a malformed token: %d %q %q", args, code, out, errOut)
		}
	}
}
