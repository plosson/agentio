package host

import (
	"context"
	"errors"
	"testing"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// desk is a service whose token is always stale, so any profile resolution
// that gets as far as the client shows up in refreshes.
type desk struct {
	reg        *plugins.Registry
	p          *plugins.Plugin
	prepares   int
	refreshes  int
	refreshErr error
	runs       []any
}

type deskInput struct{ title string }

func newDesk(t *testing.T) *desk {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	d := &desk{}
	r, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Profile: &plugins.ProfileSpec{
			Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
				return nil, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
			Refresh: &plugins.RefreshSpec{
				SecretFields: []string{"token"},
				Applies:      func(map[string]any) bool { return true },
				IsStale:      func(c map[string]any, _, _ int64) bool { return c["token"] == "stale" },
				Run: func(_ context.Context, c map[string]any) (map[string]any, error) {
					d.refreshes++
					if d.refreshErr != nil {
						return nil, d.refreshErr
					}
					return map[string]any{"token": "renewed"}, nil
				},
			},
		},
		Commands: []plugins.CommandSpec{{
			Path: "make", Description: "make", Access: "write", Operation: "make a thing",
			Options:  []plugins.OptionSpec{{Flags: "--title <title>"}, {Flags: "--dry-run"}},
			Examples: []string{"agentio desk make --title x"},
			Prepare: func(_ context.Context, in plugins.CommandInput, pre *plugins.PrepareContext) (any, bool, error) {
				d.prepares++
				fail := pre.Fail
				title := in.Option("title")
				if title == "" {
					return nil, false, fail("INVALID_PARAMS", "--title is required", "")
				}
				if in.Flag("dry-run") {
					return "plan " + title, true, nil
				}
				return &deskInput{title: title}, false, nil
			},
			Run: func(_ context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
				d.runs = append(d.runs, run.Prepared)
				return plugins.Prepared[*deskInput](run).title, nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.reg, d.p = r, r.Find("desk")
	return d
}

func (d *desk) save(t *testing.T, name, token string, readOnly bool) {
	t.Helper()
	opts := profile.SaveOptions{}
	if readOnly {
		opts = profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}
	}
	if err := profile.Save("desk", name, map[string]any{"token": token}, opts); err != nil {
		t.Fatal(err)
	}
}

func (d *desk) exec(opts map[string]any) (any, error) {
	return Execute(context.Background(), d.reg, d.p, command(d.p, "make"), plugins.CommandInput{Options: opts})
}

func wantCode(t *testing.T, err error, code clierr.Code, what string) {
	t.Helper()
	var ce *clierr.Error
	if !errors.As(err, &ce) || ce.Code != code {
		t.Fatalf("%s: want %s, got %#v", what, code, err)
	}
}

// Bun validates input before get<X>Client: bad input is reported as such
// whatever the profile situation, and no token is refreshed for it.
func TestPrepareRejectsBadInputBeforeTheProfile(t *testing.T) {
	d := newDesk(t)
	bad := map[string]any{"title": ""}
	_, err := d.exec(bad)
	wantCode(t, err, clierr.InvalidParams, "no profile")

	_, err = d.exec(map[string]any{"title": "", "profile": "nope"})
	wantCode(t, err, clierr.InvalidParams, "unknown --profile")

	d.save(t, "a", "stale", false)
	d.save(t, "b", "stale", false)
	_, err = d.exec(bad)
	wantCode(t, err, clierr.InvalidParams, "ambiguous profiles")

	d.save(t, "ro", "stale", true)
	_, err = d.exec(map[string]any{"title": "", "profile": "ro"})
	wantCode(t, err, clierr.InvalidParams, "read-only profile")

	_, err = d.exec(map[string]any{"title": "", "profile": "a"})
	wantCode(t, err, clierr.InvalidParams, "writable profile, stale token")

	if d.refreshes != 0 || len(d.runs) != 0 {
		t.Fatalf("bad input refreshed %d times, ran %d times", d.refreshes, len(d.runs))
	}
	if d.prepares != 5 {
		t.Fatalf("Prepare called %d times for 5 runs", d.prepares)
	}
	creds, _ := vault.Load()
	if creds.Credentials["desk"]["a"]["token"] != "stale" {
		t.Fatal("bad input persisted a refresh")
	}
}

func TestPrepareDoneNeedsNoProfile(t *testing.T) {
	d := newDesk(t)
	res, err := d.exec(map[string]any{"title": "x", "dry-run": true})
	if err != nil || res != "plan x" {
		t.Fatalf("dry run, no profile: %#v %v", res, err)
	}
	d.save(t, "a", "stale", true)
	d.save(t, "b", "stale", true)
	d.refreshErr = errors.New("offline")
	for _, flag := range []string{"", "a", "nope"} {
		res, err = d.exec(map[string]any{"title": "x", "dry-run": true, "profile": flag})
		if err != nil || res != "plan x" {
			t.Fatalf("dry run --profile %q: %#v %v", flag, res, err)
		}
	}
	if d.refreshes != 0 || len(d.runs) != 0 {
		t.Fatalf("dry run refreshed %d, ran %d", d.refreshes, len(d.runs))
	}
}

func TestPreparedReachesRunOnce(t *testing.T) {
	d := newDesk(t)
	d.save(t, "a", "stale", false)
	res, err := d.exec(map[string]any{"title": "hello"})
	if err != nil || res != "hello" {
		t.Fatalf("%#v %v", res, err)
	}
	if d.prepares != 1 || len(d.runs) != 1 || d.refreshes != 1 {
		t.Fatalf("prepares %d runs %d refreshes %d", d.prepares, len(d.runs), d.refreshes)
	}
	if in, ok := d.runs[0].(*deskInput); !ok || in.title != "hello" {
		t.Fatalf("Run got %#v", d.runs[0])
	}
	// A second command gets its own value, not the first one's.
	if res, _ = d.exec(map[string]any{"title": "again", "profile": "a"}); res != "again" || d.prepares != 2 {
		t.Fatalf("second run %#v, prepares %d", res, d.prepares)
	}
}

// Valid input on a read-only profile: Bun builds the client (refresh and
// persist) and only then refuses the write.
func TestReadOnlyRefusalComesAfterTheRefresh(t *testing.T) {
	d := newDesk(t)
	d.save(t, "ro", "stale", true)

	d.refreshErr = errors.New("offline")
	_, err := d.exec(map[string]any{"title": "x"})
	wantCode(t, err, clierr.TokenExpired, "refresh fails")
	creds, _ := vault.Load()
	if creds.Credentials["desk"]["ro"]["token"] != "stale" {
		t.Fatal("failed refresh changed the stored token")
	}

	d.refreshErr = nil
	_, err = d.exec(map[string]any{"title": "x"})
	wantCode(t, err, clierr.PermissionDenied, "refresh succeeds")
	if msg := err.(*clierr.Error).Message; msg != `Cannot make a thing: profile "ro" is read-only` {
		t.Fatalf("refusal %q", msg)
	}
	creds, _ = vault.Load()
	if creds.Credentials["desk"]["ro"]["token"] != "renewed" {
		t.Fatalf("refresh before the refusal was not persisted: %#v", creds.Credentials["desk"]["ro"])
	}
	if d.refreshes != 2 || len(d.runs) != 0 {
		t.Fatalf("refreshes %d, runs %d", d.refreshes, len(d.runs))
	}
	if ro, _ := profile.IsReadOnly("desk", "ro"); !ro {
		t.Fatal("refresh cleared the read-only flag")
	}
}

func TestInvokeRunsPrepareThenRun(t *testing.T) {
	d := newDesk(t)
	spec := command(d.p, "make")
	run := NewRunContext(map[string]any{}, "", context.Background())
	if _, err := Invoke(context.Background(), spec, plugins.CommandInput{Options: map[string]any{}}, run); err == nil || len(d.runs) != 0 {
		t.Fatalf("bad input: %v runs %d", err, len(d.runs))
	}
	res, err := Invoke(context.Background(), spec, plugins.CommandInput{Options: map[string]any{"title": "t"}}, run)
	if err != nil || res != "t" || d.prepares != 2 || len(d.runs) != 1 {
		t.Fatalf("%#v %v prepares %d runs %d", res, err, d.prepares, len(d.runs))
	}
}
