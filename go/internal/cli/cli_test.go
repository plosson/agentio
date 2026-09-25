package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/pflag"
)

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, err bytes.Buffer
	code := Execute(plugins.Default, args, &out, &err, strings.NewReader(""))
	return code, out.String(), err.String()
}

func initCLI(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
}

func TestDocsDoNotNeedAVault(t *testing.T) {
	initCLI(t)
	code, out, errOut := run(t, "docs")
	if code != 0 || !strings.Contains(out, `"service": "acme"`) || !strings.Contains(out, `"service": "ping"`) {
		t.Fatalf("code %d\n%s\n%s", code, out, errOut)
	}
	code, out, errOut = run(t, "plugin", "list")
	if code != 0 || !strings.Contains(out, "refreshable") || !strings.Contains(out, "static") || !strings.Contains(out, "no-profile") {
		t.Fatalf("code %d\n%s\n%s", code, out, errOut)
	}
	code, _, errOut = run(t, "acme", "whoami")
	if code != 2 || !strings.Contains(errOut, "VAULT_NOT_CONFIGURED") {
		t.Fatalf("missing vault code %d %s", code, errOut)
	}
}

func TestCommandUsesFreshCredentialsAndRefusesReadOnlyWrites(t *testing.T) {
	initCLI(t)
	code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate")
	if code != 0 {
		t.Fatal(errOut)
	}
	code, _, errOut = run(t, "vault", "init", "--passphrase", "test-pass-123")
	if code == 0 || !strings.Contains(errOut, "already configured") {
		t.Fatalf("second init code %d %s", code, errOut)
	}
	if err := profile.Save("acme", "ada", map[string]any{
		"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(1),
	}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "acme", "whoami", "--json")
	if code != 0 || !strings.Contains(out, "fresh:old") {
		t.Fatalf("code %d\n%s\n%s", code, out, errOut)
	}
	stored, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Credentials["acme"]["ada"]["refreshToken"] != "rot:rt" {
		t.Fatalf("command did not persist refresh: %#v", stored.Credentials["acme"]["ada"])
	}
	if _, err := profile.SetReadOnly("acme", "ada", true); err != nil {
		t.Fatal(err)
	}
	code, out, errOut = run(t, "acme", "items", "add", "Widget")
	if code != 2 || !strings.Contains(errOut, "PERMISSION_DENIED") || strings.Contains(out, "Widget") {
		t.Fatalf("read-only write code %d\nout %s\nerr %s", code, out, errOut)
	}
	code, out, errOut = run(t, "ping", "once")
	if code != 0 || strings.TrimSpace(out) != "pong" {
		t.Fatalf("ping %d %q %s", code, out, errOut)
	}
	code, out, errOut = run(t, "skill", "board")
	if code != 0 || !strings.Contains(out, "agentio board cards create") {
		t.Fatalf("skill %d %s %s", code, out, errOut)
	}
}

func TestExportDropsReadOnlyAndImportDoesNotInventIt(t *testing.T) {
	initCLI(t)
	if code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate"); code != 0 {
		t.Fatal(errOut)
	}
	if err := profile.Save("board", "desk", map[string]any{"token": "sek", "workspace": "desk"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "vault", "export", "--all", "--key", strings.Repeat("ab", 32))
	if code != 0 {
		t.Fatal(errOut)
	}
	config := ""
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "AGENTIO_CONFIG=") {
			config = strings.TrimPrefix(line, "AGENTIO_CONFIG=")
		}
	}
	if config == "" {
		t.Fatalf("no config in %s", out)
	}
	plain, err := vault.Decrypt(config, strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, "readOnly") {
		t.Fatalf("export kept read-only, unlike the bun exporter: %s", plain)
	}
	if _, err := profile.Delete("board", "desk"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTIO_CONFIG", config)
	t.Setenv("AGENTIO_KEY", strings.Repeat("ab", 32))
	code, _, errOut = run(t, "vault", "import")
	if code != 0 {
		t.Fatal(errOut)
	}
	ro, err := profile.IsReadOnly("board", "desk")
	if err != nil || ro {
		t.Fatalf("imported profile read-only = %v %v", ro, err)
	}
	c, _ := vault.Load()
	if c.Credentials["board"]["desk"]["token"] != "sek" {
		t.Fatalf("%#v", c.Credentials)
	}
}

