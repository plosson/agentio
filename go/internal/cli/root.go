// Package cli is the agentio command line. Services are declarative plugins.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/daemon"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/oauth"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/confluence"
	"github.com/plosson/agentio/go/internal/plugins/discourse"
	"github.com/plosson/agentio/go/internal/plugins/dropbox"
	"github.com/plosson/agentio/go/internal/plugins/falco"
	"github.com/plosson/agentio/go/internal/plugins/github"
	"github.com/plosson/agentio/go/internal/plugins/google/gcal"
	"github.com/plosson/agentio/go/internal/plugins/google/gchat"
	"github.com/plosson/agentio/go/internal/plugins/google/gdocs"
	"github.com/plosson/agentio/go/internal/plugins/google/gdrive"
	"github.com/plosson/agentio/go/internal/plugins/google/gmail"
	"github.com/plosson/agentio/go/internal/plugins/google/gscript"
	"github.com/plosson/agentio/go/internal/plugins/google/gsheets"
	"github.com/plosson/agentio/go/internal/plugins/google/gslides"
	"github.com/plosson/agentio/go/internal/plugins/google/gtasks"
	"github.com/plosson/agentio/go/internal/plugins/jira"
	"github.com/plosson/agentio/go/internal/plugins/revolut"
	"github.com/plosson/agentio/go/internal/plugins/rss"
	"github.com/plosson/agentio/go/internal/plugins/slack"
	sqlplugin "github.com/plosson/agentio/go/internal/plugins/sql"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"golang.org/x/term"
)

// Version is the package.json version, set at build time
// (-ldflags "-X github.com/plosson/agentio/go/internal/cli.Version=…").
var Version = "0.0.0-dev"

func init() {
	// Commander lists commands in registration order.
	cobra.EnableCommandSorting = false
	registerServices(plugins.Default)
}

// registerServices adds the services in Bun's SERVICE_PLUGINS order.
func registerServices(reg *plugins.Registry) {
	reg.MustRegister(confluence.New())
	reg.MustRegister(discourse.New())
	reg.MustRegister(dropbox.New())
	reg.MustRegister(falco.New())
	reg.MustRegister(gcal.New())
	reg.MustRegister(gchat.New())
	reg.MustRegister(gdocs.New())
	reg.MustRegister(gdrive.New())
	reg.MustRegister(github.New())
	reg.MustRegister(gmail.New())
	reg.MustRegister(gsheets.New())
	reg.MustRegister(gslides.New())
	reg.MustRegister(gscript.New())
	reg.MustRegister(gtasks.New())
	reg.MustRegister(jira.New())
	reg.MustRegister(revolut.New())
	reg.MustRegister(rss.New())
	reg.MustRegister(slack.New())
	reg.MustRegister(sqlplugin.New())
}

func Main(args []string) int {
	return Execute(plugins.Default, args, os.Stdout, os.Stderr, os.Stdin)
}

func Execute(reg *plugins.Registry, args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	root := NewRoot(reg)
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(stdin)
	line := commanderParse(root, args)
	switch {
	case line.version:
		fmt.Fprintln(stdout, Version)
		return 0
	case line.err != "":
		fmt.Fprintln(stderr, line.err)
		return 1
	case line.help != nil:
		if line.helpErr {
			root.SetOut(stderr)
		}
		root.SetArgs(append(commandWords(line.help), "--help"))
		_ = root.Execute()
		if line.helpErr {
			return 1
		}
		return 0
	}
	root.SetArgs(line.argv)
	err := root.Execute()
	if err == nil {
		return 0
	}
	var exit *plugins.ExitStatus
	if errors.As(err, &exit) {
		return exit.Code
	}
	var ce *clierr.Error
	if errors.As(err, &ce) {
		fmt.Fprintf(stderr, "Error [%s]: %s\n", ce.Code, ce.Message)
		if ce.Suggestion != "" {
			fmt.Fprintf(stderr, "Suggestion: %s\n", ce.Suggestion)
		}
		return clierr.ExitCode(ce.Code)
	}
	// Bun's handleError prints error.message: a failed send is fetch's bare
	// error, not Go's `Get "…":` wrapping.
	fmt.Fprintf(stderr, "Error: %s\n", errorMessage(err))
	return 1
}

func NewRoot(reg *plugins.Registry) *cobra.Command {
	root := &cobra.Command{
		Use:   "agentio",
		Short: "CLI for LLM agents to interact with communication and tracking services",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
	root.Flags().BoolP("version", "V", false, "output the version number")
	// commanderParse dispatches the line, so cobra's own `completion` and root
	// `help` commands are never reached; Bun's root has neither.
	root.CompletionOptions.DisableDefaultCmd = true
	root.SetHelpCommand(&cobra.Command{Use: "no-help", Hidden: true})
	root.SilenceErrors = true
	root.SilenceUsage = true
	root.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		return gate(cmd, reg)
	}
	// Bun's registration order, which `docs` and `skill` follow.
	for _, p := range reg.Plugins() {
		root.AddCommand(serviceCmd(reg, p))
	}
	addGitHubVaultSecretCommands(root, reg)
	root.AddCommand(docsCmd(), daemonCmd(reg), keyCmd(), loginCmd(), logoutCmd(), pluginCmd(reg),
		profileCmd(reg), reauthCmd(reg), skillCmd(reg), statusCmd(reg), vaultCmd())
	return root
}

var (
	// bypass is Bun's BYPASS_COMMANDS, matched on the command's own name or
	// its parent's, as Bun does: a service command named `update` skips it too.
	bypass    = map[string]bool{"docs": true, "update": true, "doctor": true, "vault": true, "login": true, "logout": true, "plugin": true}
	localOnly = map[string]bool{"vault": true, "key": true, "daemon": true, "reauth": true}
	managed   = map[string]bool{"add": true, "rename": true, "remove": true}
)

