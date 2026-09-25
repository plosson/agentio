package host

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
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

// Bun: getClient, then enforceWriteAccess, then the handler. The order
// against the refresh is TestReadOnlyRefusalComesAfterTheRefresh.
func TestWriteGateRunsBeforeTheHandler(t *testing.T) {
	r := vaultUp(t)
	if err := profile.Save("acme", "ada", testbox.Object(map[string]any{
		"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(9_000_000_000_000),
	}), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
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
	if testbox.Map(creds.Credentials.Get("acme", "ada"))["accessToken"] != "old" {
		t.Fatal("refused write changed a fresh token")
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
	if err := profile.Save("acme", "ada", testbox.Object(freshCreds("ada")), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "bea", testbox.Object(freshCreds("bea")), profile.SaveOptions{}); err != nil {
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
	if testbox.Map(c.Credentials.Get("board", "desk"))["token"] != "tok" {
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
	if err := profile.Save("desk", "ro", testbox.Object(map[string]any{"token": "t"}), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
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
	port := testbox.FreePort(t)

	pr, pw := io.Pipe() // a paste that never arrives
	defer pw.Close()
	setup := NewSetupContext(Streams{In: pr, Out: io.Discard, Err: io.Discard})
	var redirect string
	done := make(chan struct{})
	go func() {
		defer close(done)
		testbox.GetWhenUp(fmt.Sprintf("http://127.0.0.1:%d/callback?code=abc&state=s1", port))
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

// When the browser callback wins, the paste prompt must let go of stdin: the
// answer to the next question (Jira "Select a site") is not the paste's.
func TestOAuthCallbackLeavesStdinToTheNextPrompt(t *testing.T) {
	feeds := map[string][]string{
		"one write":      {"2\nyes\n"},
		"delayed writes": {"2", "\n", "ye", "s\n"},
	}
	for name, parts := range feeds {
		t.Run(name, func(t *testing.T) {
			testbox.Isolate(t)
			t.Setenv("PATH", t.TempDir()) // no browser opener
			port := testbox.FreePort(t)

			pr, pw := io.Pipe()
			defer pw.Close()
			setup := NewSetupContext(Streams{In: pr, Out: io.Discard, Err: io.Discard})
			go testbox.GetWhenUp(fmt.Sprintf("http://127.0.0.1:%d/callback?code=abc&state=s1", port))
			res, err := setup.OAuth(context.Background(), plugins.OAuthSetupOptions{
				ServiceName: "Demo", ExpectedState: "s1", Port: port,
				AuthorizationURL: func(string) string { return "https://example.invalid/auth" },
			})
			if err != nil || res.Code != "abc" {
				t.Fatalf("oauth %#v %v", res, err)
			}
			go testbox.Feed(pw, parts...)
			answered := make(chan string, 1)
			go func() {
				site, err := setup.Prompt("? Select a site (1-2):", false)
				ok, err2 := setup.Confirm("Continue?")
				answered <- fmt.Sprintf("%s|%v|%v|%v", site, err, ok, err2)
			}()
			select {
			case got := <-answered:
				if got != "2|<nil>|true|<nil>" {
					t.Fatalf("answers %q", got)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("the next prompt never got its answer")
			}
		})
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
	if err := profile.Save("desk", "ro", testbox.Object(map[string]any{"token": "t"}), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
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
	if err := profile.Save("desk", "ro", testbox.Object(map[string]any{"token": "t"}), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
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
		got, err := NewPrompter(Streams{In: strings.NewReader(answer), Err: &errOut}).Confirm(`Delete file "/a"?`)
		if got != want || err != nil { // end of input is a "no", as Bun's readLine null
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

// Piped answers to several prompts all arrive, whether the pipe hands them over
// in one write or line by line: `printf 'host\nKEY\nuser\n' | ... profile add`.
func TestSetupPromptsShareOneStdinReader(t *testing.T) {
	feeds := map[string][]string{
		"one write":      {"host\nKEY\nuser\ny\nsecret\n"},
		"delayed writes": {"ho", "st\nKEY\n", "user\r\n", "y\nsec", "ret\n"},
	}
	for name, parts := range feeds {
		t.Run(name, func(t *testing.T) {
			pr, pw := io.Pipe()
			go func() {
				testbox.Feed(pw, parts...)
				_ = pw.Close()
			}()
			setup := NewSetupContext(Streams{In: pr, Out: io.Discard, Err: io.Discard})
			var got []string
			for _, q := range []string{"? Forum URL:", "? API Key:", "? Username:"} {
				answer, err := setup.Prompt(q, false)
				if err != nil {
					t.Fatalf("%s: %v (after %q)", q, err, got)
				}
				got = append(got, answer)
			}
			ok, err := setup.Confirm("Save?")
			if err != nil || !ok {
				t.Fatalf("confirm %v %v (after %q)", ok, err, got)
			}
			secret, err := setup.Prompt("? Token:", true) // not a terminal: read as a line
			if err != nil {
				t.Fatalf("secret: %v", err)
			}
			got = append(got, secret)
			if strings.Join(got, "|") != "host|KEY|user|secret" {
				t.Fatalf("answers %q", got)
			}
			if extra, err := setup.Prompt("? More:", false); err != io.EOF || extra != "" {
				t.Fatalf("past the end: %q %v", extra, err)
			}
		})
	}
}

// RunContext.Confirm reads os.Stdin afresh for each question; answers piped
// together must still reach each one.
func TestRunContextConfirmsShareStdin(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = old; _ = r.Close() }()
	_, _ = w.WriteString("y\nn\nyes\n")
	_ = w.Close()
	run := NewRunContext(nil, "p", nil)
	var got []bool
	for i := 0; i < 3; i++ {
		ok, err := run.Confirm("Delete?")
		if err != nil {
			t.Fatalf("confirm %d: %v", i, err)
		}
		got = append(got, ok)
	}
	if fmt.Sprint(got) != "[true false true]" {
		t.Fatalf("answers %v", got)
	}
}

// Bun sql query runs on a read-only profile and restricts itself: the handler
// sees the profile's flag, and a read (the omitted access) is not refused.
func TestRunContextCarriesTheReadOnlyFlag(t *testing.T) {
	r := vaultUp(t)
	for name, ro := range map[string]bool{"ro": true, "rw": false} {
		if err := profile.Save("acme", name, testbox.Object(map[string]any{
			"account": name, "accessToken": "tok", "refreshToken": "rt", "expiryDate": int64(9_000_000_000_000),
		}), profile.SaveOptions{ReadOnlySet: ro, ReadOnly: ro}); err != nil {
			t.Fatal(err)
		}
	}
	var seen []bool
	spec := &plugins.CommandSpec{Path: "peek", Run: func(_ context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
		seen = append(seen, run.ReadOnly)
		return nil, nil
	}}
	p := r.Find("acme")
	for _, name := range []string{"ro", "rw"} {
		if _, err := Execute(context.Background(), r, p, spec, plugins.CommandInput{Options: map[string]any{"profile": name}}); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 2 || !seen[0] || seen[1] {
		t.Fatalf("read-only flags seen: %v", seen)
	}
	if NewRunContext(nil, "p", nil).ReadOnly {
		t.Fatal("a bare run context is read-only")
	}
}

// JSON.stringify writes U+2028 and U+2029 as they are; encoding/json escapes
// them.
func TestPrintResultJSONKeepsLineSeparators(t *testing.T) {
	type row struct {
		Text string `json:"text"`
	}
	value := map[string]any{"s": "a b c", "row": row{Text: " "}}
	want := "{\n  \"row\": {\n    \"text\": \" \"\n  },\n  \"s\": \"a b c\"\n}\n"
	for _, asJSON := range []bool{true, false} {
		var out bytes.Buffer
		if err := PrintResult(&out, &plugins.CommandSpec{}, value, asJSON); err != nil {
			t.Fatal(err)
		}
		if out.String() != want {
			t.Fatalf("json=%v: got %q, want %q", asJSON, out.String(), want)
		}
	}
}
