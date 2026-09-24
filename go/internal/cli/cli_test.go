package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, err bytes.Buffer
	code := Execute(plugins.Default, args, &out, &err, strings.NewReader(""))
	return code, out.String(), err.String()
}

func initCLI(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
}

func TestDocsDoNotNeedAVault(t *testing.T) {
	initCLI(t)
	code, out, errOut := run(t, "docs")
	if code != 0 || !strings.Contains(out, `"service": "acme"`) || !strings.Contains(out, `"service": "ping"`) {
		t.Fatalf("code %d\n%s\n%s", code, out, errOut)
	}
	code, out, errOut = run(t, "plugin", "list")
	if code != 0 || !strings.Contains(out, "refreshable") || !strings.Contains(out, "static") || !strings.Contains(out, "no-profile") {
		t.Fatalf("code %d\n%s\n%s", code, out, errOut)
	}
	code, _, errOut = run(t, "acme", "whoami")
	if code != 2 || !strings.Contains(errOut, "VAULT_NOT_CONFIGURED") {
		t.Fatalf("missing vault code %d %s", code, errOut)
	}
}

func TestCommandUsesFreshCredentialsAndRefusesReadOnlyWrites(t *testing.T) {
	initCLI(t)
	code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate")
	if code != 0 {
		t.Fatal(errOut)
	}
	code, _, errOut = run(t, "vault", "init", "--passphrase", "test-pass-123")
	if code == 0 || !strings.Contains(errOut, "already configured") {
		t.Fatalf("second init code %d %s", code, errOut)
	}
	if err := profile.Save("acme", "ada", map[string]any{
		"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(1),
	}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "acme", "whoami", "--json")
	if code != 0 || !strings.Contains(out, "fresh:old") {
		t.Fatalf("code %d\n%s\n%s", code, out, errOut)
	}
	stored, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Credentials["acme"]["ada"]["refreshToken"] != "rot:rt" {
		t.Fatalf("command did not persist refresh: %#v", stored.Credentials["acme"]["ada"])
	}
	if _, err := profile.SetReadOnly("acme", "ada", true); err != nil {
		t.Fatal(err)
	}
	code, out, errOut = run(t, "acme", "items", "add", "Widget")
	if code != 2 || !strings.Contains(errOut, "PERMISSION_DENIED") || strings.Contains(out, "Widget") {
		t.Fatalf("read-only write code %d\nout %s\nerr %s", code, out, errOut)
	}
	code, out, errOut = run(t, "ping", "once")
	if code != 0 || strings.TrimSpace(out) != "pong" {
		t.Fatalf("ping %d %q %s", code, out, errOut)
	}
	code, out, errOut = run(t, "skill", "board")
	if code != 0 || !strings.Contains(out, "agentio board cards create") {
		t.Fatalf("skill %d %s %s", code, out, errOut)
	}
}

func TestExportDropsReadOnlyAndImportDoesNotInventIt(t *testing.T) {
	initCLI(t)
	if code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate"); code != 0 {
		t.Fatal(errOut)
	}
	if err := profile.Save("board", "desk", map[string]any{"token": "sek", "workspace": "desk"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "vault", "export", "--all", "--key", strings.Repeat("ab", 32))
	if code != 0 {
		t.Fatal(errOut)
	}
	config := ""
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "AGENTIO_CONFIG=") {
			config = strings.TrimPrefix(line, "AGENTIO_CONFIG=")
		}
	}
	if config == "" {
		t.Fatalf("no config in %s", out)
	}
	plain, err := vault.Decrypt(config, strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, "readOnly") {
		t.Fatalf("export kept read-only, unlike the bun exporter: %s", plain)
	}
	if _, err := profile.Delete("board", "desk"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTIO_CONFIG", config)
	t.Setenv("AGENTIO_KEY", strings.Repeat("ab", 32))
	code, _, errOut = run(t, "vault", "import")
	if code != 0 {
		t.Fatal(errOut)
	}
	ro, err := profile.IsReadOnly("board", "desk")
	if err != nil || ro {
		t.Fatalf("imported profile read-only = %v %v", ro, err)
	}
	c, _ := vault.Load()
	if c.Credentials["board"]["desk"]["token"] != "sek" {
		t.Fatalf("%#v", c.Credentials)
	}
}