// gate is Bun's preAction hook. It runs for the root too: bare `agentio`
// is the root action, which Bun gates on the vault.
func gate(cmd *cobra.Command, _ *plugins.Registry) error {
	top := topName(cmd)
	name := cmd.Name()
	parent := ""
	if cmd.Parent() != nil {
		parent = cmd.Parent().Name()
	}
	if auth.IsRemote() {
		if parent == "profile" && managed[name] {
			flag, err := auth.RemoteCanManage()
			if err != nil {
				return err
			}
			if flag == nil {
				h, _ := auth.Hub()
				return clierr.New(clierr.ConfigError,
					"The vault hub at "+h.URL+" does not support managing profiles from an agent",
					"Update the hub to agentio 2.5 or later")
			}
			if !*flag {
				h, _ := auth.Hub()
				return clierr.CannotManage(h.URL)
			}
			return nil
		}
		if localOnly[name] || localOnly[parent] || localOnly[top] || (parent == "profile" && name != "list") {
			full := name
			if parent != "" && parent != "agentio" {
				full = parent + " " + name
			}
			return auth.RemoteModeError("`agentio " + full + "`")
		}
		return nil
	}
	if bypass[name] || bypass[parent] {
		return nil
	}
	if !vault.Exists() {
		return clierr.New(clierr.VaultNotConfigured, "No vault configured", "Run: agentio vault init")
	}
	return nil
}

func topName(cmd *cobra.Command) string {
	cur := cmd
	for cur.Parent() != nil && cur.Parent().Name() != "agentio" && cur.Parent().Parent() != nil {
		cur = cur.Parent()
	}
	return cur.Name()
}

func serviceCmd(reg *plugins.Registry, p *plugins.Plugin) *cobra.Command {
	cmd := &cobra.Command{Use: p.ID, Short: p.Description}
	for i := range p.Commands {
		spec := p.Commands[i]
		leaf := nested(cmd, spec.Path)
		leaf.Short = spec.Description
		use := leaf.Name()
		for _, arg := range spec.Arguments {
			name := arg.Name
			if arg.Variadic {
				name += "..."
			}
			if arg.Required {
				use += " <" + name + ">"
			} else {
				use += " [" + name + "]"
			}
		}
		leaf.Use = use
		leaf.Aliases = spec.Aliases
		if spec.Default {
			group := leaf.Parent()
			if group.Annotations == nil {
				group.Annotations = map[string]string{}
			}
			group.Annotations[defaultCommand] = leaf.Name()
		}
		if !describesArguments(spec.Arguments) {
			if leaf.Annotations == nil {
				leaf.Annotations = map[string]string{}
			}
			leaf.Annotations[argsUndescribed] = "true"
		}
		leaf.Example = examplesBlock(spec.Examples, spec.ExampleNotes)
		options := spec.Options
		if p.Profile != nil {
			options = plugins.WithProfileOption(options)
		}
		declareOptions(leaf.Flags(), options)
		// A command that declares its own --json (gchat send --json [file]) has
		// no output flag, as in Bun's declarative adapter.
		hostJSON := leaf.Flags().Lookup("json") == nil
		if hostJSON {
			leaf.Flags().Bool("json", false, "Output structured JSON")
			_ = leaf.Flags().SetAnnotation("json", hostOutput, []string{"true"})
		}
		specCopy := spec
		pluginCopy := p
		leaf.RunE = func(c *cobra.Command, args []string) error {
			in := plugins.CommandInput{Args: map[string]any{}, Options: map[string]any{}}
			for i, arg := range specCopy.Arguments {
				if arg.Variadic {
					if i < len(args) {
						in.Args[arg.Name] = args[i:]
					}
					break
				}
				if i < len(args) {
					in.Args[arg.Name] = args[i]
				}
			}
			in.Options = commandOptions(c.Flags(), hostJSON)
			switch specCopy.Input {
			case "text":
				// Read when the command asks: Bun's commands read stdin only
				// when the value it stands in for is missing.
				stdin := c.InOrStdin()
				in.ReadStdin = sync.OnceValues(func() (string, bool) {
					raw, present, err := host.ReadStdin(stdin)
					return raw, present && err == nil
				})
			case "json":
				raw, present, err := host.ReadStdin(c.InOrStdin())
				if err != nil {
					return err
				}
				if in.Stdin, err = host.ParseStdin(&specCopy, raw, present); err != nil {
					return err
				}
			}
			result, err := host.Execute(context.Background(), reg, pluginCopy, &specCopy, in)
			asJSON := false
			if hostJSON {
				asJSON, _ = c.Flags().GetBool("json")
			}
			if err != nil {
				// Bun prints what a command produced and then throws (a sync
				// summary before "N documents failed"), so a value returned with
				// an error is printed before the error is rendered.
				if result != nil {
					_ = host.PrintResult(c.OutOrStdout(), &specCopy, result, asJSON)
				}
				return err
			}
			return host.PrintResult(c.OutOrStdout(), &specCopy, result, asJSON)
		}
	}
	if p.Profile != nil {
		cmd.AddCommand(serviceProfile(reg, p))
	}
	return cmd
}

// describesArguments is Commander's visibleArguments test: arguments show in
// the reference only when one of them has a description.
func describesArguments(args []plugins.ArgumentSpec) bool {
	for _, arg := range args {
		if arg.Description != "" {
			return true
		}
	}
	return false
}

// optionalBare is what pflag stores for a `[value]` flag given without a value.
const optionalBare = "true"

