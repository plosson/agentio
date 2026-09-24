package vault

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecryptRejectsGarbage(t *testing.T) {
	if _, err := Decrypt("not-base64!!!", "whatever-pass"); err == nil {
		t.Fatal("non-base64 payload decrypted")
	}
	short := EncryptMust(t, "x", "long-enough-passphrase")
	raw := []byte(short)
	if _, err := Decrypt(string(raw[:8]), "long-enough-passphrase"); err == nil {
		t.Fatal("truncated payload decrypted")
	}
	if _, err := Decrypt(short, "wrong-passphrase-value"); err == nil {
		t.Fatal("wrong passphrase decrypted")
	}
}

func TestBunWireRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil {
		t.Fatal("bun is required to prove the vault wire format")
	}
	const plain = `{"version":1,"note":"go-then-bun"}`
	const pass = "correct horse battery"
	enc, err := Encrypt(plain, pass)
	if err != nil {
		t.Fatal(err)
	}
	script := `
import { decryptVault, encryptVault } from "./src/vault/crypto.ts";
const plain = await decryptVault(process.env.ENC, process.env.PASS);
if (plain !== process.env.PLAIN) {
  console.error("bun could not read the go ciphertext:", JSON.stringify(plain));
  process.exit(2);
}
process.stdout.write(await encryptVault(process.env.PLAIN, process.env.PASS));
`
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", "..", ".."))
	cmd := exec.Command("bun", "-e", script)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "ENC="+enc, "PASS="+pass, "PLAIN="+plain)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("bun: %v\n%s", err, ee.Stderr)
		}
		t.Fatal(err)
	}
	got, err := Decrypt(string(out), pass)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("go could not read the bun ciphertext: %s", got)
	}
}

func TestPassphraseFileIsNotConsultedWhenMemoryOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AGENTIO_TEST", "1")
	t.Setenv("AGENTIO_PASSPHRASE", "")
	Reset()
	if err := StorePassphrase("stored-passphrase"); err != nil {
		t.Fatal(err)
	}
	SetMemoryOnly(true)
	ResetPassphrase()
	SetMemoryOnly(true)
	if pw, src := lookupPassphrase(); pw != "" || src != fromNone {
		t.Fatalf("memory-only provider returned %q from %s", pw, src)
	}
}

func TestTestGuardRefusesRealHome(t *testing.T) {
	t.Setenv("AGENTIO_TEST", "1")
	err := AssertTestWritable("/Users/plosson/.config/agentio/vault.path", "vault pointer")
	if err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("guard = %v", err)
	}
}

func EncryptMust(t *testing.T, plain, pass string) string {
	t.Helper()
	enc, err := Encrypt(plain, pass)
	if err != nil {
		t.Fatal(err)
	}
	return enc
}
