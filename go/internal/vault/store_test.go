package vault_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

const testPass = "test-pass-123"

// A vault written by a newer Bun, or holding state Go does not model: unknown
// keys at every level, a service Go has no plugin for, and profile arrays that
// mix bare strings and objects.
const foreignVault = `{
  "version": 1,
  "topExtra": {"a": 1, "b": [true, null, "s"]},
  "config": {
    "profiles": {
      "acme": ["bare", {"name": "obj", "readOnly": true, "note": "keep"}, {"name": "plain"}, {"name": "ro-false", "readOnly": false}],
      "whatsapp": ["wa"]
    },
    "apiKeys": [{
      "id": "k1", "name": "key", "secretHash": "h", "allowedProfiles": "*",
      "readOnly": false, "createdAt": "2026-01-01T00:00:00.000Z",
      "future": {"x": [1, 2]}, "canAddProfiles": true
    }],
    "server": {"oauth": {"clients": {"c1": {"secret": "s", "expiresAt": 1735689600000}}}}
  },
  "credentials": {
    "whatsapp": {"wa": {"session": "x", "nested": {"n": 1.5}}},
    "acme": {"obj": {"accessToken": "t", "extra": [1, "two"]}}
  }
}`

// seedForeign creates a vault in the isolated HOME and overwrites it with raw.
func seedForeign(t *testing.T, raw string) string {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", testPass)
	path := vault.DefaultVaultPath()
	if err := vault.Create(path, testPass, vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	enc, err := vault.Encrypt(raw, testPass)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(enc), 0o600); err != nil {
		t.Fatal(err)
	}
	vault.Reset()
	return path
}

// onDisk decrypts the vault file into a generic JSON value.
func onDisk(t *testing.T, path string) map[string]any {
	t.Helper()
	enc, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := vault.Decrypt(string(enc), testPass)
	if err != nil {
		t.Fatal(err)
	}
	return parseJSON(t, plain)
}

func parseJSON(t *testing.T, raw string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("%v\n%s", err, raw)
	}
	return v
}

func assertSameJSON(t *testing.T, got, want map[string]any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		g, _ := json.MarshalIndent(got, "", "  ")
		w, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("vault changed\n got: %s\nwant: %s", g, w)
	}
}

func TestLoadSaveKeepsWhatGoDoesNotModel(t *testing.T) {
	path := seedForeign(t, foreignVault)
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := vault.Save(c); err != nil {
		t.Fatal(err)
	}
	assertSameJSON(t, onDisk(t, path), parseJSON(t, foreignVault))
}

func TestUpdateChangesOnlyWhatItTouches(t *testing.T) {
	path := seedForeign(t, foreignVault)
	if err := vault.Update(func(c *vault.Contents) error {
		c.Credentials["ping"] = map[string]map[string]any{"p": {"k": "v"}}
		c.Config.Profiles["ping"] = append(c.Config.Profiles["ping"], vault.ProfileValue{Name: "p"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	want := parseJSON(t, foreignVault)
	want["config"].(map[string]any)["profiles"].(map[string]any)["ping"] = []any{map[string]any{"name": "p"}}
	want["credentials"].(map[string]any)["ping"] = map[string]any{"p": map[string]any{"k": "v"}}
	assertSameJSON(t, onDisk(t, path), want)
}

// Bun writes the foreign vault, Go changes one profile, Bun changes another
// and reads it back: nothing either side does not model may be lost.
func TestBunGoBunRoundTripKeepsUnknownKeys(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil {
		t.Fatal("bun is required to prove the round trip")
	}
	path := seedForeign(t, `{"version":1,"config":{"profiles":{}},"credentials":{}}`)
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Clean(filepath.Join(wd, "..", "..", ".."))
	bun := func(script string) string {
		t.Helper()
		cmd := exec.Command("bun", "-e", script)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "NODE_ENV=test", "FOREIGN="+foreignVault)
		out, err := cmd.Output()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				t.Fatalf("bun: %v\n%s", err, ee.Stderr)
			}
			t.Fatal(err)
		}
		return string(out)
	}
	bun(`
import { updateVault } from "./src/vault/vault.ts";
await updateVault((v) => { Object.assign(v, JSON.parse(process.env.FOREIGN)); });
`)
	vault.Reset()
	if err := vault.Update(func(c *vault.Contents) error {
		c.Credentials["acme"]["go"] = map[string]any{"from": "go"}
		c.Config.Profiles["acme"] = append(c.Config.Profiles["acme"], vault.ProfileValue{Name: "go"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	out := bun(`
import { loadVault, updateVault } from "./src/vault/vault.ts";
await updateVault((v) => {
  v.config.profiles.acme.push({ name: "bun" });
  v.credentials.acme.bun = { from: "bun" };
});
process.stdout.write(JSON.stringify(await loadVault()));
`)
	want := parseJSON(t, foreignVault)
	profiles := want["config"].(map[string]any)["profiles"].(map[string]any)
	profiles["acme"] = append(profiles["acme"].([]any), map[string]any{"name": "go"}, map[string]any{"name": "bun"})
	creds := want["credentials"].(map[string]any)["acme"].(map[string]any)
	creds["go"] = map[string]any{"from": "go"}
	creds["bun"] = map[string]any{"from": "bun"}
	assertSameJSON(t, parseJSON(t, out), want)
	assertSameJSON(t, onDisk(t, path), want)
	if !strings.HasPrefix(path, os.TempDir()) {
		t.Fatalf("vault escaped the temp dir: %s", path)
	}
}
