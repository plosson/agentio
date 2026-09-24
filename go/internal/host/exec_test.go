package host

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugin"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/board"
	"github.com/plosson/agentio/go/internal/plugins/ping"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

func reg(t *testing.T) *plugin.Registry {
	t.Helper()
	r, err := plugin.NewRegistry(acme.New(), board.New(), ping.New())
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func vaultUp(t *testing.T) *plugin.Registry {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	return reg(t)
}

func TestWriteGateRunsBeforeTheHandler(t *testing.T) {
	r := vaultUp(t)
	if err := profile.Save("acme", "ada", map[string]any{
		"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(9_000_000_000_000),
	}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	p := r.Find("acme")
	spec := command(p, "items add")
	_, err := Execute(context.Background(), r, p, spec, plugin.CommandInput{
		Args: map[string]any{"title": "nope"}, Options: map[string]any{},
	})
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.PermissionDenied {
		t.Fatalf("write on read-only = %#v", err)
	}
	got, _ := profile.IsReadOnly("acme", "ada")
	if !got {
		t.Fatal("gate mutated the profile")
	}
	creds, _ := vault.Load()
	if creds.Credentials["acme"]["ada"]["accessToken"] != "old" {
		t.Fatal("refused write still refreshed the token")
	}
	// Omitted access is read, so a read-only profile can still run it.
	who := command(p, "whoami")
	res, err := Execute(context.Background(), r, p, who, plugin.CommandInput{Options: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	if m["account"] != "ada" {
		t.Fatalf("%#v", res)
	}
}

func TestStdinAndProfileSelection(t *testing.T) {
	r := vaultUp(t)
	p := r.Find("acme")
	if err := profile.Save("acme", "ada", freshCreds("ada"), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "bea", freshCreds("bea"), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	_, err := Execute(context.Background(), r, p, command(p, "whoami"), plugin.CommandInput{Options: map[string]any{}})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != clierr.InvalidParams || !strings.Contains(ce.Message, "ada") {
		t.Fatalf("multiple profiles = %#v", err)
	}
	spec := command(p, "batch apply")
	_, err = Execute(context.Background(), r, p, spec, plugin.CommandInput{
		Options: map[string]any{"profile": "ada"}, Stdin: nil,
	})
	// stdin nil with input json: ParseStdin is the CLI's job. Execute itself
	// receives an already parsed stdin. An object is required by the handler.
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != clierr.InvalidParams {
		t.Fatalf("missing json = %#v", err)
	}
	bad, err := ParseStdin(spec, "{", true)
	if bad != nil || err == nil || !strings.Contains(err.Error(), "Invalid JSON") {
		t.Fatalf("parse = %#v %v", bad, err)
	}
	res, err := Execute(context.Background(), r, p, spec, plugin.CommandInput{
		Options: map[string]any{"profile": "bea"},
		Stdin:   map[string]any{"ops": []any{"a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["applied"] == nil {
		t.Fatalf("%#v", res)
	}
}

func TestCredentialLessCommandDoesNotTouchTheVault(t *testing.T) {
	r := vaultUp(t)
	p := r.Find("ping")
	res, err := Execute(context.Background(), r, p, command(p, "once"), plugin.CommandInput{})
	if err != nil || res != "pong" {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestSetupPersistsThroughTheHost(t *testing.T) {
	r := vaultUp(t)
	p := r.Find("board")
	var prompts []string
	setup := &plugin.SetupContext{
		Prompt: func(q string, secret bool) (string, error) {
			prompts = append(prompts, q)
			if secret {
				return "tok", nil
			}
			return "desk", nil
		},
		Log: func(...any) {},
		Fail: func(code plugin.ErrorCode, message, suggestion string) error {
			return clierr.New(clierr.Code(code), message, suggestion)
		},
	}
	var out bytes.Buffer
	if err := AddProfile(context.Background(), p, plugin.SetupOptions{ReadOnly: true}, setup, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "read-only") || !strings.Contains(strings.Join(prompts, " "), "API token") {
		t.Fatalf("prompts %v out %s", prompts, out.String())
	}
	ro, err := profile.IsReadOnly("board", "desk")
	if err != nil || !ro {
		t.Fatal(ro, err)
	}
	c, _ := vault.Load()
	if c.Credentials["board"]["desk"]["token"] != "tok" {
		t.Fatalf("%#v", c.Credentials)
	}
}

func command(p *plugin.Plugin, path string) *plugin.CommandSpec {
	for i := range p.Commands {
		if p.Commands[i].Path == path {
			return &p.Commands[i]
		}
	}
	panic(path)
}

func freshCreds(account string) map[string]any {
	return map[string]any{
		"account": account, "accessToken": "tok", "refreshToken": "rt",
		"expiryDate": int64(9_000_000_000_000),
	}
}