// declareOptions adds plugin OptionSpecs as flags: a <value> flag is a string
// (a []string when repeatable), a [value] flag is a string that may be given
// bare, anything else (or a bool default) is a switch. The Bun flags string
// and requiredOption stay on the flag for commanderParse.
func declareOptions(flags *pflag.FlagSet, opts []plugins.OptionSpec) {
	for _, opt := range opts {
		if target := opt.Negates(); target != "" {
			addNegation(flags, target, opt.Description)
			continue
		}
		fname := longName(opt.Flags)
		if opt.Repeatable {
			flags.StringArray(fname, []string{}, opt.Description)
		} else if isOptionalValue(opt.Flags) {
			flags.String(fname, "", opt.Description)
			flags.Lookup(fname).NoOptDefVal = optionalBare
		} else if _, isBool := opt.DefaultValue.(bool); isBool || !strings.Contains(opt.Flags, "<") {
			def, _ := opt.DefaultValue.(bool)
			flags.Bool(fname, def, opt.Description)
		} else {
			def, _ := opt.DefaultValue.(string)
			flags.String(fname, def, opt.Description)
		}
		_ = flags.SetAnnotation(fname, flagSpecs, []string{opt.Flags})
		if opt.Repeatable {
			setDefault(flags, fname, "")
		} else if opt.DefaultValue != nil && opt.DefaultValue != "" {
			setDefault(flags, fname, jsvalue.String(opt.DefaultValue))
		}
		if opt.Required {
			_ = flags.SetAnnotation(fname, cobra.BashCompOneRequiredFlag, []string{"true"})
		}
	}
}

// negates names, on a Commander `--no-x` flag, the x it sets to false.
const negates = "agentio-negates"

// negationOnly marks the x of a `--no-x` declared without `--x`: it holds the
// value (default true), but the command line has no `--x`.
const negationOnly = "agentio-negation-only"

// addNegation declares Commander's `--no-<name>` (plugins.OptionSpec.Negates).
// commanderParse turns it into `--<name>=false`, so the last of the pair wins
// and the command reads <name>.
func addNegation(flags *pflag.FlagSet, name, usage string) {
	if flags.Lookup(name) == nil {
		flags.Bool(name, true, usage)
		flags.Lookup(name).Hidden = true
		_ = flags.SetAnnotation(name, negationOnly, []string{"true"})
	}
	flags.Bool("no-"+name, false, usage)
	_ = flags.SetAnnotation("no-"+name, negates, []string{name})
}

// commandOptions is Commander's opts(): every option by its attribute name,
// so no `--no-x` of its own, no --help, and no host --json.
func commandOptions(flags *pflag.FlagSet, hostJSON bool) map[string]any {
	out := map[string]any{}
	flags.VisitAll(func(f *pflag.Flag) {
		if f.Name == "help" || (f.Name == "json" && hostJSON) || len(f.Annotations[negates]) > 0 {
			return
		}
		out[f.Name] = flagValue(flags, f)
	})
	return out
}

// optionValues reads back the flags declareOptions added.
func optionValues(flags *pflag.FlagSet, opts []plugins.OptionSpec) map[string]any {
	out := map[string]any{}
	for _, opt := range opts {
		name := longName(opt.Flags)
		if target := opt.Negates(); target != "" {
			name = target
		}
		f := flags.Lookup(name)
		if f == nil {
			continue
		}
		out[name] = flagValue(flags, f)
	}
	return out
}

// flagValue is a switch as bool, a repeatable flag as []string, a [value] flag
// as nil, true or its string (Commander), anything else as string.
func flagValue(flags *pflag.FlagSet, f *pflag.Flag) any {
	if f.NoOptDefVal == optionalBare && f.Value.Type() == "string" {
		switch {
		case !f.Changed:
			return nil
		case f.Value.String() == optionalBare:
			return true
		default:
			return f.Value.String()
		}
	}
	switch f.Value.Type() {
	case "bool":
		b, _ := flags.GetBool(f.Name)
		return b
	case "stringArray":
		values, _ := flags.GetStringArray(f.Name)
		return values
	default:
		// Commander leaves an absent <value> option without a default
		// undefined, which is not an explicit "" (LookupOption).
		if !f.Changed && f.DefValue == "" {
			return nil
		}
		return f.Value.String()
	}
}

func isOptionalValue(flags string) bool {
	return strings.Contains(flags, "[") && !strings.Contains(flags, "<")
}

// defaultCommand is the group annotation naming its CommandSpec.Default child.
const defaultCommand = "agentio-default-command"

func nested(root *cobra.Command, path string) *cobra.Command {
	cur := root
	for _, part := range strings.Fields(path) {
		var child *cobra.Command
		for _, existing := range cur.Commands() {
			if existing.Name() == part {
				child = existing
				break
			}
		}
		if child == nil {
			child = &cobra.Command{Use: part}
			cur.AddCommand(child)
		}
		cur = child
	}
	return cur
}

func longName(flags string) string {
	for _, field := range strings.Fields(strings.ReplaceAll(flags, ",", " ")) {
		if strings.HasPrefix(field, "--") {
			name := strings.TrimPrefix(field, "--")
			if i := strings.IndexAny(name, "<=["); i >= 0 {
				name = name[:i]
			}
			return name
		}
	}
	return flags
}

