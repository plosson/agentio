package plugins

import (
	"context"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/jsvalue"
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
			p.Commands[0].Options = []OptionSpec{{Flags: "--profile <name>", Description: "nope"}}
		}, "host option"},
		{"profile placed twice", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate}
			p.Commands[0].Options = []OptionSpec{ProfileOption("Profile name"), ProfileOption("Profile name")}
		}, "host option"},
		{"profile under another syntax", func(p *Plugin) {
			p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate}
			p.Commands[0].Options = []OptionSpec{{Flags: "-p, --profile <name>", Description: "Profile name"}}
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
		{"two defaults in one group", func(p *Plugin) {
			p.Commands[0].Default = true
			p.Commands = append(p.Commands, CommandSpec{
				Path: "items get", Description: "Get", Examples: []string{"agentio acme items get"},
				Default: true, Run: p.Commands[0].Run,
			})
		}, "cannot be the default"},
		{"default under a command", func(p *Plugin) {
			p.Commands[0].Default = true
			p.Commands = append(p.Commands, CommandSpec{
				Path: "items", Description: "Items", Examples: []string{"agentio acme items"}, Run: p.Commands[0].Run,
			})
		}, "cannot be the default"},
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
		{"group that is a command", func(p *Plugin) {
			p.Groups = []GroupSpec{{Path: "items list", Description: "List"}}
		}, "invalid or duplicate group"},
		{"group with no command under it", func(p *Plugin) {
			p.Groups = []GroupSpec{{Path: "things", Description: "Things"}}
		}, "invalid or duplicate group"},
		{"group that is only a prefix of a word", func(p *Plugin) {
			p.Groups = []GroupSpec{{Path: "item", Description: "Item"}}
		}, "invalid or duplicate group"},
		{"group described twice", func(p *Plugin) {
			p.Groups = []GroupSpec{{Path: "items", Description: "Items"}, {Path: "items", Description: "Again"}}
		}, "invalid or duplicate group"},
		{"group without a description", func(p *Plugin) {
			p.Groups = []GroupSpec{{Path: "items", Description: " \t"}}
		}, "invalid or duplicate group"},
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
	return &SetupResult{Credentials: jsvalue.ObjectOf("t", "1"), SuggestedProfileName: "a"}, nil
}

func nopValidate(context.Context, *RunContext) (ValidationResult, error) {
	return ValidationResult{Valid: true}, nil
}

// ProfileOption places --profile where the Bun command declares it; without
// it the host puts it after the leading required options.
func TestProfileOptionPlacement(t *testing.T) {
	p := valid()
	p.Profile = &ProfileSpec{Setup: nopSetup, Validate: nopValidate}
	p.Commands[0].Options = []OptionSpec{{Flags: "--a <x>", Description: "a"}, ProfileOption("Profile name")}
	if _, err := NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	flags := func(opts []OptionSpec) string {
		var out []string
		for _, o := range opts {
			out = append(out, o.Flags+"="+o.Description)
		}
		return strings.Join(out, " ")
	}
	req := OptionSpec{Flags: "--req <x>", Description: "r", Required: true}
	opt := OptionSpec{Flags: "--opt <x>", Description: "o"}
	late := OptionSpec{Flags: "--late <x>", Description: "l", Required: true}
	def := "--profile <name>=Profile name (optional if only one profile exists)"
	for _, c := range []struct {
		in   []OptionSpec
		want string
	}{
		{nil, def},
		{[]OptionSpec{opt, req}, def + " --opt <x>=o --req <x>=r"},
		{[]OptionSpec{req, req, opt, late}, "--req <x>=r --req <x>=r " + def + " --opt <x>=o --late <x>=l"},
		{[]OptionSpec{req, opt, ProfileOption("Profile name")}, "--req <x>=r --opt <x>=o --profile <name>=Profile name"},
	} {
		in := append([]OptionSpec(nil), c.in...)
		if got := flags(WithProfileOption(c.in)); got != c.want {
			t.Errorf("got  %s\nwant %s", got, c.want)
		}
		if flags(in) != flags(c.in) {
			t.Error("WithProfileOption changed its input")
		}
	}
}

func TestGroupDescriptionsRegister(t *testing.T) {
	p := valid()
	p.Groups = []GroupSpec{{Path: "items", Description: "Manage items"}}
	if _, err := NewRegistry(p); err != nil {
		t.Fatal(err)
	}
}
