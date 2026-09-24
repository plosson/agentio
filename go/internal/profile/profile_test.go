package profile

import (
	"path/filepath"
	"testing"

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

func TestChooseNameAndCRUD(t *testing.T) {
	s := initTestVault(t)

	name := ChooseName(s, "gmail", "", "alice@example.com", false)
	if name != "alice@example.com" {
		t.Fatalf("got %q", name)
	}
	if err := Save(s, "gmail", name, map[string]any{"access_token": "a"}, false); err != nil {
		t.Fatal(err)
	}

	n2 := ChooseName(s, "gmail", "", "alice@example.com", false)
	if n2 != "alice@example.com-2" {
		t.Fatalf("collision got %q", n2)
	}
	if err := Save(s, "gmail", n2, map[string]any{"access_token": "b"}, false); err != nil {
		t.Fatal(err)
	}

	refs := ListAll(s, "gmail")
	if len(refs) != 2 {
		t.Fatalf("want 2 refs, got %d", len(refs))
	}

	if _, err := Resolve(s, "gmail", ""); err == nil {
		t.Fatal("expected multiple-profile error")
	}
	resolved, err := Resolve(s, "gmail", "alice@example.com")
	if err != nil || resolved != "alice@example.com" {
		t.Fatalf("resolve: %q %v", resolved, err)
	}

	ok, err := Remove(s, "gmail", "alice@example.com")
	if err != nil || !ok {
		t.Fatalf("remove: %v %v", ok, err)
	}
	if len(List(s, "gmail")) != 1 {
		t.Fatalf("after remove want 1")
	}

	saved, err := PersistSetup(s, "gmail", SetupResult{
		Credentials:          map[string]any{"access_token": "c"},
		SuggestedProfileName: "bob@example.com",
	}, "")
	if err != nil || saved != "bob@example.com" {
		t.Fatalf("persist: %q %v", saved, err)
	}
}

func TestValidateUnknownService(t *testing.T) {
	s := initTestVault(t)
	if err := Save(s, "nosuch", "x", map[string]any{}, false); err == nil {
		t.Fatal("expected unknown service error")
	}
}