func serviceProfile(reg *plugins.Registry, p *plugins.Plugin) *cobra.Command {
	group := &cobra.Command{Use: "profile", Short: "Manage " + p.DisplayName + " profiles"}
	var profileName string
	var readOnly bool
	add := &cobra.Command{
		Use:   "add",
		Short: "Add a new " + p.DisplayName + " profile",
		RunE: func(cmd *cobra.Command, _ []string) error {
			opts := plugins.SetupOptions{Profile: profileName, ReadOnly: readOnly, Options: optionValues(cmd.Flags(), p.Profile.SetupOptions)}
			return host.AddProfile(context.Background(), p, opts, host.NewSetupContext(streams(cmd)), cmd.OutOrStdout())
		},
	}
	profileUsage := "Profile name"
	if p.Profile.RequireProfile {
		profileUsage = "Profile name (required)"
	}
	add.Flags().StringVar(&profileName, "profile", "", profileUsage)
	if p.Profile.RequireProfile {
		_ = add.MarkFlagRequired("profile")
	}
	declareOptions(add.Flags(), p.Profile.SetupOptions)
	add.Flags().BoolVar(&readOnly, "read-only", false, "Create as read-only profile (blocks write operations)")
	list := &cobra.Command{
		Use:   "list",
		Short: "List " + p.DisplayName + " profiles",
		RunE: func(cmd *cobra.Command, _ []string) error {
			refs, err := profile.List(p.ID)
			if err != nil {
				return err
			}
			if len(refs) == 0 {
				fmt.Fprintf(cmd.OutOrStdout(), "No %s profiles configured.\n", p.DisplayName)
				fmt.Fprintf(cmd.OutOrStdout(), "Run: agentio %s profile add\n", p.ID)
				return nil
			}
			for _, ref := range refs {
				suffix := ""
				if ref.ReadOnly {
					suffix = " [read-only]"
				}
				extra := ""
				if p.Profile.ListInfo != nil {
					creds, err := auth.GetCredentials(p.ID, ref.Name)
					if err != nil {
						return err
					}
					extra = p.Profile.ListInfo(creds)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%s%s%s\n", ref.Name, suffix, extra)
			}
			return nil
		},
	}
	group.AddCommand(add, list, updateCmd(p.ID), renameCmd(p.ID), removeCmd(p.ID))
	_ = reg
	return group
}

func updateCmd(service string) *cobra.Command {
	var name string
	var value bool
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update a profile",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !cmd.Flags().Changed("read-only") {
				return clierr.New(clierr.InvalidParams, "No update specified", "Use --read-only or --no-read-only")
			}
			ok, err := profile.SetReadOnly(service, name, value)
			if err != nil {
				return err
			}
			if !ok {
				return clierr.ProfileNotFoundError(service, name)
			}
			if value {
				fmt.Fprintf(cmd.OutOrStdout(), "Profile %q is now read-only\n", name)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "Profile %q read-only restriction removed\n", name)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "profile", "", "Profile name")
	_ = cmd.MarkFlagRequired("profile")
	cmd.Flags().BoolVar(&value, "read-only", false, "Set profile as read-only")
	addNegation(cmd.Flags(), "read-only", "Remove read-only restriction")
	return cmd
}

