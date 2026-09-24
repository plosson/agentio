package plugin

import (
	"context"
	"testing"
)

type stub struct{ id string }

func (s stub) ID() string          { return s.id }
func (s stub) DisplayName() string { return s.id }
func (s stub) Description() string { return "stub" }
func (s stub) Setup(ctx context.Context, opts SetupOptions) (*SetupResult, error) {
	return &SetupResult{SuggestedProfileName: "x", Credentials: map[string]any{}}, nil
}

func TestRegistryRegisterFind(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(stub{id: "gmail"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(stub{id: "gmail"}); err == nil {
		t.Fatal("expected duplicate error")
	}
	s, ok := r.Find("gmail")
	if !ok || s.ID() != "gmail" {
		t.Fatalf("find: %v %v", s, ok)
	}
	if !r.Has("gmail") || r.Has("slack") {
		t.Fatal("has")
	}
	if got := r.Names(); len(got) != 1 || got[0] != "gmail" {
		t.Fatalf("names: %v", got)
	}
	if len(r.ProfilePlugins()) != 1 {
		t.Fatal("profilePlugins")
	}
}
