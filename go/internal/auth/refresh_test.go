package auth_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

func newReg(t *testing.T, spec *plugins.RefreshSpec) *plugins.Registry {
	t.Helper()
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "acme", DisplayName: "Acme", Description: "demo",
		Profile: &plugins.ProfileSpec{
			Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
				return nil, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
			Refresh: spec,
		},
		Commands: []plugins.CommandSpec{{
			Path: "whoami", Description: "who", Examples: []string{"agentio acme whoami"},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) { return nil, nil },
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func initVault(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
}

func store(t *testing.T, creds map[string]any) {
	t.Helper()
	if err := profile.Save("acme", "ada", creds, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestRefreshPersistsBeforeReturnAndRotatesOnce(t *testing.T) {
	initVault(t)
	var calls atomic.Int32
	reg := newReg(t, &plugins.RefreshSpec{
		SecretFields: []string{"refreshToken"},
		Applies:      func(c map[string]any) bool { s, _ := c["refreshToken"].(string); return s != "" },
		IsStale: func(c map[string]any, now, buffer int64) bool {
			exp, _ := vault.AsInt64(c["expiryDate"])
			return now+buffer >= exp
		},
		Run: func(_ context.Context, c map[string]any) (map[string]any, error) {
			calls.Add(1)
			time.Sleep(40 * time.Millisecond)
			tok, _ := c["refreshToken"].(string)
			if tok == "bad" {
				return nil, errBoom
			}
			out := map[string]any{}
			for k, v := range c {
				out[k] = v
			}
			out["accessToken"] = "fresh"
			out["refreshToken"] = "rot:" + tok
			out["expiryDate"] = int64(time.Now().Add(time.Hour).UnixMilli())
			return out, nil
		},
	})
	store(t, map[string]any{"accessToken": "old", "refreshToken": "rt", "expiryDate": int64(1)})
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := auth.GetFresh(context.Background(), reg, "acme", "ada", auth.RefreshOptions{})
			errCh <- err
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("concurrent callers refreshed %d times", calls.Load())
	}
	got, err := auth.GetCredentials("acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	if got["refreshToken"] != "rot:rt" || got["accessToken"] != "fresh" {
		t.Fatalf("vault was not updated before return: %#v", got)
	}
	// A fresh token is left alone. A wider hub buffer still refreshes it when
	// it sits inside that window.
	freshUntil := time.Now().Add(7 * time.Minute).UnixMilli()
	store(t, map[string]any{"accessToken": "mid", "refreshToken": "rt2", "expiryDate": freshUntil})
	calls.Store(0)
	res, err := auth.GetFresh(context.Background(), reg, "acme", "ada", auth.RefreshOptions{Now: time.Now()})
	if err != nil || res.Refreshed {
		t.Fatalf("cli buffer refreshed a 7-minute token: %+v %v", res, err)
	}
	res, err = auth.GetFresh(context.Background(), reg, "acme", "ada", auth.RefreshOptions{Buffer: auth.HubRefreshBuffer, Now: time.Now()})
	if err != nil || !res.Refreshed {
		t.Fatalf("hub buffer left a 7-minute token: %+v %v", res, err)
	}
}

func TestFailedRefreshDoesNotPersist(t *testing.T) {
	initVault(t)
	reg := newReg(t, &plugins.RefreshSpec{
		SecretFields: []string{"refreshToken"},
		Applies:      func(map[string]any) bool { return true },
		IsStale:      func(map[string]any, int64, int64) bool { return true },
		Run:          func(context.Context, map[string]any) (map[string]any, error) { return nil, errBoom },
	})
	store(t, map[string]any{"accessToken": "old", "refreshToken": "rt"})
	_, err := auth.GetFresh(context.Background(), reg, "acme", "ada", auth.RefreshOptions{Force: true})
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.TokenExpired {
		t.Fatalf("err = %#v", err)
	}
	got, _ := auth.GetCredentials("acme", "ada")
	if got["accessToken"] != "old" {
		t.Fatalf("failed refresh wrote %#v", got)
	}
	_, err = auth.GetFresh(context.Background(), reg, "acme", "missing", auth.RefreshOptions{})
	ce, ok = err.(*clierr.Error)
	if !ok || ce.Code != clierr.AuthFailed {
		t.Fatalf("missing creds = %#v", err)
	}
}

func TestRedactCopiesAndStripsOnlyDeclaredFields(t *testing.T) {
	reg := newReg(t, &plugins.RefreshSpec{
		SecretFields: []string{"refreshToken"},
		Applies:      func(map[string]any) bool { return false },
		IsStale:      func(map[string]any, int64, int64) bool { return false },
		Run:          func(context.Context, map[string]any) (map[string]any, error) { return nil, nil },
	})
	original := map[string]any{"accessToken": "a", "refreshToken": "r", "account": "ada"}
	out := auth.RedactForRemote(reg, "acme", original)
	if _, ok := out["refreshToken"]; ok {
		t.Fatal("secret field survived redaction")
	}
	if original["refreshToken"] != "r" {
		t.Fatal("redact mutated the caller's map")
	}
	if out["accessToken"] != "a" {
		t.Fatal("non-secret dropped")
	}
	bare, _ := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: 1, ID: "ping", DisplayName: "Ping", Description: "x",
		Commands: []plugins.CommandSpec{{
			Path: "once", Description: "p", Examples: []string{"agentio ping once"},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) { return nil, nil },
		}},
	})
	static := map[string]any{"token": "whole"}
	if got := auth.RedactForRemote(bare, "ping", static); got["token"] != "whole" {
		t.Fatalf("static service was stripped: %#v", got)
	}
}

var errBoom = boom{}

type boom struct{}

func (boom) Error() string { return "provider rejected refresh" }