func renameCmd(service string) *cobra.Command {
	var name, to string
	cmd := &cobra.Command{
		Use:   "rename",
		Short: "Rename a profile",
		RunE: func(cmd *cobra.Command, _ []string) error {
			outcome, err := profile.Rename(service, name, to)
			if err != nil {
				return err
			}
			if failure := profile.WriteFailure(outcome, service, name, to); failure != nil {
				return failure
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Renamed profile %q to %q\n", name, to)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "profile", "", "Current profile name")
	cmd.Flags().StringVar(&to, "to", "", "New profile name")
	_ = cmd.MarkFlagRequired("profile")
	_ = cmd.MarkFlagRequired("to")
	return cmd
}

func removeCmd(service string) *cobra.Command {
	var name string
	cmd := &cobra.Command{
		Use:   "remove",
		Short: "Remove a profile",
		RunE: func(cmd *cobra.Command, _ []string) error {
			ok, err := profile.Delete(service, name)
			if err != nil {
				return err
			}
			if !ok {
				return clierr.ProfileNotFoundError(service, name)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Removed profile %q\n", name)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "profile", "", "Profile name")
	_ = cmd.MarkFlagRequired("profile")
	return cmd
}

func profileCmd(reg *plugins.Registry) *cobra.Command {
	cmd := &cobra.Command{Use: "profile", Short: "Manage profiles across services"}
	known := func() string {
		var ids []string
		for _, p := range reg.ProfilePlugins() {
			ids = append(ids, p.ID)
		}
		return strings.Join(ids, ", ")
	}
	assertKnown := func(service string) error {
		if reg.Find(service) == nil || reg.Find(service).Profile == nil {
			return clierr.New(clierr.InvalidParams, fmt.Sprintf("Unknown service: %q", service), "Known services: "+known())
		}
		return nil
	}
	list := &cobra.Command{
		Use:   "list [service]",
		Short: "List configured profiles",
		RunE: func(c *cobra.Command, args []string) error {
			service := ""
			if len(args) == 1 {
				service = args[0]
				if err := assertKnown(service); err != nil {
					return err
				}
			}
			refs, err := profile.List(service)
			if err != nil {
				return err
			}
			if len(refs) == 0 {
				fmt.Fprintln(c.OutOrStdout(), "No profiles configured.")
				fmt.Fprintln(c.OutOrStdout(), "Add one with: agentio profile add <service>")
				return nil
			}
			current := ""
			for _, ref := range refs {
				if ref.Service != current {
					fmt.Fprintf(c.OutOrStdout(), "%s:\n", ref.Service)
					current = ref.Service
				}
				suffix := ""
				if ref.ReadOnly {
					suffix = " [read-only]"
				}
				fmt.Fprintf(c.OutOrStdout(), "  %s%s\n", ref.Name, suffix)
			}
			return nil
		},
	}
	var profileName string
	var readOnly bool
	add := &cobra.Command{
		Use:   "add <service>",
		Short: "Add a profile for a service",
		RunE: func(c *cobra.Command, args []string) error {
			if err := assertKnown(args[0]); err != nil {
				return err
			}
			return host.AddProfile(context.Background(), reg.Find(args[0]), plugins.SetupOptions{Profile: profileName, ReadOnly: readOnly}, host.NewSetupContext(streams(c)), c.OutOrStdout())
		},
	}
	add.Flags().StringVar(&profileName, "profile", "", "Profile name")
	add.Flags().BoolVar(&readOnly, "read-only", false, "Create as read-only profile (blocks write operations)")
	rename := &cobra.Command{
		Use:   "rename <service> <name> <new-name>",
		Short: "Rename a profile, keeping its credentials and key access",
		RunE: func(c *cobra.Command, args []string) error {
			if err := assertKnown(args[0]); err != nil {
				return err
			}
			outcome, err := profile.Rename(args[0], args[1], args[2])
			if err != nil {
				return err
			}
			if failure := profile.WriteFailure(outcome, args[0], args[1], args[2]); failure != nil {
				return failure
			}
			fmt.Fprintf(c.OutOrStdout(), "Renamed profile %q to %q\n", args[1], args[2])
			return nil
		},
	}
	remove := &cobra.Command{
		Use:   "remove <service> <name>",
		Short: "Remove a profile",
		RunE: func(c *cobra.Command, args []string) error {
			if err := assertKnown(args[0]); err != nil {
				return err
			}
			ok, err := profile.Delete(args[0], args[1])
			if err != nil {
				return err
			}
			if !ok {
				return clierr.ProfileNotFoundError(args[0], args[1])
			}
			fmt.Fprintf(c.OutOrStdout(), "Removed profile %q\n", args[1])
			return nil
		},
	}
	reauth := &cobra.Command{
		Use:   "reauth <service> [name]",
		Short: "Re-authenticate an expired or invalid profile",
		RunE: func(c *cobra.Command, args []string) error {
			if err := assertKnown(args[0]); err != nil {
				return err
			}
			name := ""
			if len(args) == 2 {
				name = args[1]
			}
			resolved, _, code, names, err := profile.Resolve(args[0], name)
			if err != nil {
				return err
			}
			if code == "multiple" {
				return clierr.MultipleProfiles(args[0], names)
			}
			if code == "none" {
				if name != "" {
					return clierr.New(clierr.ProfileNotFound, fmt.Sprintf("Profile %q not found for %s", name, args[0]), "Add one with: agentio profile add "+args[0])
				}
				return clierr.New(clierr.ProfileNotFound, "No profiles configured for "+args[0], "Add one with: agentio profile add "+args[0])
			}
			return host.Reauth(context.Background(), reg, args[0], resolved, host.NewSetupContext(streams(c)), c.ErrOrStderr())
		},
	}
	cmd.AddCommand(list, add, rename, remove, reauth)
	return cmd
}

func ids(reg *plugins.Registry) []string {
	var out []string
	for _, p := range reg.Plugins() {
		out = append(out, p.ID)
	}
	return out
}

func streams(cmd *cobra.Command) host.Streams {
	return host.Streams{In: cmd.InOrStdin(), Out: cmd.OutOrStdout(), Err: cmd.ErrOrStderr()}
}

func keyCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "key", Short: "API keys that let remote agents read credentials from this vault"}
	create := &cobra.Command{
		Use: "create <name>", Short: "Create a key and print its token once",
		Example: `  # a key for one agent, limited to two profiles
  agentio key create claudiu --url https://vault.example.com --profiles gdrive/docunit,gmail/work

  # everything, but read-only
  agentio key create reporter --url https://vault.example.com --all --read-only

  # a laptop that manages its own profiles in the vault
  agentio key create laptop --url https://vault.example.com --all --can-manage-profiles

  # capture the token for a deploy script
  AGENTIO_TOKEN=$(agentio key create ci --url https://vault.example.com --all)`,
		RunE: func(c *cobra.Command, args []string) error {
			input, err := keyInput(c.Flags())
			if err != nil {
				return err
			}
			input.Name = args[0]
			if input.AllowedProfiles == nil {
				return clierr.New(clierr.InvalidParams, "Choose a scope", "Pass --all or --profiles <service/name,...>")
			}
			hubURL, _ := c.Flags().GetString("url")
			issued, err := profile.CreateKey(input, hubURL)
			if err != nil {
				return err
			}
			printIssued(c, issued)
			return nil
		},
	}
	create.Flags().String("url", "", "Public base URL of this hub, embedded in the token")
	_ = create.MarkFlagRequired("url")
	keyScopeFlags(create.Flags())
	create.Flags().Bool("read-only", false, "Force read-only on every profile the key can see")
	create.Flags().Bool("can-manage-profiles", false, "Let the agent add, replace, rename and delete profiles from its machine")
	setDefault(create.Flags(), "read-only", "false")
	setDefault(create.Flags(), "can-manage-profiles", "false")
	list := &cobra.Command{
		Use: "list", Short: "List keys (never the secrets)",
		Example: `  agentio key list`,
		RunE: func(c *cobra.Command, _ []string) error {
			keys, err := profile.ListKeys()
			if err != nil {
				return err
			}
			if len(keys) == 0 {
				fmt.Fprintln(c.OutOrStdout(), "No API keys. Create one with: agentio key create <name> --url <hub-url> --all")
				return nil
			}
			for _, k := range keys {
				used := "never used"
				if k.LastUsedAt != "" {
					used = "last used " + k.LastUsedAt
				}
				fmt.Fprintf(c.OutOrStdout(), "%s  %s  agio1.…%s  %s  created %s  %s\n", k.ID, k.Name, k.Hint, profile.DescribeScope(k), k.CreatedAt, used)
			}
			return nil
		},
	}
	update := &cobra.Command{
		Use: "update <id>", Short: "Rename a key or change its scope",
		Example: `  agentio key update a1b2c3d4 --profiles gdrive/docunit
  agentio key update a1b2c3d4 --no-read-only
  agentio key update a1b2c3d4 --can-manage-profiles`,
		RunE: func(c *cobra.Command, args []string) error {
			patch, err := keyInput(c.Flags())
			if err != nil {
				return err
			}
			if patch == (profile.KeyInput{}) {
				return clierr.New(clierr.InvalidParams, "Nothing to update", "Pass at least one option; see --help")
			}
			updated, err := profile.UpdateKey(args[0], patch)
			if err != nil {
				return err
			}
			fmt.Fprintf(c.OutOrStdout(), "Updated \"%s\" (%s): %s\n", updated.Name, updated.ID, profile.DescribeScope(updated))
			return nil
		},
	}
	update.Flags().String("name", "", "New display name")
	keyScopeFlags(update.Flags())
	update.Flags().Bool("read-only", false, "Force read-only")
	addNegation(update.Flags(), "read-only", "Lift the key-level read-only restriction")
	update.Flags().Bool("can-manage-profiles", false, "Let the agent add, replace, rename and delete profiles from its machine")
	addNegation(update.Flags(), "can-manage-profiles", "Stop the agent from managing profiles")
	rotate := &cobra.Command{
		Use: "rotate <id>", Short: "Replace the secret; the old token stops working at once",
		Example: `  agentio key rotate a1b2c3d4 --url https://vault.example.com`,
		RunE: func(c *cobra.Command, args []string) error {
			hubURL, _ := c.Flags().GetString("url")
			issued, err := profile.RotateKey(args[0], hubURL)
			if err != nil {
				return err
			}
			printIssued(c, issued)
			return nil
		},
	}
	rotate.Flags().String("url", "", "Public base URL of this hub, embedded in the new token")
	_ = rotate.MarkFlagRequired("url")
	revoke := &cobra.Command{
		Use: "revoke <id>", Short: "Delete a key; its token stops working at once",
		Example: `  agentio key revoke a1b2c3d4`,
		RunE: func(c *cobra.Command, args []string) error {
			if err := profile.RevokeKey(args[0]); err != nil {
				return err
			}
			fmt.Fprintf(c.OutOrStdout(), "Revoked %s\n", args[0])
			return nil
		},
	}
	cmd.AddCommand(create, list, update, rotate, revoke)
	return cmd
}

func keyScopeFlags(flags *pflag.FlagSet) {
	flags.String("profiles", "", "Comma-separated service/name pairs the key may use")
	flags.Bool("all", false, "Allow every profile")
}

// keyInput is Bun's keyInputFromOptions: an option not given stays nil.
func keyInput(flags *pflag.FlagSet) (profile.KeyInput, error) {
	var in profile.KeyInput
	all, _ := flags.GetBool("all")
	list, _ := flags.GetString("profiles")
	if all && list != "" {
		return in, clierr.New(clierr.InvalidParams, "--all and --profiles are mutually exclusive", "")
	}
	if all {
		in.AllowedProfiles = "*"
	} else if list != "" {
		refs := []string{}
		for _, ref := range strings.Split(list, ",") {
			if ref = jsvalue.Trim(ref); ref != "" {
				refs = append(refs, ref)
			}
		}
		in.AllowedProfiles = refs
	}
	if f := flags.Lookup("name"); f != nil && f.Changed {
		in.Name = f.Value.String()
	}
	for field, flag := range map[*any]string{&in.ReadOnly: "read-only", &in.CanManageProfiles: "can-manage-profiles"} {
		if flags.Changed(flag) {
			*field, _ = flags.GetBool(flag)
		}
	}
	return in, nil
}

// printIssued writes the token alone to stdout, so it can be captured, and
// everything else to stderr.
func printIssued(c *cobra.Command, issued profile.IssuedKey) {
	fmt.Fprintf(c.ErrOrStderr(), "Key \"%s\" (%s), %s\n", issued.Key.Name, issued.Key.ID, profile.DescribeScope(issued.Key))
	fmt.Fprintln(c.ErrOrStderr(), "This token is shown once. Set it on the agent machine as AGENTIO_TOKEN.")
	fmt.Fprintln(c.OutOrStdout(), issued.Token)
}

func daemonCmd(reg *plugins.Registry) *cobra.Command {
	cmd := &cobra.Command{Use: "daemon", Short: "Run or probe the local HTTP daemon"}
	start := &cobra.Command{
		Use: "start", Short: "Run the daemon in the foreground",
		Example: `  # run the daemon in the foreground (Docker CMD, or a terminal for dev)
  agentio daemon start`,
		RunE: func(c *cobra.Command, _ []string) error {
			vault.SetMemoryOnly(true)
			if pw, src := passFromEnv(); src == "env" {
				if err := vault.Unlock(pw); err != nil {
					return err
				}
				os.Unsetenv("AGENTIO_PASSPHRASE")
				fmt.Fprintln(c.ErrOrStderr(), "Vault unlocked from AGENTIO_PASSPHRASE")
				daemon.KeepaliveFromEnv(context.Background(), reg)
			} else {
				fmt.Fprintln(c.ErrOrStderr(), "Vault is locked")
			}
			addr := fmt.Sprintf("%s:%d", daemon.Host, daemon.Port)
			fmt.Fprintf(c.ErrOrStderr(), "agentio-daemon listening on %s\n", addr)
			srv := &daemon.Server{Registry: reg, Version: Version}
			return http.ListenAndServe(addr, srv.Handler())
		},
	}
	status := &cobra.Command{
		Use: "status", Short: "Show daemon status",
		Example: `  # show whether the daemon is running
  agentio daemon status`,
		RunE: func(c *cobra.Command, _ []string) error {
			fmt.Fprintf(c.OutOrStdout(), "daemon http://127.0.0.1:%d/health\n", daemon.Port)
			return nil
		},
	}
	cmd.AddCommand(start, status)
	return cmd
}

func passFromEnv() (string, string) {
	v := os.Getenv("AGENTIO_PASSPHRASE")
	if v == "" {
		return "", ""
	}
	return v, "env"
}

// openBrowser opens the approval page; tests replace it.
var openBrowser = oauth.LaunchBrowser

// loginPoll replaces the hub's poll interval when set, and loginSleep waits
// between polls (tests).
var (
	loginPoll  time.Duration
	loginSleep = time.Sleep
)

func loginCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login <hub-url>",
		Short: "Get a key from a vault hub by approving a code in its admin UI",
		Example: `  # from a laptop: opens the approval page in the browser
  agentio login https://vault.example.com

  # from a VPS over SSH: approve from any device that can reach the hub
  agentio login https://vault.example.com --no-browser --name build-box`,
		RunE: func(c *cobra.Command, args []string) error {
			if auth.TokenSource() == "env" {
				return clierr.New(clierr.ConfigError, "AGENTIO_TOKEN is set, so a stored login would be ignored", "Unset AGENTIO_TOKEN first, or keep using it")
			}
			name, _ := c.Flags().GetString("name")
			browser, _ := c.Flags().GetBool("browser")
			stderr := c.ErrOrStderr()
			result, err := profile.DeviceLogin(profile.DeviceLoginOptions{
				URL:          args[0],
				Name:         name,
				PollInterval: loginPoll,
				Sleep:        loginSleep,
				OnCode: func(userCode, verifyURL string, expiresIn float64) {
					fmt.Fprintf(stderr, "Your code: %s\n", userCode)
					fmt.Fprintf(stderr, "Approve it at %s within %s minutes.\n", verifyURL, jsvalue.NumberString(math.Floor(expiresIn/60+0.5)))
					if browser && openBrowser(verifyURL) {
						fmt.Fprintln(stderr, "Opened it in your browser.")
					}
					fmt.Fprintln(stderr, "Waiting for approval…")
				},
			})
			if err != nil {
				return err
			}
			path, err := auth.SaveRemoteToken(result.Token)
			if err != nil {
				return err
			}
			fmt.Fprintf(c.OutOrStdout(), "Signed in to %s as key \"%s\" (%s): %s\n", result.URL, result.Key.Name, result.Key.ID, profile.DescribeScope(result.Key))
			fmt.Fprintf(c.OutOrStdout(), "Token stored in %s. Every agentio command on this machine now uses the hub.\n", path)
			return nil
		},
	}
	cmd.Flags().String("name", "", "How this machine introduces itself (default: hostname)")
	addNegation(cmd.Flags(), "browser", "Print the approval URL instead of opening it")
	return cmd
}

func logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use: "logout", Short: "Forget the stored hub token on this machine",
		Example: `  agentio logout`,
		RunE: func(c *cobra.Command, _ []string) error {
			removed, err := auth.ClearRemoteToken()
			if err != nil {
				return err
			}
			switch {
			case removed:
				fmt.Fprintf(c.OutOrStdout(), "Removed %s. The key still exists on the hub; revoke it there if it should stop working.\n", vault.TokenPath())
			case auth.TokenSource() == "env":
				fmt.Fprintln(c.OutOrStdout(), "No stored login. This machine uses AGENTIO_TOKEN; unset it to leave remote mode.")
			default:
				fmt.Fprintln(c.OutOrStdout(), "No stored login on this machine.")
			}
			return nil
		},
	}
}

