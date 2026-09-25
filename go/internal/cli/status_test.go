package cli

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// statusVault stores board/desk (read-only), board/old (readOnly:false stated
// in the vault), board/none (no credentials) and custom/x (no plugin).
func statusVault(t *testing.T) {
	t.Helper()
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	err := vault.Update(func(c *vault.Contents) error {
		var board, custom []vault.ProfileValue
		if err := json.Unmarshal([]byte(`[{"name":"desk","readOnly":true},{"name":"old","readOnly":false},"none"]`), &board); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(`["x"]`), &custom); err != nil {
			return err
		}
		c.Config.Profiles.Set("board", board)
		c.Config.Profiles.Set("custom", custom)
		c.Credentials.Put("board", "desk", testbox.Object(map[string]any{"token": "t", "workspace": "W"}))
		c.Credentials.Put("board", "old", testbox.Object(map[string]any{"token": "expired"}))
		c.Credentials.Put("custom", "x", testbox.Object(map[string]any{"k": "v"}))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Bun's status: a version and config header, aligned rows with ok/ERR/-,
// [RO], and its own empty state.
func TestStatusTextIsBuns(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	header := "agentio v" + Version + "\nConfig: " + vault.ConfigDir() + "\n\n"
	code, out, errOut := run(t, "status")
	if want := header + "No profiles configured.\nRun: agentio <service> profile add\n"; code != 0 || out != want || errOut != "" {
		t.Fatalf("empty: code %d %q\n got %q\nwant %q", code, errOut, out, want)
	}
	statusVault(t)
	code, out, errOut = run(t, "status")
	want := header +
		"board   desk [RO]  ok   Workspace: W\n" +
		"board   old        ERR  token rejected\n" +
		"board   none       ERR  no credentials\n" +
		"custom  x          ERR  plugin is not installed in this agentio build\n"
	if code != 0 || out != want || errOut != "" {
		t.Fatalf("code %d %q\n got %q\nwant %q", code, errOut, out, want)
	}
	code, out, _ = run(t, "status", "--no-test")
	want = header +
		"board   desk [RO]  -\n" +
		"board   old        -\n" +
		"board   none       ERR  no credentials\n" +
		"custom  x          -\n"
	if code != 0 || out != want {
		t.Fatalf("--no-test: code %d\n got %q\nwant %q", code, out, want)
	}
}

// Bun's status --json: {version, configDir, services} grouped by service,
// readOnly as stored (an explicit false kept, an absent one omitted), and an
// empty object, not null, with no profiles.
func TestStatusJSONIsBuns(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	dir, _ := json.Marshal(filepath.Join(vault.ConfigDir()))
	code, out, errOut := run(t, "status", "--json")
	if want := "{\n  \"version\": \"" + Version + "\",\n  \"configDir\": " + string(dir) + ",\n  \"services\": {}\n}\n"; code != 0 || out != want {
		t.Fatalf("empty: code %d %q\n got %q\nwant %q", code, errOut, out, want)
	}
	statusVault(t)
	code, out, errOut = run(t, "status", "--json", "--no-test")
	want := "{\n  \"version\": \"" + Version + "\",\n  \"configDir\": " + string(dir) + ",\n  \"services\": {\n" +
		"    \"board\": [\n" +
		"      {\n        \"profile\": \"desk\",\n        \"readOnly\": true,\n        \"status\": \"skipped\"\n      },\n" +
		"      {\n        \"profile\": \"old\",\n        \"readOnly\": false,\n        \"status\": \"skipped\"\n      },\n" +
		"      {\n        \"profile\": \"none\",\n        \"status\": \"no-creds\"\n      }\n" +
		"    ],\n" +
		"    \"custom\": [\n      {\n        \"profile\": \"x\",\n        \"status\": \"skipped\"\n      }\n    ]\n" +
		"  }\n}\n"
	if code != 0 || out != want {
		t.Fatalf("code %d %q\n got %s\nwant %s", code, errOut, out, want)
	}
}

// Bun's status reports any failure as "Error: <message>" and exit 1, not the
// CliError format.
func TestStatusFailureIsAPlainErrorLine(t *testing.T) {
	initCLI(t)
	statusVault(t)
	t.Setenv("AGENTIO_PASSPHRASE", "wrong-pass-123")
	vault.Reset()
	header := "agentio v" + Version + "\nConfig: " + vault.ConfigDir() + "\n\n"
	for args, stdout := range map[string]string{"status": header, "status --json": ""} {
		code, out, errOut := run(t, strings.Fields(args)...)
		if code != 1 || out != stdout || errOut != "Error: Wrong passphrase for vault\n" {
			t.Fatalf("%v: code %d %q %q", args, code, out, errOut)
		}
	}
}
