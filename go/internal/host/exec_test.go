package host

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/board"
	"github.com/plosson/agentio/go/internal/plugins/ping"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

func reg(t *testing.T) *plugins.Registry {
	t.Helper()
	r, err := plugins.NewRegistry(acme.New(), board.New(), ping.New())
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func vaultUp(t *testing.T) *plugins.Registry {
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
	_, err := Execute(context.Background(), r, p, spec, plugins.CommandInput{
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
	res, err := Execute(context.Background(), r, p, who, plugins.CommandInput{Options: map[string]any{}})
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
	_, err := Execute(context.Background(), r, p, command(p, "whoami"), plugins.CommandInput{Options: map[string]any{}})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != clierr.InvalidParams || !strings.Contains(ce.Message, "ada") {
		t.Fatalf("multiple profiles = %#v", err)
	}
	spec := command(p, "batch apply")
	_, err = Execute(context.Background(), r, p, spec, plugins.CommandInput{
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
	res, err := Execute(context.Background(), r, p, spec, plugins.CommandInput{
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
	res, err := Execute(context.Background(), r, p, command(p, "once"), plugins.CommandInput{})
	if err != nil || res != "pong" {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestSetupPersistsThroughTheHost(t *testing.T) {
	r := vaultUp(t)
	p := r.Find("board")
	var prompts []string
	setup := &plugins.SetupContext{
		Prompt: func(q string, secret bool) (string, error) {
			prompts = append(prompts, q)
			if secret {
				return "tok", nil
			}
			return "desk", nil
		},
		Log: func(...any) {},
		Fail: func(code plugins.ErrorCode, message, suggestion string) error {
			return clierr.New(clierr.Code(code), message, suggestion)
		},
	}
	var out bytes.Buffer
	if err := AddProfile(context.Background(), p, plugins.SetupOptions{ReadOnly: true}, setup, &out); err != nil {
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

func command(p *plugins.Plugin, path string) *plugins.CommandSpec {
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

func TestReadOnlyRefusalNamesTheOperation(t *testing.T) {
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	ran := false
	cmd := func(path, operation string) plugins.CommandSpec {
		return plugins.CommandSpec{
			Path: path, Description: path, Access: "write", Operation: operation,
			Examples: []string{"agentio desk " + path},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) {
				ran = true
				return nil, nil
			},
		}
	}
	r, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Profile: &plugins.ProfileSpec{
			Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
				return nil, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
		},
		Commands: []plugins.CommandSpec{cmd("create", "create page"), cmd("delete", "")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("desk", "ro", map[string]any{"token": "t"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	p := r.Find("desk")
	for path, want := range map[string]string{
		"create": `Cannot create page: profile "ro" is read-only`,
		"delete": `Cannot delete: profile "ro" is read-only`,
	} {
		_, err := Execute(context.Background(), r, p, command(p, path), plugins.CommandInput{Options: map[string]any{}})
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != clierr.PermissionDenied || ce.Message != want {
			t.Fatalf("%s: %#v", path, err)
		}
	}
	if ran {
		t.Fatal("handler ran on a read-only profile")
	}
}

func TestOAuthUsesAPinnedCallbackPort(t *testing.T) {
	testbox.Isolate(t)
	t.Setenv("PATH", t.TempDir()) // no browser opener
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	pr, pw := io.Pipe() // a paste that never arrives
	defer pw.Close()
	setup := NewSetupContext(Streams{In: pr, Out: io.Discard, Err: io.Discard})
	var redirect string
	done := make(chan struct{})
	go func() {
		defer close(done)
		want := fmt.Sprintf("http://127.0.0.1:%d/callback?code=abc&state=s1", port)
		for i := 0; i < 200; i++ {
			resp, err := http.Get(want)
			if err == nil {
				resp.Body.Close()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	res, err := setup.OAuth(context.Background(), plugins.OAuthSetupOptions{
		ServiceName: "Demo", ExpectedState: "s1", Port: port,
		AuthorizationURL: func(r string) string { redirect = r; return "https://example.invalid/auth" },
	})
	<-done
	if err != nil {
		t.Fatal(err)
	}
	wantRedirect := fmt.Sprintf("http://localhost:%d/callback", port)
	if res.Code != "abc" || res.RedirectURI != wantRedirect || redirect != wantRedirect {
		t.Fatalf("res %#v redirect %q", res, redirect)
	}
}

// Bun prints JSON.stringify(value, null, 2), which leaves <, > and & as-is.
func TestPrintResultJSONDoesNotEscapeHTML(t *testing.T) {
	value := map[string]any{"body": "<p>a & b</p>", "n": 1}
	want := "{\n  \"body\": \"<p>a & b</p>\",\n  \"n\": 1\n}\n"
	for _, tc := range []struct {
		name   string
		spec   *plugins.CommandSpec
		asJSON bool
	}{
		{"--json", &plugins.CommandSpec{Format: func(any) string { return "formatted" }}, true},
		{"no Format fallback", &plugins.CommandSpec{}, false},
	} {
		var out bytes.Buffer
		if err := PrintResult(&out, tc.spec, value, tc.asJSON); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if out.String() != want {
			t.Fatalf("%s: got %q, want %q", tc.name, out.String(), want)
		}
	}
}

// Bun gscript get writes a file with process.stdout.write: no newline is
// added, and --json still prints the value.
func TestPrintResultVerbatimAddsNoNewline(t *testing.T) {
	spec := &plugins.CommandSpec{Verbatim: true, Format: func(v any) string { return v.(string) }}
	for value, want := range map[string]string{"a\nb": "a\nb", "ends\n": "ends\n", "": ""} {
		var out bytes.Buffer
		if err := PrintResult(&out, spec, value, false); err != nil {
			t.Fatal(err)
		}
		if out.String() != want {
			t.Fatalf("%q: got %q", value, out.String())
		}
	}
	var out bytes.Buffer
	if err := PrintResult(&out, spec, "x", true); err != nil || out.String() != "\"x\"\n" {
		t.Fatalf("--json: %q %v", out.String(), err)
	}
	out.Reset()
	if err := PrintResult(&out, &plugins.CommandSpec{Format: spec.Format}, "x", false); err != nil || out.String() != "x\n" {
		t.Fatalf("default: %q %v", out.String(), err)
	}
}

// Bun's dropbox link calls enforceWriteAccess only without --temporary.
func TestAccessForDecidesTheGateFromTheInput(t *testing.T) {
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	ran := 0
	r, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Profile: &plugins.ProfileSpec{
			Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
				return nil, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
		},
		Commands: []plugins.CommandSpec{{
			Path: "link", Description: "link", Access: "write", Operation: "create a shared link",
			AccessFor: func(in plugins.CommandInput) string {
				if TruthyOption(in.Options["temporary"]) {
					return "read"
				}
				return "write"
			},
			Examples: []string{"agentio desk link"},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) {
				ran++
				return "ok", nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("desk", "ro", map[string]any{"token": "t"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	p := r.Find("desk")
	_, err = Execute(context.Background(), r, p, command(p, "link"), plugins.CommandInput{Options: map[string]any{"temporary": false}})
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot create a shared link: profile "ro" is read-only` || ran != 0 {
		t.Fatalf("write form: %#v ran %d", err, ran)
	}
	res, err := Execute(context.Background(), r, p, command(p, "link"), plugins.CommandInput{Options: map[string]any{"temporary": true}})
	if err != nil || res != "ok" || ran != 1 {
		t.Fatalf("read form: %#v %v ran %d", res, err, ran)
	}
}

// Bun gmail draft refuses "Cannot update draft" with an id and "Cannot create
// draft" without one: the operation in the refusal comes from the input.
func TestOperationForNamesTheRefusalFromTheInput(t *testing.T) {
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	ran := 0
	r, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Profile: &plugins.ProfileSpec{
			Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
				return nil, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
		},
		Commands: []plugins.CommandSpec{{
			Path: "draft", Description: "draft", Access: "write", Operation: "draft",
			OperationFor: func(in plugins.CommandInput) string {
				if id, _ := in.Args["id"].(string); id != "" {
					return "update draft"
				}
				return "create draft"
			},
			Arguments: []plugins.ArgumentSpec{{Name: "id"}},
			Examples:  []string{"agentio desk draft"},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) {
				ran++
				return "ok", nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("desk", "ro", map[string]any{"token": "t"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	p := r.Find("desk")
	for id, want := range map[string]string{"": `Cannot create draft: profile "ro" is read-only`, "r-1": `Cannot update draft: profile "ro" is read-only`} {
		_, err = Execute(context.Background(), r, p, command(p, "draft"), plugins.CommandInput{Args: map[string]any{"id": id}, Options: map[string]any{}})
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != clierr.PermissionDenied || ce.Message != want || ran != 0 {
			t.Fatalf("id %q: %#v ran %d", id, err, ran)
		}
	}
}

// Bun utils/stdin confirm: "<question> (y/n): ", only y or yes (any case) agree.
func TestConfirmMatchesBunPromptAndAnswers(t *testing.T) {
	for answer, want := range map[string]bool{"y\n": true, " YES \n": true, "n\n": false, "yep\n": false, "\n": false, "": false} {
		var errOut bytes.Buffer
		got, _ := confirm(Streams{In: strings.NewReader(answer), Err: &errOut}, `Delete file "/a"?`)
		if got != want {
			t.Errorf("%q: got %v", answer, got)
		}
		if errOut.String() != `Delete file "/a"? (y/n): ` {
			t.Fatalf("prompt %q", errOut.String())
		}
	}
	if NewRunContext(nil, "p", nil).Confirm == nil {
		t.Fatal("RunContext has no Confirm")
	}
}