func statusCmd(reg *plugins.Registry) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show configured profiles and credential status",
		Example: `  # show every configured profile and test its credentials
  agentio status

  # show profiles without making test API calls (fast; no network)
  agentio status --no-test

  # JSON output (good for piping to jq or another agent)
  agentio status --json`,
		RunE: func(c *cobra.Command, _ []string) error {
			test, _ := c.Flags().GetBool("test")
			render := statusText
			if asJSON {
				render = statusJSON
			}
			if err := render(c, reg, test); err != nil {
				// Bun's status prints the message alone, not the CliError format.
				fmt.Fprintf(c.ErrOrStderr(), "Error: %s\n", errorMessage(err))
				return &plugins.ExitStatus{Code: 1}
			}
			return nil
		},
	}
	addNegation(cmd.Flags(), "test", "Skip credential testing")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output in JSON format")
	return cmd
}

// errorMessage is JavaScript's error.message: a CliError's message alone, a
// failed fetch as Bun words it.
func errorMessage(err error) string {
	var ce *clierr.Error
	if errors.As(err, &ce) {
		return ce.Message
	}
	return plugins.FetchFailure(err).Error()
}

func statusJSON(c *cobra.Command, reg *plugins.Registry, test bool) error {
	rows, err := host.Statuses(context.Background(), reg, test)
	if err != nil {
		return err
	}
	out := jsvalue.NewObject()
	out.Set("version", Version)
	if auth.IsRemote() {
		h, err := auth.Hub()
		if err != nil {
			return err
		}
		out.Set("hub", h.URL)
		canManage, err := auth.RemoteCanManage()
		if err != nil {
			return err
		}
		if canManage != nil {
			out.Set("canManageProfiles", *canManage)
		}
	} else {
		out.Set("configDir", vault.ConfigDir())
	}
	out.Set("services", host.ByService(rows))
	fmt.Fprintln(c.OutOrStdout(), string(jsvalue.StringifyIndent(out)))
	return nil
}