func TestProfileListAppendsTheServiceListInfo(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Profile: &plugins.ProfileSpec{
			Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
				return nil, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
			ListInfo: func(c map[string]any) string {
				if site, _ := c["site"].(string); site != "" {
					return " - " + site
				}
				return ""
			},
		},
		Commands: []plugins.CommandSpec{{
			Path: "ping", Description: "ping", Examples: []string{"agentio desk ping"},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) { return "pong", nil },
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("desk", "a", map[string]any{"site": "https://a.example"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("desk", "b", map[string]any{}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := Execute(reg, []string{"desk", "profile", "list"}, &out, &errOut, strings.NewReader(""))
	if code != 0 || out.String() != "a [read-only] - https://a.example\nb\n" {
		t.Fatalf("code %d\n%q\n%s", code, out.String(), errOut.String())
	}
}

// Bun dropbox `profile add --app-key <key>`: a service flag on profile add.
func TestProfileAddPassesServiceSetupOptions(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	var got plugins.SetupOptions
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Profile: &plugins.ProfileSpec{
			SetupOptions: []plugins.OptionSpec{
				{Flags: "--app-key <key>", Description: "App key"},
				{Flags: "--sandbox", Description: "Sandbox"},
			},
			Setup: func(_ context.Context, opts plugins.SetupOptions, _ *plugins.SetupContext) (*plugins.SetupResult, error) {
				got = opts
				return &plugins.SetupResult{Credentials: map[string]any{"k": "v"}, SuggestedProfileName: "auto"}, nil
			},
			Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
				return plugins.ValidationResult{Valid: true}, nil
			},
		},
		Commands: []plugins.CommandSpec{{
			Path: "ping", Description: "ping", Examples: []string{"agentio desk ping"},
			Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) { return "pong", nil },
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := Execute(reg, []string{"desk", "profile", "add", "--app-key", "k1", "--profile", "mine", "--read-only"}, &out, &errOut, strings.NewReader(""))
	if code != 0 {
		t.Fatalf("code %d %s", code, errOut.String())
	}
	if got.Profile != "mine" || !got.ReadOnly || got.Options["app-key"] != "k1" || got.Options["sandbox"] != false || len(got.Options) != 2 {
		t.Fatalf("%#v", got)
	}
	// The top-level `profile add <service>` keeps Bun's fixed flags only.
	code = Execute(reg, []string{"profile", "add", "desk", "--app-key", "k1"}, &out, &errOut, strings.NewReader(""))
	if code == 0 {
		t.Fatal("top-level profile add accepted a service flag")
	}
}

// Bun slack `profile add` declares requiredOption('--profile <name>'): an
// absent --profile fails before setup runs, a given "" is present (setup runs
// and the suggested name is used), and the top-level `profile add <service>`
// keeps --profile optional.
func TestProfileAddRequireProfile(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	setups := 0
	newReg := func(require bool) *plugins.Registry {
		reg, err := plugins.NewRegistry(&plugins.Plugin{
			APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
			Profile: &plugins.ProfileSpec{
				RequireProfile: require,
				Setup: func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
					setups++
					return &plugins.SetupResult{Credentials: map[string]any{"k": "v"}, SuggestedProfileName: "auto"}, nil
				},
				Validate: func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
					return plugins.ValidationResult{Valid: true}, nil
				},
			},
			Commands: []plugins.CommandSpec{{
				Path: "ping", Description: "ping", Examples: []string{"agentio desk ping"},
				Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) { return "pong", nil },
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return reg
	}
	reg := newReg(true)
	exec := func(args ...string) (int, string, string) {
		var out, errOut bytes.Buffer
		code := Execute(reg, args, &out, &errOut, strings.NewReader(""))
		return code, out.String(), errOut.String()
	}
	code, out, errOut := exec("desk", "profile", "add", "--read-only")
	if code == 0 || setups != 0 || out != "" || errOut != "Error [INVALID_PARAMS]: required option '--profile <name>' not specified\n" {
		t.Fatalf("absent --profile: code %d setups %d\n%q\n%q", code, setups, out, errOut)
	}
	if refs, _ := profile.List("desk", nil); len(refs) != 0 {
		t.Fatalf("absent --profile saved %v", refs)
	}
	code, out, errOut = exec("desk", "profile", "add", "--profile", "")
	if code != 0 || setups != 1 || out != "Profile \"auto\" configured!\n" {
		t.Fatalf("given \"\": code %d setups %d\n%q\n%q", code, setups, out, errOut)
	}
	code, out, errOut = exec("desk", "profile", "add", "--profile=mine")
	if code != 0 || setups != 2 || out != "Profile \"mine\" configured!\n" {
		t.Fatalf("given name: code %d\n%q\n%q", code, out, errOut)
	}
	code, _, errOut = exec("profile", "add", "desk")
	if code != 0 || setups != 3 {
		t.Fatalf("top-level profile add: code %d %s", code, errOut)
	}
	code, out, _ = exec("desk", "profile", "add", "--help")
	if code != 0 || !strings.Contains(out, "Profile name (required)") {
		t.Fatalf("help:\n%s", out)
	}
	// Without the hook --profile stays optional.
	reg = newReg(false)
	code, _, errOut = exec("desk", "profile", "add")
	if code != 0 || setups != 4 {
		t.Fatalf("optional --profile: code %d %s", code, errOut)
	}
}

// Bun falco sync prints its summary and then throws when a download failed.
// A value returned with an error reaches stdout before the error is rendered;
// an error alone prints nothing.
func TestResultReturnedWithAnErrorIsPrintedFirst(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Commands: []plugins.CommandSpec{
			{
				Path: "partial", Description: "partial", Examples: []string{"agentio desk partial"},
				Run: func(_ context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
					return map[string]any{"done": 1}, run.Fail("API_ERROR", "1 of 2 failed", "Re-run")
				},
				Format: func(v any) string { return "summary" },
			},
			{
				Path: "broken", Description: "broken", Examples: []string{"agentio desk broken"},
				Run: func(_ context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
					return nil, run.Fail("API_ERROR", "nothing", "")
				},
				Format: func(v any) string { return "never" },
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := Execute(reg, []string{"desk", "partial"}, &out, &errOut, strings.NewReader(""))
	if code != 5 || out.String() != "summary\n" || errOut.String() != "Error [API_ERROR]: 1 of 2 failed\nSuggestion: Re-run\n" {
		t.Fatalf("code %d\n%q\n%q", code, out.String(), errOut.String())
	}
	out.Reset()
	errOut.Reset()
	code = Execute(reg, []string{"desk", "partial", "--json"}, &out, &errOut, strings.NewReader(""))
	if code != 5 || out.String() != "{\n  \"done\": 1\n}\n" {
		t.Fatalf("code %d\n%q", code, out.String())
	}
	out.Reset()
	errOut.Reset()
	code = Execute(reg, []string{"desk", "broken"}, &out, &errOut, strings.NewReader(""))
	if code != 5 || out.String() != "" {
		t.Fatalf("code %d\n%q", code, out.String())
	}
}

// Bun tests/commands/gating.test.ts and e2e.test.ts: `gmail list` is gated on
// the vault, and with a vault but no profile it reaches the command.
func TestGmailListIsGatedOnTheVault(t *testing.T) {
	initCLI(t)
	code, _, errOut := run(t, "gmail", "list")
	if code != 2 || !strings.Contains(errOut, "VAULT_NOT_CONFIGURED") {
		t.Fatalf("code %d %s", code, errOut)
	}
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	code, _, errOut = run(t, "gmail", "list")
	if code == 0 || strings.Contains(errOut, "VAULT_LOCKED") || strings.Contains(errOut, "VAULT_NOT_CONFIGURED") {
		t.Fatalf("code %d %s", code, errOut)
	}
}

// Bun gmail archive prints its batch summary and then calls process.exit(5):
// the value is printed, no error line follows, and the status is 5.
func TestExitStatusPrintsTheValueAndNoErrorLine(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Commands: []plugins.CommandSpec{{
			Path: "batch", Description: "batch", Examples: []string{"agentio desk batch"},
			Run: func(_ context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
				return map[string]any{"ok": 1}, &plugins.ExitStatus{Code: 5}
			},
			Format: func(v any) string { return "archive: 1/2 succeeded" },
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := Execute(reg, []string{"desk", "batch"}, &out, &errOut, strings.NewReader(""))
	if code != 5 || out.String() != "archive: 1/2 succeeded\n" || errOut.String() != "" {
		t.Fatalf("code %d\n%q\n%q", code, out.String(), errOut.String())
	}
	out.Reset()
	code = Execute(reg, []string{"desk", "batch", "--json"}, &out, &errOut, strings.NewReader(""))
	if code != 5 || out.String() != "{\n  \"ok\": 1\n}\n" || errOut.String() != "" {
		t.Fatalf("json code %d\n%q\n%q", code, out.String(), errOut.String())
	}
}

// Bun gcal: `events` answers to `list`, and `--attendee` collects every
// occurrence into an array that is empty when the flag is absent.
func TestAliasRunsTheCommandAndRepeatableOptionsCollect(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	var got []plugins.CommandInput
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Commands: []plugins.CommandSpec{{
			Path: "events", Description: "events", Aliases: []string{"list"}, Examples: []string{"agentio desk events"},
			Options: []plugins.OptionSpec{
				{Flags: "--attendee <email>", Description: "Attendee (repeatable)", Repeatable: true},
				{Flags: "--limit <n>", Description: "Max", DefaultValue: "10"},
			},
			Run: func(_ context.Context, in plugins.CommandInput, _ *plugins.RunContext) (any, error) {
				got = append(got, in)
				return "ok", nil
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := Execute(reg, []string{"desk", "list", "--attendee", "a@example.com", "--attendee", "b@example.com,c@example.com", "--limit", "5", "--limit", "7"}, &out, &errOut, strings.NewReader("")); code != 0 {
		t.Fatalf("alias code %d %s", code, errOut.String())
	}
	if code := Execute(reg, []string{"desk", "events"}, &out, &errOut, strings.NewReader("")); code != 0 {
		t.Fatalf("code %d %s", code, errOut.String())
	}
	if len(got) != 2 {
		t.Fatalf("%d runs", len(got))
	}
	// A comma stays inside one value: pflag's StringSlice would split it.
	first, ok := got[0].Options["attendee"].([]string)
	if !ok || len(first) != 2 || first[0] != "a@example.com" || first[1] != "b@example.com,c@example.com" || got[0].Options["limit"] != "7" {
		t.Fatalf("%#v", got[0].Options)
	}
	empty, ok := got[1].Options["attendee"].([]string)
	if !ok || empty == nil || len(empty) != 0 {
		t.Fatalf("absent repeatable flag: %#v", got[1].Options["attendee"])
	}
	Execute(reg, []string{"desk", "ls"}, &out, &errOut, strings.NewReader(""))
	if len(got) != 2 {
		t.Fatal("an undeclared alias ran the command")
	}
}

// Bun gchat `send --json [file]`: a command may declare its own --json, which
// then carries Commander's optional value instead of the output switch.
func TestCommandOwnJSONOptionTakesAnOptionalValue(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	var got []plugins.CommandInput
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Commands: []plugins.CommandSpec{{
			Path: "send", Description: "send", Examples: []string{"agentio desk send"},
			Arguments: []plugins.ArgumentSpec{{Name: "message"}},
			Options: []plugins.OptionSpec{
				{Flags: "--json [file]", Description: "JSON file (or stdin)"},
				{Flags: "--space <id>", Description: "Space"},
			},
			Run: func(_ context.Context, in plugins.CommandInput, _ *plugins.RunContext) (any, error) {
				got = append(got, in)
				return map[string]any{"sent": true}, nil
			},
			Format: func(any) string { return "sent" },
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		args    []string
		json    any
		message any
		space   string
	}{
		{[]string{"desk", "send", "hi"}, nil, "hi", ""},
		{[]string{"desk", "send", "--json"}, true, nil, ""},
		{[]string{"desk", "send", "--json", "card.json", "--space", "S"}, "card.json", nil, "S"},
		{[]string{"desk", "send", "--json=card.json"}, "card.json", nil, ""},
		{[]string{"desk", "send", "--json", "--space", "S"}, true, nil, "S"},
		{[]string{"desk", "send", "hi", "--json"}, true, "hi", ""},
		{[]string{"desk", "send", "--json", "-"}, "-", nil, ""},
		{[]string{"desk", "send", "--", "--json"}, nil, "--json", ""},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		if code := Execute(reg, c.args, &out, &errOut, strings.NewReader("")); code != 0 {
			t.Fatalf("%v: code %d %s", c.args, code, errOut.String())
		}
		// No output switch: the result goes through Format.
		if out.String() != "sent\n" {
			t.Fatalf("%v: %q", c.args, out.String())
		}
		in := got[len(got)-1]
		if in.Options["json"] != c.json || in.Args["message"] != c.message || in.Option("space") != c.space {
			t.Fatalf("%v: %#v %#v", c.args, in.Options, in.Args)
		}
	}
}

// Bun `.command('list', { isDefault: true })`: the group alone, or with the
// default's options, runs the default; `--help` on the group stays the group's.
// An absent <value> option is not an explicit "" (Bun `options.due !== undefined`).
func TestDefaultSubcommandAndAbsentOptions(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	var ran []string
	var got []plugins.CommandInput
	handler := func(name string) func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) {
		return func(_ context.Context, in plugins.CommandInput, _ *plugins.RunContext) (any, error) {
			ran = append(ran, name)
			got = append(got, in)
			return name, nil
		}
	}
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Commands: []plugins.CommandSpec{
			{Path: "lists list", Description: "List lists", Default: true, Examples: []string{"agentio desk lists list"},
				Options: []plugins.OptionSpec{{Flags: "--limit <n>", Description: "Max", DefaultValue: "100"}},
				Run:     handler("list")},
			{Path: "lists create", Description: "Create a list", Examples: []string{"agentio desk lists create x"},
				Arguments: []plugins.ArgumentSpec{{Name: "title", Required: true}}, Run: handler("create")},
			{Path: "update", Description: "Update", Examples: []string{"agentio desk update"},
				Options: []plugins.OptionSpec{{Flags: "--due <date>", Description: "Due"}, {Flags: "--title <t>", Description: "Title"}},
				Run:     handler("update")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	exec := func(args ...string) (int, string) {
		var out, errOut bytes.Buffer
		code := Execute(reg, args, &out, &errOut, strings.NewReader(""))
		return code, out.String() + errOut.String()
	}
	if code, out := exec("desk", "lists"); code != 0 || out != "list\n" {
		t.Fatalf("group alone: %d %q", code, out)
	}
	if code, out := exec("desk", "lists", "--limit", "5"); code != 0 || out != "list\n" || got[len(got)-1].Option("limit") != "5" {
		t.Fatalf("group with the default's option: %d %q %#v", code, out, got[len(got)-1].Options)
	}
	if code, out := exec("desk", "lists", "create", "x"); code != 0 || out != "create\n" {
		t.Fatalf("sibling: %d %q", code, out)
	}
	before := len(ran)
	if code, out := exec("desk", "lists", "--help"); code != 0 || len(ran) != before || !strings.Contains(out, "create") {
		t.Fatalf("group help ran a command or lost the group: %d %q", code, out)
	}

	if code, out := exec("desk", "update", "--due", ""); code != 0 {
		t.Fatalf("update: %d %s", code, out)
	}
	in := got[len(got)-1]
	if due, ok := in.LookupOption("due"); !ok || due != "" {
		t.Fatalf("an explicit empty --due must be given: %#v", in.Options)
	}
	if _, ok := in.LookupOption("title"); ok || in.Option("title") != "" {
		t.Fatalf("an absent --title must not be given: %#v", in.Options)
	}
	if exec("desk", "lists"); got[len(got)-1].Option("limit") != "100" {
		t.Fatalf("a default value must still be given: %#v", got[len(got)-1].Options)
	}
}

// The Google product tests run commands on googletest's Input. It must be the
// map this CLI builds when no flag is given, or a test passes on input the host
// never produces ("" where Commander leaves an option undefined).
func TestGoogleTestInputIsWhatTheCLIBuildsWithoutFlags(t *testing.T) {
	checked := 0
	for _, p := range plugins.Default.Plugins() {
		plugin := p
		harness := googletest.For(func() *plugins.Plugin { return plugin })
		for _, spec := range plugin.Commands {
			flags := pflag.NewFlagSet(spec.Path, pflag.ContinueOnError)
			declareOptions(flags, spec.Options)
			if err := flags.Parse(nil); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{}
			flags.VisitAll(func(f *pflag.Flag) { want[f.Name] = flagValue(flags, f) })
			if got := harness.Input(t, spec.Path, nil, nil).Options; !reflect.DeepEqual(got, want) {
				t.Errorf("%s %s:\n got %#v\nwant %#v", plugin.ID, spec.Path, got, want)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no commands checked")
	}
}

// A new vault must be encrypted with the passphrase that gets stored, even when
// AGENTIO_PASSPHRASE holds another one, or the next load fails and wipes it.
func TestNewVaultUsesTheGivenPassphraseOverTheEnv(t *testing.T) {
	const key = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	blob, err := vault.Encrypt(`{"version":1,"config":{"profiles":{"board":["desk"]}},"credentials":{"board":{"desk":{"token":"sek"}}}}`, key)
	if err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string][]string{
		"init":   {"vault", "init", "--passphrase", "new-pass-456", "--no-migrate"},
		"import": {"vault", "import", "--key", key, "--passphrase", "new-pass-456"},
	} {
		t.Run(name, func(t *testing.T) {
			initCLI(t)
			t.Setenv("AGENTIO_PASSPHRASE", "old-pass-123")
			t.Setenv("AGENTIO_CONFIG", blob)
			if code, _, errOut := run(t, args...); code != 0 {
				t.Fatal(errOut)
			}
			enc, err := os.ReadFile(vault.DefaultVaultPath())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := vault.Decrypt(string(enc), "new-pass-456"); err != nil {
				t.Fatal("vault is not encrypted with the passphrase given on the command line")
			}
			t.Setenv("AGENTIO_PASSPHRASE", "")
			vault.Reset()
			if _, err := vault.Load(); err != nil {
				t.Fatalf("load with the stored passphrase: %v", err)
			}
			if stored, err := os.ReadFile(vault.PassphrasePath()); err != nil || string(stored) != "new-pass-456" {
				t.Fatalf("stored passphrase %q %v", stored, err)
			}
		})
	}
	t.Run("set", func(t *testing.T) {
		initCLI(t)
		t.Setenv("AGENTIO_CONFIG", blob)
		if code, _, errOut := run(t, "vault", "import", "--key", key, "--passphrase", "new-pass-456"); code != 0 {
			t.Fatal(errOut)
		}
		t.Setenv("AGENTIO_PASSPHRASE", "old-pass-123")
		vault.Reset()
		code, out, errOut := run(t, "vault", "set", vault.DefaultVaultPath(), "--passphrase", "new-pass-456")
		if code != 0 || !strings.Contains(out, "1 profile(s) available") {
			t.Fatalf("code %d\n%s\n%s", code, out, errOut)
		}
	})
}

// A failed write must not be reported as an import.
func TestImportReportsAFailedVaultWrite(t *testing.T) {
	const key = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	blob, err := vault.Encrypt(`{"version":1,"config":{"profiles":{"board":["desk"]}},"credentials":{"board":{"desk":{"token":"sek"}}}}`, key)
	if err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string][]string{
		"replace": {"vault", "import", "--key", key},
		"merge":   {"vault", "import", "--key", key, "--merge"},
	} {
		t.Run(name, func(t *testing.T) {
			initCLI(t)
			if code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate"); code != 0 {
				t.Fatal(errOut)
			}
			t.Setenv("AGENTIO_CONFIG", blob)
			dir := filepath.Dir(vault.DefaultVaultPath())
			if err := os.Chmod(dir, 0o500); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
			code, out, errOut := run(t, args...)
			if code == 0 || strings.Contains(out, "successfully") || !strings.Contains(errOut, "permission denied") {
				t.Fatalf("code %d\n%s\n%s", code, out, errOut)
			}
		})
	}
}
