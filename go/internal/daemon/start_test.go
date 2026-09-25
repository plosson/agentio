package daemon

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// captureLog sends the daemon's stdout lines to a buffer for the test.
func captureLog(t *testing.T) *lockedLog {
	t.Helper()
	logs := &lockedLog{}
	restore := SetOutput(logs)
	t.Cleanup(restore)
	return logs
}

// iso is Bun's new Date().toISOString() at the start of a daemonLog line.
const iso = `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z `

func wantLines(t *testing.T, what, got string, patterns ...string) {
	t.Helper()
	re := regexp.MustCompile(`\A` + strings.Join(patterns, `\n`) + `\n\z`)
	if !re.MatchString(got) {
		t.Errorf("%s:\n got %q\nwant %q", what, got, strings.Join(patterns, "\n"))
	}
}

// Bun's daemonLog: `<ISO> <subsystem> k=v …` on stdout, values unquoted.
func TestKeepaliveLinesAreBunsDaemonLog(t *testing.T) {
	isolate(t)
	logs := captureLog(t)
	reg, err := plugins.NewRegistry(acme.New())
	if err != nil {
		t.Fatal(err)
	}
	RunRefreshPass(context.Background(), reg)
	wantLines(t, "locked", logs.take(), iso+`keepalive outcome=skipped reason=vault is locked`)

	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "ada", testbox.Object(map[string]any{
		"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(1),
	}), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	// Bun's hasStored is `!!store[service]?.[name]`: a stored null is nothing
	// stored, so the pass skips it rather than failing it.
	if err := vault.Update(func(c *vault.Contents) error {
		c.Config.Profiles.Set("acme", append(c.Config.Profiles.Get("acme"), vault.ProfileValue{Name: "nul"}, vault.ProfileValue{Name: "none"}))
		c.Credentials.SetRaw("acme", "nul", nil)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	logs.take()
	RunRefreshPass(context.Background(), reg)
	wantLines(t, "pass", logs.take(), iso+`keepalive outcome=pass refreshed=1 fresh=0 skipped=2 failed=0`)
}

func request(t *testing.T, method, url, token, body string) int {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

// Bun audits save, rename and delete like credentials: one line per keyed
// write that got past its input checks, the outcome ok or the lowercase code.
func TestProfileWritesAreAudited(t *testing.T) {
	srv, _, issued := setup(t)
	logs := captureLog(t)
	key := regexp.QuoteMeta(issued.Key.ID + " (agent)")
	base := srv.URL + "/v1/profiles/acme/"
	steps := []struct {
		method, path, body string
		status             int
		line               string
	}{
		{http.MethodPut, "bea", `{"credentials":{"account":"bea"}}`, 201, `v1 action=save key=` + key + ` profile=acme/bea outcome=ok`},
		{http.MethodPut, "bea", `{"credentials":{}}`, 400, ""},
		{http.MethodPut, "bea", `not json`, 400, ""},
		{http.MethodPatch, "bea", `{"name":"ada"}`, 400, `v1 action=rename key=` + key + ` profile=acme/bea outcome=invalid_params`},
		{http.MethodPatch, "bea", `{"name":7}`, 400, ""},
		{http.MethodPatch, "bea", `{"name":"cy"}`, 200, `v1 action=rename key=` + key + ` profile=acme/bea outcome=ok`},
		{http.MethodDelete, "bea", ``, 404, `v1 action=delete key=` + key + ` profile=acme/bea outcome=profile_not_found`},
		{http.MethodDelete, "cy", ``, 204, `v1 action=delete key=` + key + ` profile=acme/cy outcome=ok`},
	}
	for _, s := range steps {
		if got := request(t, s.method, base+s.path, issued.Token, s.body); got != s.status {
			t.Fatalf("%s %s %s = %d, want %d", s.method, s.path, s.body, got, s.status)
		}
		if s.line == "" {
			if got := logs.take(); got != "" {
				t.Errorf("%s %s %s logged %q", s.method, s.path, s.body, got)
			}
			continue
		}
		wantLines(t, s.method+" "+s.path+" "+s.body, logs.take(), iso+s.line)
	}
	// A refused key never reaches the audited span.
	narrow, err := profile.CreateKey(profile.KeyInput{Name: "reader", AllowedProfiles: "*", ReadOnly: true}, "http://hub.example")
	if err != nil {
		t.Fatal(err)
	}
	if got := request(t, http.MethodDelete, base+"ada", narrow.Token, ""); got != 403 {
		t.Fatalf("unmanaged delete = %d", got)
	}
	if got := logs.take(); got != "" {
		t.Errorf("unmanaged delete logged %q", got)
	}
	// Credentials: ok carries refreshed; a failure carries the code alone.
	if got := request(t, http.MethodPost, base+"ada/credentials", issued.Token, ""); got != 200 {
		t.Fatalf("credentials = %d", got)
	}
	wantLines(t, "credentials", logs.take(), iso+`v1 action=credentials key=`+key+` profile=acme/ada outcome=ok refreshed=true`)
}

// Bun's requestIP gives a bare IPv6 address, the rate-limit bucket key.
func TestClientIPOfAnIPv6PeerIsBare(t *testing.T) {
	testbox.Isolate(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	for addr, want := range map[string]string{"[::1]:5000": "::1", "[fe80::1%lo0]:80": "fe80::1%lo0", "10.0.0.1:9": "10.0.0.1"} {
		req.RemoteAddr = addr
		if got := ClientIP(req); got != want {
			t.Errorf("%s: %q, want %q", addr, got, want)
		}
	}
}

// startOn runs the daemon on a loopback port and returns once it is ready.
func startOn(t *testing.T, reg *plugins.Registry) (int, *lockedLog, chan error) {
	t.Helper()
	logs := captureLog(t)
	savedHost, savedPort := Host, Port
	Host, Port = "127.0.0.1", testbox.FreePort(t)
	t.Cleanup(func() { Host, Port = savedHost, savedPort })
	done := make(chan error, 1)
	go func() { done <- Run(reg, "test") }()
	for i := 0; ; i++ {
		if strings.Contains(logs.snapshot(), "Daemon ready\n") {
			return Port, logs, done
		}
		select {
		case err := <-done:
			t.Fatalf("daemon ended early: %v\n%s", err, logs.take())
		case <-time.After(10 * time.Millisecond):
		}
		if i > 300 {
			t.Fatalf("daemon not ready:\n%s", logs.take())
		}
	}
}

func stopWith(t *testing.T, sig syscall.Signal, done chan error) {
	t.Helper()
	if err := syscall.Kill(os.Getpid(), sig); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon stopped with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon ignored the signal")
	}
}

// Bun's startDaemon: its stdout lines in order, the first keepalive pass after
// "Daemon ready", and a clean stop on SIGINT or SIGTERM.
func TestStartAndSignalsAreBuns(t *testing.T) {
	isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	t.Setenv("AGENTIO_KEEPALIVE_HOURS", "1.5")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(acme.New())
	if err != nil {
		t.Fatal(err)
	}
	port, logs, done := startOn(t, reg)
	t.Cleanup(func() { vault.SetMemoryOnly(false) })
	if os.Getenv("AGENTIO_PASSPHRASE") != "" {
		t.Error("the env passphrase is still set after the unlock")
	}
	res, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/health")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health: %v", err)
	}
	res.Body.Close()
	for i := 0; i < 300 && !strings.Contains(logs.snapshot(), "keepalive outcome="); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	stopWith(t, syscall.SIGTERM, done)
	p := strconv.Itoa(port)
	wantLines(t, "unlocked start", logs.take(),
		fmt.Sprintf(`agentio-daemon starting \(PID %d\)`, os.Getpid()),
		`Vault unlocked from AGENTIO_PASSPHRASE`,
		`Token keepalive every 1\.5h`,
		`Daemon API listening on 127\.0\.0\.1:`+p,
		`Admin UI at http://127\.0\.0\.1:`+p+`/ui`,
		`Daemon ready`,
		iso+`keepalive outcome=pass refreshed=0 fresh=0 skipped=0 failed=0`,
		``,
		`Received SIGTERM, shutting down\.\.\.`,
		`Daemon stopped`)
	if KeepaliveRunning() {
		t.Error("keepalive still running after the stop")
	}
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+p, time.Second); err == nil {
		t.Error("the server still accepts connections after the stop")
	}

	vault.Lock()
	vault.SetMemoryOnly(false)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	_, logs, done = startOn(t, reg)
	stopWith(t, syscall.SIGINT, done)
	wantLines(t, "locked start", logs.take(),
		`agentio-daemon starting \(PID \d+\)`,
		`Vault is locked`,
		`Daemon API listening on 127\.0\.0\.1:\d+`,
		`Admin UI at http://127\.0\.0\.1:\d+/ui`,
		`Daemon ready`,
		``,
		`Received SIGINT, shutting down\.\.\.`,
		`Daemon stopped`)
}