// statusText prints each row as soon as its check finishes, with a spinner on
// a terminal's stderr while it runs.
func statusText(c *cobra.Command, reg *plugins.Registry, test bool) error {
	stdout := c.OutOrStdout()
	fmt.Fprintf(stdout, "agentio v%s\n", Version)
	if auth.IsRemote() {
		h, err := auth.Hub()
		if err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Hub: %s\n\n", h.URL)
	} else {
		fmt.Fprintf(stdout, "Config: %s\n\n", vault.ConfigDir())
	}
	refs, err := profile.List("")
	if err != nil {
		return err
	}
	if len(refs) == 0 {
		fmt.Fprintln(stdout, "No profiles configured.")
		fmt.Fprintln(stdout, "Run: agentio <service> profile add")
		return nil
	}
	serviceWidth, profileWidth := 0, 0
	for _, ref := range refs {
		serviceWidth = max(serviceWidth, jsvalue.Length(ref.Service))
		profileWidth = max(profileWidth, jsvalue.Length(ref.Name))
	}
	var spin *spinner
	if test && isTerminal(c.ErrOrStderr()) {
		spin = &spinner{w: c.ErrOrStderr()}
	}
	for i, ref := range refs {
		spin.start(ref.Service+" "+ref.Name, i+1, len(refs))
		row, err := host.Check(context.Background(), reg, ref, test)
		spin.stop()
		if err != nil {
			return err
		}
		fmt.Fprintln(stdout, statusLine(row, serviceWidth, profileWidth))
	}
	return nil
}

