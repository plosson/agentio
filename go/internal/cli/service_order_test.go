package cli

import (
	"testing"

	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Bun lists profiles in ALL_SERVICES order, then the other stored ids sorted,
// not in plugin catalog order.
func TestProfileListFollowsBunsServiceOrder(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	for _, svc := range []string{"zzz", "rss", "acme", "confluence", "gmail"} {
		if err := profile.Save(svc, "p", testbox.Object(map[string]any{"x": "y"}), profile.SaveOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	code, out, errOut := run(t, "profile", "list")
	want := "gmail:\n  p\nconfluence:\n  p\nacme:\n  p\nrss:\n  p\nzzz:\n  p\n"
	if code != 0 || out != want {
		t.Fatalf("code %d %q\n got %q\nwant %q", code, errOut, out, want)
	}
}