// A wrong passphrase stops the start after its first line; a busy port is
// Bun.serve's message.
func TestStartFailuresAreBuns(t *testing.T) {
	isolate(t)
	t.Cleanup(func() { vault.SetMemoryOnly(false) })
	logs := captureLog(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTIO_PASSPHRASE", "wrong-pass-123")
	savedHost, savedPort := Host, Port
	t.Cleanup(func() { Host, Port = savedHost, savedPort })
	Host, Port = "127.0.0.1", testbox.FreePort(t)
	err := Run(nil, "test")
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != clierr.AuthFailed || ce.Message != "Wrong passphrase for vault" {
		t.Fatalf("wrong passphrase: %#v", err)
	}
	wantLines(t, "wrong passphrase", logs.take(), `agentio-daemon starting \(PID \d+\)`)

	t.Setenv("AGENTIO_PASSPHRASE", "")
	vault.SetMemoryOnly(false)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	Port = busy.Addr().(*net.TCPAddr).Port
	err = Run(nil, "test")
	if want := "Failed to start server. Is port " + strconv.Itoa(Port) + " in use?"; err == nil || err.Error() != want {
		t.Fatalf("busy port: %v, want %q", err, want)
	}
	wantLines(t, "busy port", logs.take(), `agentio-daemon starting \(PID \d+\)`, `Vault is locked`)
}