// statusLine is Bun's formatStatusLine.
func statusLine(s host.ProfileStatus, serviceWidth, profileWidth int) string {
	readOnly := ""
	if s.ReadOnly != nil && *s.ReadOnly {
		readOnly = " [RO]"
	}
	var status, details string
	switch s.Status {
	case "ok":
		status, details = "ok", s.Info
	case "invalid":
		status, details = "ERR", s.Error
	case "no-creds":
		status, details = "ERR", "no credentials"
	case "skipped":
		status = "-"
	}
	line := jsvalue.PadEnd(s.Service, serviceWidth) + "  " + jsvalue.PadEnd(s.Profile+readOnly, profileWidth+5) +
		"  " + jsvalue.PadEnd(status, 3) + "  " + details
	return strings.TrimRightFunc(line, jsvalue.IsSpace)
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// spinner is Bun status's progress line on stderr. A nil spinner does nothing.
type spinner struct {
	w    io.Writer
	done chan struct{}
	wg   sync.WaitGroup
}

func (s *spinner) start(label string, index, total int) {
	if s == nil {
		return
	}
	s.done = make(chan struct{})
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(80 * time.Millisecond)
		defer ticker.Stop()
		for frame := 0; ; frame++ {
			fmt.Fprintf(s.w, "\r\x1b[K  %s checking %s (%d/%d)", spinnerFrames[frame%len(spinnerFrames)], label, index, total)
			select {
			case <-s.done:
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *spinner) stop() {
	if s == nil {
		return
	}
	close(s.done)
	s.wg.Wait()
	fmt.Fprint(s.w, "\r\x1b[K")
}

func reauthCmd(reg *plugins.Registry) *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:    "reauth",
		Short:  "Re-authenticate expired or invalid profiles",
		Hidden: true,
		RunE: func(c *cobra.Command, _ []string) error {
			rows, err := host.Statuses(context.Background(), reg, true)
			if err != nil {
				return err
			}
			var bad []host.ProfileStatus
			for _, row := range rows {
				if row.Status == "invalid" || row.Status == "no-creds" {
					bad = append(bad, row)
				}
			}
			if len(bad) == 0 {
				fmt.Fprintln(c.OutOrStdout(), "All profiles are valid.")
				return nil
			}
			if !all {
				return clierr.New(clierr.InvalidParams, "Refusing to reauth without --all", "Re-run with --all")
			}
			setup := host.NewSetupContext(streams(c))
			for _, row := range bad {
				if err := host.Reauth(context.Background(), reg, row.Service, row.Profile, setup, c.ErrOrStderr()); err != nil {
					fmt.Fprintf(c.ErrOrStderr(), "\n  Failed to reauth %s / %s: %s\n", row.Service, row.Profile, err.Error())
				}
			}
			fmt.Fprintln(c.OutOrStdout(), "\nDone.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "Re-authenticate all invalid profiles without prompting")
	return cmd
}

func pluginCmd(reg *plugins.Registry) *cobra.Command {
	cmd := &cobra.Command{Use: "plugin", Short: "Inspect the plugin catalog"}
	cmd.AddCommand(&cobra.Command{
		Use: "list", Short: "List registered plugins",
		RunE: func(c *cobra.Command, _ []string) error {
			for _, p := range reg.Plugins() {
				kind := "no-profile"
				if p.Profile != nil && p.Profile.Refresh != nil {
					kind = "refreshable"
				} else if p.Profile != nil {
					kind = "static"
				}
				fmt.Fprintf(c.OutOrStdout(), "%s\t%s\t%s\n", p.ID, kind, p.Description)
			}
			return nil
		},
	})
	return cmd
}
