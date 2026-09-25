package cli

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Commander's `--no-x`: it sets x to false, the last of `--x`/`--no-x` wins,
// `--no-x` alone makes x default to true and accepts no `--x`, and the command
// never sees a "no-x" option.
func TestNegatableOptionsAreCommanders(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	var got []plugins.CommandInput
	reg, err := plugins.NewRegistry(&plugins.Plugin{
		APIVersion: plugins.APIVersion, ID: "desk", DisplayName: "Desk", Description: "demo",
		Commands: []plugins.CommandSpec{{
			Path: "list", Description: "list", Examples: []string{"agentio desk list"},
			Options: []plugins.OptionSpec{
				{Flags: "--show-completed", Description: "Include completed", DefaultValue: true},
				{Flags: "--no-show-completed", Description: "Exclude completed"},
				{Flags: "--no-archive", Description: "Skip the archive"},
				{Flags: "--read-only", Description: "Read-only"},
				{Flags: "--no-read-only", Description: "Not read-only"},
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
	cases := []struct {
		args []string
		want map[string]any
	}{
		{nil, map[string]any{"show-completed": true, "archive": true, "read-only": false}},
		{[]string{"--no-show-completed"}, map[string]any{"show-completed": false, "archive": true, "read-only": false}},
		{[]string{"--no-show-completed", "--show-completed"}, map[string]any{"show-completed": true, "archive": true, "read-only": false}},
		{[]string{"--show-completed", "--no-show-completed"}, map[string]any{"show-completed": false, "archive": true, "read-only": false}},
		{[]string{"--no-archive"}, map[string]any{"show-completed": true, "archive": false, "read-only": false}},
		{[]string{"--read-only", "--no-read-only"}, map[string]any{"show-completed": true, "archive": true, "read-only": false}},
		{[]string{"--no-read-only", "--read-only"}, map[string]any{"show-completed": true, "archive": true, "read-only": true}},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		args := append([]string{"desk", "list"}, c.args...)
		if code := Execute(reg, args, &out, &errOut, strings.NewReader("")); code != 0 {
			t.Fatalf("%v: code %d %s", c.args, code, errOut.String())
		}
		if in := got[len(got)-1]; !reflect.DeepEqual(in.Options, c.want) {
			t.Errorf("%v:\n got %#v\nwant %#v", c.args, in.Options, c.want)
		}
	}
	errors := []struct{ line, stderr string }{
		{"desk list --archive", "error: unknown option '--archive'\n(Did you mean --no-archive?)"},
		{"desk list --no-read-only=x", "error: unknown option '--no-read-only=x'\n(Did you mean --no-read-only?)"},
		{"desk list --no-sho", "error: unknown option '--no-sho'"},
	}
	for _, c := range errors {
		var out, errOut bytes.Buffer
		code := Execute(reg, strings.Fields(c.line), &out, &errOut, strings.NewReader(""))
		if code != 1 || errOut.String() != c.stderr+"\n" {
			t.Errorf("%s: code %d %q, want %q", c.line, code, errOut.String(), c.stderr+"\n")
		}
	}
	var out, errOut bytes.Buffer
	Execute(reg, []string{"desk", "list", "--help"}, &out, &errOut, strings.NewReader(""))
	if help := out.String(); !strings.Contains(help, "--no-archive") || strings.Contains(help, "--archive ") {
		t.Errorf("help must list --no-archive and not an implicit --archive:\n%s", help)
	}
}

// Bun's `<service> profile update`: `--read-only`/`--no-read-only`, the last
// one wins.
func TestProfileUpdateReadOnlyLastFlagWins(t *testing.T) {
	initCLI(t)
	if code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate"); code != 0 {
		t.Fatal(errOut)
	}
	if err := profile.Save("acme", "ada", testbox.Object(map[string]any{"account": "ada"}), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	steps := []struct {
		args []string
		out  string
		ro   bool
	}{
		{[]string{"--read-only", "--no-read-only"}, "Profile \"ada\" read-only restriction removed\n", false},
		{[]string{"--no-read-only", "--read-only"}, "Profile \"ada\" is now read-only\n", true},
	}
	for _, s := range steps {
		code, out, errOut := run(t, append([]string{"acme", "profile", "update", "--profile", "ada"}, s.args...)...)
		if code != 0 || out != s.out {
			t.Fatalf("%v: code %d %q %q", s.args, code, out, errOut)
		}
		if ro, _ := profile.IsReadOnly("acme", "ada"); ro != s.ro {
			t.Fatalf("%v: read-only %v", s.args, ro)
		}
	}
	code, out, errOut := run(t, "acme", "profile", "update", "--profile", "ada")
	if code != 1 || out != "" || errOut != "Error [INVALID_PARAMS]: No update specified\nSuggestion: Use --read-only or --no-read-only\n" {
		t.Fatalf("no flag: code %d %q %q", code, out, errOut)
	}
}
