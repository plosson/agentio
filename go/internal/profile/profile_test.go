package profile

import (
	"encoding/json"
	"testing"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

func initVault(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
}

func TestStringProfileEntriesStillResolve(t *testing.T) {
	initVault(t)
	err := vault.Update(func(c *vault.Contents) error {
		raw := []byte(`{"version":1,"config":{"profiles":{"acme":["legacy"]}},"credentials":{"acme":{"legacy":{"token":"t"}}}}`)
		next, err := decode(raw)
		if err != nil {
			return err
		}
		*c = *next
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	name, err := Require("acme", "")
	if err != nil || name != "legacy" {
		t.Fatalf("resolve = %q %v", name, err)
	}
}

func decode(raw []byte) (*vault.Contents, error) {
	var c vault.Contents
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if c.Config.Profiles == nil {
		c.Config.Profiles = map[string][]vault.ProfileValue{}
	}
	if c.Credentials == nil {
		c.Credentials = map[string]map[string]map[string]any{}
	}
	return &c, nil
}

func TestReplaceKeepsReadOnlyUnlessStated(t *testing.T) {
	initVault(t)
	creds := map[string]any{"token": "one"}
	if err := Save("board", "desk", creds, SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	if err := Save("board", "desk", map[string]any{"token": "two"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	ro, err := IsReadOnly("board", "desk")
	if err != nil || !ro {
		t.Fatalf("unstated replace cleared read-only: %v %v", ro, err)
	}
	got, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Credentials["board"]["desk"]["token"] != "two" {
		t.Fatalf("credentials not replaced: %#v", got.Credentials["board"]["desk"])
	}
	if err := Save("board", "desk", map[string]any{"token": "three"}, SaveOptions{ReadOnlySet: true, ReadOnly: false}); err != nil {
		t.Fatal(err)
	}
	ro, _ = IsReadOnly("board", "desk")
	if ro {
		t.Fatal("explicit false did not clear read-only")
	}
}

func TestNames(t *testing.T) {
	initVault(t)
	for _, bad := range []string{"", " ", "a/b", "/"} {
		if err := ValidateName(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if err := Save("acme", "ada", map[string]any{"n": "1"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	name, err := ChooseName("acme", "", "ada", false)
	if err != nil || name != "ada-2" {
		t.Fatalf("collision = %q %v", name, err)
	}
	name, err = ChooseName("acme", "", "ada", true)
	if err != nil || name != "ada-readonly" {
		t.Fatalf("read-only collision = %q %v", name, err)
	}
	// A free derived name is used as-is, even for a read-only profile.
	name, err = ChooseName("acme", "", "bea", true)
	if err != nil || name != "bea" {
		t.Fatalf("free read-only name = %q %v", name, err)
	}
	if _, err := ChooseName("acme", "explicit/nope", "ada", false); err != nil {
		t.Fatal(err)
	}
	err = Save("acme", "explicit/nope", map[string]any{"n": "1"}, SaveOptions{})
	if err == nil {
		t.Fatal("slash name was stored")
	}
}

func TestRenameMovesCredentialsAndScopes(t *testing.T) {
	initVault(t)
	if err := Save("acme", "ada", map[string]any{"token": "secret"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	issued, err := CreateKey(KeyInput{Name: "agent", AllowedProfiles: []string{"acme/ada"}, ReadOnly: false, CanManageProfiles: false}, "http://127.0.0.1:7890")
	if err != nil {
		t.Fatal(err)
	}
	star, err := CreateKey(KeyInput{Name: "owner", AllowedProfiles: "*", ReadOnly: false, CanManageProfiles: true}, "http://127.0.0.1:7890")
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := Rename("acme", "ada", "ada")
	if err != nil || outcome != WriteOK {
		t.Fatalf("same-name rename %s %v", outcome, err)
	}
	if err := Save("acme", "bea", map[string]any{"token": "other"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	outcome, err = Rename("acme", "ada", "bea")
	if err != nil || outcome != WriteTaken {
		t.Fatalf("taken = %s %v", outcome, err)
	}
	outcome, err = Rename("acme", "missing", "zz")
	if err != nil || outcome != WriteAbsent {
		t.Fatalf("absent = %s %v", outcome, err)
	}
	outcome, err = Rename("acme", "ada", "ada2")
	if err != nil || outcome != WriteOK {
		t.Fatalf("rename %s %v", outcome, err)
	}
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Credentials["acme"]["ada"]; ok {
		t.Fatal("old credential key survived")
	}
	if c.Credentials["acme"]["ada2"]["token"] != "secret" {
		t.Fatalf("credential did not follow the rename: %#v", c.Credentials["acme"])
	}
	keys, _ := ListKeys()
	var limited, starred KeyView
	for _, k := range keys {
		if k.ID == issued.Key.ID {
			limited = k
		}
		if k.ID == star.Key.ID {
			starred = k
		}
	}
	if !limited.AllowedProfiles.Allows("acme/ada2") || limited.AllowedProfiles.Allows("acme/ada") {
		t.Fatalf("scope did not follow rename: %#v", limited.AllowedProfiles)
	}
	if !starred.AllowedProfiles.All {
		t.Fatal("star key was rewritten")
	}
	ok, err := Delete("acme", "ada2")
	if err != nil || !ok {
		t.Fatal(err)
	}
	keys, _ = ListKeys()
	for _, k := range keys {
		if k.ID == issued.Key.ID && len(k.AllowedProfiles.Refs) != 0 {
			t.Fatalf("dangling scope survived delete: %#v", k.AllowedProfiles)
		}
		if k.ID == star.Key.ID && !k.AllowedProfiles.All {
			t.Fatal("star key lost on delete")
		}
	}
	_ = clierr.NotFound
}

func TestKeyedWriteRefusesUnreachableName(t *testing.T) {
	initVault(t)
	if err := Save("acme", "ada", map[string]any{"token": "t"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	issued, err := CreateKey(KeyInput{Name: "narrow", AllowedProfiles: []string{"acme/ada"}, CanManageProfiles: true}, "http://127.0.0.1:9")
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := SaveForKey(issued.Key.ID, "acme", "other", map[string]any{"token": "n"}, SaveOptions{})
	if err != nil || outcome != WriteOK {
		t.Fatalf("new name should be granted, got %s %v", outcome, err)
	}
	if err := Save("board", "hidden", map[string]any{"token": "h"}, SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	outcome, err = SaveForKey(issued.Key.ID, "board", "hidden", map[string]any{"token": "x"}, SaveOptions{})
	if err != nil || outcome != WriteDenied {
		t.Fatalf("replace of an unreachable profile = %s %v", outcome, err)
	}
	c, _ := vault.Load()
	if c.Credentials["board"]["hidden"]["token"] != "h" {
		t.Fatal("denied write changed credentials")
	}
}
