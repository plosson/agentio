package plugins

import (
	"context"
	"strings"
	"testing"
)

func valid() *Plugin {
	return &Plugin{
		APIVersion: APIVersion, ID: "acme", DisplayName: "Acme", Description: "demo",
		Commands: []CommandSpec{{
			Path: "items list", Description: "List", Examples: []string{"agentio acme items list"},
			Run: func(context.Context, CommandInput, *RunContext) (any, error) { return nil, nil },
		}},
	}
}

func TestRegistryRejectsABrokenContract(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Plugin)
		want string
	}{
		{"version", func(p *Plugin) { p.APIVersion = 2 }, "unsupported plugin API"},
		{"id", func(p *Plugin) { p.ID = "Acme" }, "invalid service id"},
		{"reserved", func(p *Plugin) { p.ID = "vault" }, "reserved"},
		{"blank name", func(p *Plugin) { p.DisplayName = " " }, "display name"},
		{"no commands", func(p *Plugin) { p.Commands = nil }, "no commands"},
		{"profile path", func(p *Plugin) { p.Commands[0].Path = "profile add" }, "reserved"},
		{"dup path", func(p *Plugin) {
			p.Commands = append(p.Commands, p.Commands[0])
		}, "duplicate command"},
		{"no example", func(p *Plugin) { p.Commands[0].Examples = nil }, "no examples"},
		{"no handler", func(p *Plugin) { p.Commands[0].Run = nil }, "no handler"},
		{"host flag", func(p *Plugin) {
			p.Commands[0].Options = []OptionSpec{{Flags: "--json", Description: "nope"}}
		}, "host option"},
		{"bad flag", func(p *Plugin) {
			p.Commands[0].Options = []OptionSpec{{Flags: "-x", Description: "short only"}}
		}, "invalid option"},
		{"repeatable switch", func(p *Plugin) {
			p.Commands[0].Options = []OptionSpec{{Flags: "--all", Description: "switch", Repeatable: true}}
		}, "repeatable option without a value"},
		{"alias shadows a sibling", func(p *Plugin) {
			p.Commands = append(p.Commands, CommandSpec{
				Path: "items get", Description: "Get", Examples: []string{"agentio acme items get"},
				Aliases: []string{"list"}, Run: p.Commands[0].Run,
			})
		}, "duplicate alias"},
		{"alias named profile", func(p *Plugin) {
			p.Commands[0].Path = "list"
			p.Commands[0].Aliases = []string{"profile"}
		}, "invalid or duplicate alias"},
		{"alias not a command word", func(p *Plugin) { p.Commands[0].Aliases = []string{"Ls"} }, "invalid or duplicate alias"},
		{"required after optional", func(p *Plugin) {
			p.Commands[0].Arguments = []ArgumentSpec{{Name: "maybe"}, {Name: "need", Required: true}}
		}, "required argument after"},
		{"empty secrets", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate, Refresh: &RefreshSpec{}}
		}, "secret fields"},
		{"profile missing validate", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup}
		}, "invalid profile"},
		{"setup option redeclares --read-only", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate,
				SetupOptions: []OptionSpec{{Flags: "--read-only", Description: "nope"}}}
		}, "profile add redeclares host option"},
		{"setup option redeclares --profile", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate,
				SetupOptions: []OptionSpec{{Flags: "--profile <name>", Description: "nope"}}}
		}, "profile add redeclares host option"},
		{"setup option without a long flag", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate,
				SetupOptions: []OptionSpec{{Flags: "-k <key>", Description: "short only"}}}
		}, "profile add has invalid option"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := valid()
			tc.mut(p)
			_, err := NewRegistry(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestDuplicateID(t *testing.T) {
	_, err := NewRegistry(valid(), valid())
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatal(err)
	}
}

func nopSetup(context.Context, SetupOptions, *SetupContext) (*SetupResult, error) {
	return &SetupResult{Credentials: map[string]any{"t": "1"}, SuggestedProfileName: "a"}, nil
}

func nopValidate(context.Context, *RunContext) (ValidationResult, error) {
	return ValidationResult{Valid: true}, nil
}
