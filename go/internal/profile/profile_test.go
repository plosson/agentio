package profile

import (
	"path/filepath"
	"testing"

	"github.com/plosson/agentio/go/internal/plugin"
	"github.com/plosson/agentio/go/internal/vault"
)

func initTestVault(t *testing.T) *vault.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "vault.enc")
	s, err := vault.Create(path, "test-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestChooseProfileNameAndCRUD(t *testing.T) {
	s := initTestVault(t)

	name := ChooseProfileName(s, "gmail", ProfileNameChoice{Derived: "alice@example.com"})
	if name != "alice@example.com" {
		t.Fatalf("got %q", name)
	}
	if err := SaveProfile(s, "gmail", name, map[string]any{"access_token": "a"}, SetProfileOptions{}); err != nil {
		t.Fatal(err)
	}

	n2 := ChooseProfileName(s, "gmail", ProfileNameChoice{Derived: "alice@example.com"})
	if n2 != "alice@example.com-2" {
		t.Fatalf("collision got %q", n2)
	}
	if err := SaveProfile(s, "gmail", n2, map[string]any{"access_token": "b"}, SetProfileOptions{}); err != nil {
		t.Fatal(err)
	}

	refs := ListProfileRefs(s, "gmail")
	if len(refs) != 2 {
		t.Fatalf("want 2 refs, got %d", len(refs))
	}

	if r := ResolveProfile(s, "gmail", ""); r.Error != "multiple" {
		t.Fatalf("expected multiple, got %#v", r)
	}
	resolved, err := RequireProfile(s, "gmail", "alice@example.com")
	if err != nil || resolved != "alice@example.com" {
		t.Fatalf("resolve: %q %v", resolved, err)
	}

	ok, err := DeleteProfile(s, "gmail", "alice@example.com")
	if err != nil || !ok {
		t.Fatalf("delete: %v %v", ok, err)
	}
	if len(ListProfiles(s, "gmail")[0].Profiles) != 1 {
		t.Fatalf("after delete want 1")
	}

	outcome, err := RenameProfile(s, "gmail", n2, "renamed")
	if err != nil || outcome != WriteOK {
		t.Fatalf("rename: %v %v", outcome, err)
	}

	saved, err := PersistSetupResult(s, "gmail", &plugin.SetupResult{
		Credentials:          map[string]any{"access_token": "c"},
		SuggestedProfileName: "bob@example.com",
	}, plugin.SetupOptions{})
	if err != nil || saved != "bob@example.com" {
		t.Fatalf("persist: %q %v", saved, err)
	}
}

func TestSaveProfileRejectsBadName(t *testing.T) {
	s := initTestVault(t)
	if err := SaveProfile(s, "gmail", "bad/name", map[string]any{}, SetProfileOptions{}); err == nil {
		t.Fatal("expected invalid name error")
	}
}
