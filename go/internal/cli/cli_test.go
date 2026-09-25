package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/board"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/plugins/ping"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/pflag"
)

// testCatalog is the production catalog after the host fixtures (acme, board,
// ping), which only tests register.
var testCatalog = func() *plugins.Registry {
	reg, err := plugins.NewRegistry(acme.New(), board.New(), ping.New())
	if err != nil {
		panic(err)
	}
	registerServices(reg)
	return reg
}()

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, err bytes.Buffer
	code := Execute(testCatalog, args, &out, &err, strings.NewReader(""))
	return code, out.String(), err.String()
}

func initCLI(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
}

// The production catalog is Bun's SERVICE_PLUGINS, in order, without telegram:
// the host fixtures (acme, board, ping) exist only in tests, so no help,
// known-services list, docs or vault hint shows them.
func TestProductionCatalogIsBunsServicesWithoutTheFixtures(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	want := []string{"confluence", "discourse", "dropbox", "falco", "gcal", "gchat", "gdocs", "gdrive", "github",
		"gmail", "gsheets", "gslides", "gscript", "gtasks", "jira", "revolut", "rss", "slack", "sql"}
	if got := ids(plugins.Default); !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog\n got %v\nwant %v", got, want)
	}
	exec := func(args ...string) (int, string) {
		var out, errOut bytes.Buffer
		code := Execute(plugins.Default, args, &out, &errOut, strings.NewReader(""))
		return code, out.String() + errOut.String()
	}
	fixture := func(text string) bool {
		for _, id := range []string{"acme", "board", "ping"} {
			if strings.Contains(text, "agentio "+id) || strings.Contains(text, `"`+id+`"`) ||
				strings.Contains(text, " "+id+" ") || strings.Contains(text, id+", ") || strings.Contains(text, "\n"+id+"\t") {
				return true
			}
		}
		return false
	}
	for _, args := range [][]string{{"--help"}, {"docs"}, {"plugin", "list"}, {"profile", "add", "nosuch"},
		{"vault", "init", "--passphrase", "test-pass-123", "--no-migrate"}} {
		if _, text := exec(args...); fixture(text) {
			t.Errorf("%v shows a test fixture:\n%s", args, text)
		}
	}
	for _, id := range []string{"acme", "board", "ping"} {
		if code, text := exec(id); code == 0 {
			t.Errorf("%s ran in the production binary:\n%s", id, text)
		}
	}
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
// absent --profile fails with Commander's message before setup runs, a given "" is present (setup runs
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
	if code != 1 || setups != 0 || out != "" || errOut != "error: required option '--profile <name>' not specified\n" {
		t.Fatalf("absent --profile: code %d setups %d\n%q\n%q", code, setups, out, errOut)
	}
	if refs, _ := profile.List("desk"); len(refs) != 0 {
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
			want := commandOptions(flags, false)
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

// exportKey encrypts exportedBlob, a one-profile export as `vault export` makes.
const exportKey = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

func exportedBlob(t *testing.T) string {
	t.Helper()
	blob, err := vault.Encrypt(`{"version":1,"config":{"profiles":{"board":["desk"]}},"credentials":{"board":{"desk":{"token":"sek"}}}}`, exportKey)
	if err != nil {
		t.Fatal(err)
	}
	return blob
}

// A new vault must be encrypted with the passphrase that gets stored, even when
// AGENTIO_PASSPHRASE holds another one, or the next load fails and wipes it.
func TestNewVaultUsesTheGivenPassphraseOverTheEnv(t *testing.T) {
	blob := exportedBlob(t)
	for name, args := range map[string][]string{
		"init":   {"vault", "init", "--passphrase", "new-pass-456", "--no-migrate"},
		"import": {"vault", "import", "--key", exportKey, "--passphrase", "new-pass-456"},
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
		if code, _, errOut := run(t, "vault", "import", "--key", exportKey, "--passphrase", "new-pass-456"); code != 0 {
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
	blob := exportedBlob(t)
	for name, args := range map[string][]string{
		"replace": {"vault", "import", "--key", exportKey},
		"merge":   {"vault", "import", "--key", exportKey, "--merge"},
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

// A command line Commander rejects fails with Commander's message and exit 1,
// in Commander's order (a missing value, then a missing required option, then
// an unknown option, then the argument count), before the vault gate.
// Expectations are Bun's output (`bun run src/index.ts …`, no vault).
func TestParseErrorsAreCommanders(t *testing.T) {
	initCLI(t)
	cases := []struct{ line, stderr string }{
		{"gmail lst", "error: unknown command 'lst'\n(Did you mean list?)"},
		{"gmail nosuch", "error: unknown command 'nosuch'"},
		{"nonexistent", "error: too many arguments. Expected 0 arguments but got 1."},
		{"help", "error: too many arguments. Expected 0 arguments but got 1."},
		{"help gmail", "error: too many arguments. Expected 0 arguments but got 2."},
		{"gmail get", "error: missing required argument 'message-id'"},
		{"gmail get a b", "error: too many arguments for 'get'. Expected 1 argument but got 2."},
		{"gmail search --bogus", "error: required option '--query <query>' not specified"},
		{"gmail search --query x --bogus", "error: unknown option '--bogus'"},
		{"gmail list --limit", "error: option '--limit <n>' argument missing"},
		{"gmail list --limt", "error: unknown option '--limt'\n(Did you mean --limit?)"},
		{"vault init --bogus", "error: unknown option '--bogus'"},
		{"status extra", "error: too many arguments for 'status'. Expected 0 arguments but got 1."},
		{"gmail --bogus", "error: unknown option '--bogus'"},
		{"gmail lst --bogus", "error: unknown command 'lst'\n(Did you mean list?)"},
		{"gmail -x", "error: unknown option '-x'"},
		{"vault lst", "error: unknown command 'lst'"},
		{"vault ini", "error: unknown command 'ini'\n(Did you mean init?)"},
		{"gmail hlp", "error: unknown command 'hlp'\n(Did you mean help?)"},
		{"gmail labels lst", "error: unknown command 'lst'\n(Did you mean list?)"},
		{"profile add", "error: missing required argument 'service'"},
		{"profile add gmail extra", "error: too many arguments for 'add'. Expected 1 argument but got 2."},
		{"gtasks lists --bogus", "error: unknown option '--bogus'"},
		{"gtasks lists nosuch", "error: too many arguments for 'list'. Expected 0 arguments but got 1."},
		{"status --json=1", "error: unknown option '--json=1'\n(Did you mean --json?)"},
		{"reauth x", "error: too many arguments for 'reauth'. Expected 0 arguments but got 1."},
		{"gmail get -- -5 x", "error: too many arguments for 'get'. Expected 1 argument but got 2."},
		{"slack profile add", "error: required option '--profile <name>' not specified"},
		{"gmail profile update", "error: required option '--profile <name>' not specified"},
		{"gmail profile rename --to y", "error: required option '--profile <name>' not specified"},
		{"--version=x", "error: unknown option '--version=x'\n(Did you mean --version?)"},
		{"-v", "error: unknown option '-v'"},
		{"sql query --bogus x y", "error: unknown option '--bogus'"},
		{"gchat list --space", "error: option '--space <id>' argument missing"},
		{"gcal create --summary s", "error: required option '--from <datetime>' not specified"},
		{"revolut pay --from a --to b --amount 1", "error: required option '--currency <code>' not specified"},
		{"gmail list --query", "error: option '--query <query>' argument missing"},
		{"profile rename gmail a", "error: missing required argument 'new-name'"},
		{"vault set", "error: missing required argument 'path'"},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		code := Execute(plugins.Default, strings.Fields(c.line), &out, &errOut, strings.NewReader(""))
		if code != 1 || out.String() != "" || errOut.String() != c.stderr+"\n" {
			t.Errorf("%s: code %d\nstdout %q\nstderr %q\nwant   %q", c.line, code, out.String(), errOut.String(), c.stderr+"\n")
		}
	}
	// A negative number is an operand of a leaf, not an option: the line
	// parses and reaches the vault gate.
	var out, errOut bytes.Buffer
	if code := Execute(plugins.Default, []string{"gmail", "get", "-5"}, &out, &errOut, strings.NewReader("")); code != 2 || !strings.Contains(errOut.String(), "VAULT_NOT_CONFIGURED") {
		t.Errorf("gmail get -5: code %d %q", code, errOut.String())
	}
}

// Commander prints help to stdout (exit 0) when asked, and to stderr (exit 1)
// for a group given no subcommand or `help <unknown>`.
func TestHelpStreamsAndExitCodesAreCommanders(t *testing.T) {
	initCLI(t)
	cases := []struct {
		line     string
		code     int
		contains string
	}{
		{"gmail", 1, "search"},
		{"gmail labels", 1, "create"},
		{"vault", 1, "init"},
		{"profile", 1, "rename"},
		{"gmail help", 0, "search"},
		{"gmail help nosuch", 1, "search"},
		{"gmail help list", 0, "--limit"},
		{"gmail search --bogus --help", 0, "--query"},
		{"gmail search --query x --bogus --help", 0, "--query"},
		{"gmail lst --help", 0, "search"},
		{"gmail -h", 0, "search"},
		{"gtasks lists --help", 0, "create"},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		code := Execute(plugins.Default, strings.Fields(c.line), &out, &errOut, strings.NewReader(""))
		shown, silent := out.String(), errOut.String()
		if c.code == 1 {
			shown, silent = silent, shown
		}
		if code != c.code || silent != "" || !strings.Contains(shown, c.contains) || strings.Contains(shown, "error") {
			t.Errorf("%s: code %d (want %d)\nstdout %q\nstderr %q", c.line, code, c.code, out.String(), errOut.String())
		}
	}
}

// Commander's -V, --version prints the bare version and exits 0, wherever the
// root sees it (it parses its own options first); -v is not a version flag.
func TestVersionFlagIsCommanders(t *testing.T) {
	initCLI(t)
	for _, line := range []string{"-V", "--version", "-Vx", "gmail list --version", "gmail list --limit --version", "gmail search --query -V"} {
		var out, errOut bytes.Buffer
		code := Execute(plugins.Default, strings.Fields(line), &out, &errOut, strings.NewReader(""))
		if code != 0 || out.String() != Version+"\n" || errOut.String() != "" {
			t.Errorf("%s: code %d %q %q", line, code, out.String(), errOut.String())
		}
	}
}

// The release version comes from package.json at build time, as Bun's
// BUILD_VERSION does: `bun run build:go` sets cli.Version with -ldflags -X, and
// the built binary prints exactly that.
func TestBuildInjectsThePackageVersion(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary")
	}
	raw, err := os.ReadFile("../../../package.json")
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	const symbol = "-X github.com/plosson/agentio/go/internal/cli.Version="
	if script := pkg.Scripts["build:go"]; !strings.Contains(script, symbol+"$(bun -e 'console.log(require(\"./package.json\").version)')") {
		t.Fatalf("build:go does not inject the package.json version: %q", script)
	}
	bin := filepath.Join(t.TempDir(), "agentio")
	build := exec.Command("go", "build", "-ldflags", symbol+"9.8.7-test", "-o", bin, "../../cmd/agentio")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	testbox.Isolate(t) // after the build, which needs the real module cache
	for _, flag := range []string{"--version", "-V"} {
		out, err := exec.Command(bin, flag).Output()
		if err != nil || string(out) != "9.8.7-test\n" {
			t.Fatalf("%s: %q %v", flag, out, err)
		}
	}
}

// openStdin is a stdin pipe that stays open and silent, as an agent's
// subprocess stdin often is, and remembers whether anything read it.
type openStdin struct {
	pr      *io.PipeReader
	touched atomic.Bool
}

func (s *openStdin) Read(p []byte) (int, error) {
	s.touched.Store(true)
	return s.pr.Read(p)
}

// Bun's commands read stdin only when the value it stands in for is missing
// (`query || await readStdin()`): a command given the value neither blocks on
// an open stdin pipe nor consumes it, and a command without it reads it.
func TestStdinIsReadOnlyWhenTheValueIsMissing(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	execWith := func(stdin io.Reader, args ...string) (int, string, bool) {
		done := make(chan struct{})
		var code int
		var errOut bytes.Buffer
		go func() {
			defer close(done)
			var out bytes.Buffer
			code = Execute(plugins.Default, args, &out, &errOut, stdin)
		}()
		select {
		case <-done:
			return code, errOut.String(), true
		case <-time.After(5 * time.Second):
			return 0, "", false
		}
	}
	given := [][]string{
		{"sql", "query", "select 1"},
		{"jira", "comment", "K-1", "hello"},
		{"confluence", "comment", "123", "hello"},
		{"confluence", "create", "--title", "t", "--space", "S", "--content", "c"},
		{"slack", "send", "hi"},
		{"gchat", "send", "hi"},
		{"gmail", "archive", "id-1"},
		{"gmail", "send", "--to", "a@example.com", "--subject", "s", "--body", "b"},
		{"gdocs", "create", "--title", "t", "--content", "c"},
		{"gtasks", "add", "L", "--title", "t", "--notes", "n"},
	}
	var pipes []*io.PipeWriter
	defer func() {
		for _, w := range pipes {
			w.Close()
		}
	}()
	for _, args := range given {
		pr, pw := io.Pipe()
		pipes = append(pipes, pw)
		stdin := &openStdin{pr: pr}
		code, errOut, finished := execWith(stdin, args...)
		if !finished {
			t.Errorf("%v blocked on an open stdin although the value was given", args)
			continue
		}
		if stdin.touched.Load() || code == 0 || !strings.Contains(errOut, "PROFILE_NOT_FOUND") {
			t.Errorf("%v: read stdin %v, code %d\n%s", args, stdin.touched.Load(), code, errOut)
		}
	}
	// Without the value, the piped text stands in for it; nothing piped is
	// Bun's "is required" error.
	if code, errOut, _ := execWith(strings.NewReader("select 1\n"), "sql", "query"); code == 0 || !strings.Contains(errOut, "PROFILE_NOT_FOUND") {
		t.Errorf("piped query: code %d\n%s", code, errOut)
	}
	if code, errOut, _ := execWith(strings.NewReader(" \n"), "sql", "query"); code == 0 || !strings.Contains(errOut, "Query is required") {
		t.Errorf("blank piped query: code %d\n%s", code, errOut)
	}
}

// Bun resolvePassphrase (src/vault/passphrase-input.ts): --passphrase-stdin
// takes readStdin() (fully trimmed) and refuses nothing piped;
// AGENTIO_PASSPHRASE is used verbatim; off a terminal with none of them it
// refuses with Bun's message.
func TestPassphraseResolutionIsBuns(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	execIn := func(stdin string, args ...string) (int, string) {
		var out, errOut bytes.Buffer
		code := Execute(plugins.Default, args, &out, &errOut, strings.NewReader(stdin))
		return code, errOut.String()
	}
	const noStdin = "Error [INVALID_PARAMS]: No passphrase received on stdin\n" +
		"Suggestion: Pipe it in, e.g. printf %s \"$PW\" | agentio vault set <path> --passphrase-stdin\n"
	for _, piped := range []string{"", " \t\r\n"} {
		if code, errOut := execIn(piped, "vault", "init", "--passphrase-stdin"); code != 1 || errOut != noStdin {
			t.Errorf("piped %q: code %d\n%q", piped, code, errOut)
		}
	}
	const noTerminal = "Error [INVALID_PARAMS]: A passphrase is required and no terminal is available to prompt\n" +
		"Suggestion: Use --passphrase-stdin, --passphrase <value>, or set AGENTIO_PASSPHRASE\n"
	if code, errOut := execIn("", "vault", "init"); code != 1 || errOut != noTerminal {
		t.Errorf("no passphrase: code %d\n%q", code, errOut)
	}
	if vault.Exists() {
		t.Fatal("a refused init created a vault")
	}
	// opens reports whether the vault file decrypts with exactly pass, as the
	// Bun CLI would decrypt it.
	opens := func(pass string) bool {
		path, err := vault.ReadPointer()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		_, err = vault.Decrypt(string(raw), pass)
		return err == nil
	}
	// Piped: String#trim, so edge spaces and tabs go too.
	if code, errOut := execIn("\t pass-12345 \n", "vault", "init", "--passphrase-stdin"); code != 0 || !opens("pass-12345") {
		t.Fatalf("piped init: code %d %s", code, errOut)
	}
	// The env var verbatim, for a new vault and to open one Bun encrypted.
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", " spaced pass ")
	if code, errOut := execIn("", "vault", "init"); code != 0 || !opens(" spaced pass ") {
		t.Fatalf("env init: code %d %s", code, errOut)
	}
	testbox.Isolate(t)
	plain, _ := json.Marshal(vault.EmptyContents())
	encoded, err := vault.Encrypt(string(plain), " spaced pass ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "bun.vault")
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := vault.WritePointer(path); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTIO_PASSPHRASE", " spaced pass ")
	if code, errOut := execIn("", "profile", "list"); code != 0 {
		t.Fatalf("env passphrase with edge spaces: code %d %s", code, errOut)
	}
}

// Bare `agentio` runs the root action, so Bun's preAction vault gate applies:
// without a vault it fails, with one it prints the help (stdout, exit 0).
func TestBareRootIsGatedOnTheVault(t *testing.T) {
	initCLI(t)
	var out, errOut bytes.Buffer
	code := Execute(plugins.Default, nil, &out, &errOut, strings.NewReader(""))
	if code != 2 || out.String() != "" || errOut.String() != "Error [VAULT_NOT_CONFIGURED]: No vault configured\nSuggestion: Run: agentio vault init\n" {
		t.Fatalf("no vault: code %d %q %q", code, out.String(), errOut.String())
	}
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	code = Execute(plugins.Default, nil, &out, &errOut, strings.NewReader(""))
	if code != 0 || !strings.Contains(out.String(), "gmail") || errOut.String() != "" {
		t.Fatalf("with a vault: code %d %q %q", code, out.String(), errOut.String())
	}
}
