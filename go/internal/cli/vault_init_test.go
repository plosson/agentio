package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/plosson/agentio/go/internal/vault"
)

const initNudge = "\nNext: configure a service. Examples:\n  agentio gmail profile add\n  agentio slack profile add\nRun `agentio --help` to see all available services.\n"

// Bun's vault init: a passphrase that cannot be stored is a warning and the
// vault is still created.
func TestVaultInitWarnsWhenThePassphraseCannotBeStored(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	if err := os.MkdirAll(vault.PassphrasePath(), 0o700); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123")
	wantOut := "Vault created at " + vault.DefaultVaultPath() + "\n" + initNudge
	wantErr := "Warning: could not store passphrase: EISDIR: illegal operation on a directory, open '" + vault.PassphrasePath() + "'\n" +
		"Set AGENTIO_PASSPHRASE in your environment for future commands.\n"
	if code != 0 || out != wantOut || errOut != wantErr {
		t.Fatalf("code %d\nstdout %q\nwant   %q\nstderr %q\nwant   %q", code, out, wantOut, errOut, wantErr)
	}
	if _, err := os.Stat(vault.DefaultVaultPath()); err != nil {
		t.Fatalf("no vault written: %v", err)
	}
}

// A migration says where the legacy files went and, with profiles imported,
// does not suggest adding a first service. A directory --path is named.
func TestVaultInitMigrationMessages(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	dir := filepath.Join(os.Getenv("HOME"), "vdir")
	if err := os.MkdirAll(vault.ConfigDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(vault.ConfigDir(), "config.json")
	if err := os.WriteFile(legacy, []byte(`{"profiles":{"gmail":["work"]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--path", dir)
	target := filepath.Join(dir, "agentio.vault")
	wantOut := "Path is a directory; using " + target + "\n" +
		"Vault created at " + target + "\n" +
		"Legacy files preserved at " + legacy + ".bak\n" +
		"Delete them once you have confirmed the vault works.\n"
	wantErr := "Found legacy config — importing it into the new vault.\n" +
		"Warning: legacy credentials could not be recovered. Re-authenticate each service.\n"
	if code != 0 || out != wantOut || errOut != wantErr {
		t.Fatalf("code %d\nstdout %q\nwant   %q\nstderr %q\nwant   %q", code, out, wantOut, errOut, wantErr)
	}
}

// --no-migrate leaves the legacy config alone and creates an empty vault.
func TestVaultInitNoMigrateIgnoresLegacyConfig(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	if err := os.MkdirAll(vault.ConfigDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(vault.ConfigDir(), "config.json")
	if err := os.WriteFile(legacy, []byte(`{"profiles":{"gmail":["work"]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate")
	if want := "Vault created at " + vault.DefaultVaultPath() + "\n" + initNudge; code != 0 || out != want || errOut != "" {
		t.Fatalf("code %d %q %q", code, out, errOut)
	}
	if _, err := os.Stat(legacy); err != nil {
		t.Fatalf("legacy config moved: %v", err)
	}
}
