// Package cli is the agentio command line. Services are declarative plugins.
// The three built-in plugins (acme, board, ping) are fakes that exercise the host.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/daemon"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/board"
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
	"github.com/plosson/agentio/go/internal/plugins/ping"
	"github.com/plosson/agentio/go/internal/plugins/revolut"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const Version = "0.0.0-foundation"

func init() {
	plugins.Default.MustRegister(acme.New())
	plugins.Default.MustRegister(board.New())
	plugins.Default.MustRegister(ping.New())
	plugins.Default.MustRegister(confluence.New())
	plugins.Default.MustRegister(discourse.New())
	plugins.Default.MustRegister(dropbox.New())
	plugins.Default.MustRegister(falco.New())
	plugins.Default.MustRegister(gcal.New())
	plugins.Default.MustRegister(gchat.New())
	plugins.Default.MustRegister(gdocs.New())
	plugins.Default.MustRegister(gdrive.New())
	plugins.Default.MustRegister(github.New())
	plugins.Default.MustRegister(gmail.New())
	plugins.Default.MustRegister(gsheets.New())
	plugins.Default.MustRegister(gslides.New())
	plugins.Default.MustRegister(gscript.New())
	plugins.Default.MustRegister(gtasks.New())
	plugins.Default.MustRegister(jira.New())
	plugins.Default.MustRegister(revolut.New())
}

func Main(args []string) int {
	return Execute(plugins.Default, args, os.Stdout, os.Stderr, os.Stdin)
}

func Execute(reg *plugins.Registry, args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	root := NewRoot(reg)
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(stdin)
	root.SetArgs(optionalValues(root, defaultSubcommands(root, args)))
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
	fmt.Fprintf(stderr, "Error: %s\n", err.Error())
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
	root.Version = Version
	root.SilenceErrors = true
	root.SilenceUsage = true
	root.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		return gate(cmd, reg)
	}
	root.AddCommand(vaultCmd())
	root.AddCommand(profileCmd(reg))
	root.AddCommand(keyCmd())
	root.AddCommand(daemonCmd(reg))
	root.AddCommand(loginCmd(), logoutCmd())
	root.AddCommand(statusCmd(reg), reauthCmd(reg))
	root.AddCommand(docsCmd(reg), skillCmd(reg), pluginCmd(reg))
	for _, p := range reg.Plugins() {
		root.AddCommand(serviceCmd(reg, p))
	}
	addGitHubVaultSecretCommands(root, reg)
	return root
}

var (
	bypass    = map[string]bool{"vault": true, "login": true, "logout": true, "plugin": true, "docs": true, "skill": true}
	localOnly = map[string]bool{"vault": true, "key": true, "daemon": true, "reauth": true}
	managed   = map[string]bool{"add": true, "rename": true, "remove": true}
)

func gate(cmd *cobra.Command, _ *plugins.Registry) error {
	if cmd.Parent() == nil {
		return nil
	}
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
	if bypass[top] || bypass[name] || bypass[parent] {
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
		if len(spec.Examples) > 0 {
			leaf.Example = strings.Join(spec.Examples, "\n")
		}
		req := 0
		variadic := false
		for _, arg := range spec.Arguments {
			if arg.Required {
				req++
			}
			if arg.Variadic {
				variadic = true
			}
		}
		switch {
		case variadic:
			leaf.Args = cobra.MinimumNArgs(req)
		case len(spec.Arguments) == req:
			leaf.Args = cobra.ExactArgs(req)
		default:
			leaf.Args = cobra.RangeArgs(req, len(spec.Arguments))
		}
		declareOptions(leaf.Flags(), spec.Options)
		if p.Profile != nil {
			leaf.Flags().String("profile", "", "Profile name (optional if only one profile exists)")
		}
		// A command that declares its own --json (gchat send --json [file]) has
		// no output flag, as in Bun's declarative adapter.
		hostJSON := leaf.Flags().Lookup("json") == nil
		if hostJSON {
			leaf.Flags().Bool("json", false, "Output structured JSON")
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
			c.Flags().VisitAll(func(f *pflag.Flag) {
				if f.Name == "json" && hostJSON {
					return
				}
				in.Options[f.Name] = flagValue(c.Flags(), f)
			})
			if specCopy.Input == "text" || specCopy.Input == "json" {
				raw, present, err := host.ReadStdin(c.InOrStdin())
				if err != nil {
					return err
				}
				stdin, err := host.ParseStdin(&specCopy, raw, present)
				if err != nil {
					return err
				}
				in.Stdin = stdin
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

// optionalBare is what pflag stores for a `[value]` flag given without a value.
const optionalBare = "true"

// declareOptions adds plugin OptionSpecs as flags: a <value> flag is a string
// (a []string when repeatable), a [value] flag is a string that may be given
// bare, anything else (or a bool default) is a switch.
func declareOptions(flags *pflag.FlagSet, opts []plugins.OptionSpec) {
	for _, opt := range opts {
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
	}
}

// optionValues reads back the flags declareOptions added.
func optionValues(flags *pflag.FlagSet, opts []plugins.OptionSpec) map[string]any {
	out := map[string]any{}
	for _, opt := range opts {
		name := longName(opt.Flags)
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

// optionalValues gives a [value] flag Commander's parsing: `--json card.json`
// takes card.json as the value unless it starts with "-". pflag only takes a
// value after "=", so the pair is joined before cobra parses the line.
func optionalValues(root *cobra.Command, args []string) []string {
	leaf, _, err := root.Find(args)
	if err != nil || leaf == nil {
		return args
	}
	optional := map[string]bool{}
	leaf.Flags().VisitAll(func(f *pflag.Flag) {
		if f.NoOptDefVal == optionalBare && f.Value.Type() == "string" {
			optional["--"+f.Name] = true
		}
	})
	if len(optional) == 0 {
		return args
	}
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return append(out, args[i:]...)
		}
		if optional[a] && i+1 < len(args) && !(len(args[i+1]) > 1 && args[i+1][0] == '-') {
			out = append(out, a+"="+args[i+1])
			i++
			continue
		}
		out = append(out, a)
	}
	return out
}

// defaultCommand is the group annotation naming its CommandSpec.Default child.
const defaultCommand = "agentio-default-command"

// defaultSubcommands gives a group with a Default command Commander's
// dispatch: `gtasks lists --limit 5` runs `gtasks lists list --limit 5`.
// Asking the group itself for help still shows the group, as in Commander.
func defaultSubcommands(root *cobra.Command, args []string) []string {
	group, _, err := root.Find(args)
	if err != nil || group == nil || group.Annotations[defaultCommand] == "" {
		return args
	}
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "-h" || a == "--help" {
			return args
		}
	}
	// Find the argument that named the group: walk the command words from
	// the root, skipping flags, and insert the default right after it.
	var chain []*cobra.Command
	for c := group; c != root && c != nil; c = c.Parent() {
		chain = append([]*cobra.Command{c}, chain...)
	}
	at := -1
	for i, a := range args {
		if len(chain) == 0 {
			break
		}
		if a == "--" {
			return args
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if chain[0].Name() != a && !chain[0].HasAlias(a) {
			return args
		}
		chain = chain[1:]
		at = i
	}
	if len(chain) != 0 || at < 0 {
		return args
	}
	out := make([]string, 0, len(args)+1)
	out = append(out, args[:at+1]...)
	out = append(out, group.Annotations[defaultCommand])
	return append(out, args[at+1:]...)
}

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
	add.Flags().StringVar(&profileName, "profile", "", "Profile name")
	declareOptions(add.Flags(), p.Profile.SetupOptions)
	add.Flags().BoolVar(&readOnly, "read-only", false, "Create as read-only profile (blocks write operations)")
	list := &cobra.Command{
		Use:   "list",
		Short: "List " + p.DisplayName + " profiles",
		RunE: func(cmd *cobra.Command, _ []string) error {
			refs, err := profile.List(p.ID, nil)
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
	var readOnly bool
	var noReadOnly bool
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update a profile",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !cmd.Flags().Changed("read-only") && !cmd.Flags().Changed("no-read-only") {
				return clierr.New(clierr.InvalidParams, "No update specified", "Use --read-only or --no-read-only")
			}
			value := readOnly
			if cmd.Flags().Changed("no-read-only") && !readOnly {
				value = false
			}
			if noReadOnly {
				value = false
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
	cmd.Flags().BoolVar(&readOnly, "read-only", false, "Set profile as read-only")
	cmd.Flags().BoolVar(&noReadOnly, "no-read-only", false, "Remove read-only restriction")
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
		Args:  cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			service := ""
			if len(args) == 1 {
				service = args[0]
				if err := assertKnown(service); err != nil {
					return err
				}
			}
			refs, err := profile.List(service, ids(reg))
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
		Args:  cobra.ExactArgs(1),
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
		Args:  cobra.ExactArgs(3),
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
		Args:  cobra.ExactArgs(2),
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
		Args:  cobra.RangeArgs(1, 2),
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
	cmd := &cobra.Command{Use: "key", Short: "Manage API keys for remote agents"}
	var name, hubURL string
	var readOnly, manage, all bool
	create := &cobra.Command{
		Use:   "create",
		Short: "Create an API key",
		RunE: func(c *cobra.Command, _ []string) error {
			scope := any([]string{})
			if all {
				scope = "*"
			}
			if hubURL == "" {
				hubURL = "http://127.0.0.1:7890"
			}
			issued, err := profile.CreateKey(profile.KeyInput{
				Name: name, AllowedProfiles: scope, ReadOnly: readOnly, CanManageProfiles: manage,
			}, hubURL)
			if err != nil {
				return err
			}
			fmt.Fprintf(c.OutOrStdout(), "Key %s created (%s)\n", issued.Key.ID, profile.DescribeScope(issued.Key))
			fmt.Fprintln(c.OutOrStdout(), issued.Token)
			return nil
		},
	}
	create.Flags().StringVar(&name, "name", "", "Key name")
	create.Flags().StringVar(&hubURL, "url", "http://127.0.0.1:7890", "Hub URL embedded in the token")
	create.Flags().BoolVar(&readOnly, "read-only", false, "Force read-only")
	create.Flags().BoolVar(&manage, "manage", false, "Allow this key to manage profiles")
	create.Flags().BoolVar(&all, "all", false, "Allow every profile")
	_ = create.MarkFlagRequired("name")
	list := &cobra.Command{
		Use: "list", Short: "List API keys",
		RunE: func(c *cobra.Command, _ []string) error {
			keys, err := profile.ListKeys()
			if err != nil {
				return err
			}
			if len(keys) == 0 {
				fmt.Fprintln(c.OutOrStdout(), "No keys.")
				return nil
			}
			for _, k := range keys {
				fmt.Fprintf(c.OutOrStdout(), "%s  %s  %s\n", k.ID, k.Name, profile.DescribeScope(k))
			}
			return nil
		},
	}
	var id string
	revoke := &cobra.Command{
		Use: "revoke <id>", Short: "Revoke an API key", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := profile.RevokeKey(args[0]); err != nil {
				return err
			}
			fmt.Fprintf(c.OutOrStdout(), "Revoked %s\n", args[0])
			return nil
		},
	}
	rotate := &cobra.Command{
		Use: "rotate <id>", Short: "Rotate an API key secret", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if hubURL == "" {
				hubURL = "http://127.0.0.1:7890"
			}
			issued, err := profile.RotateKey(args[0], hubURL)
			if err != nil {
				return err
			}
			fmt.Fprintln(c.OutOrStdout(), issued.Token)
			return nil
		},
	}
	rotate.Flags().StringVar(&hubURL, "url", "http://127.0.0.1:7890", "Hub URL embedded in the token")
	update := &cobra.Command{
		Use: "update <id>", Short: "Update an API key", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			patch := profile.KeyInput{}
			if c.Flags().Changed("name") {
				patch.Name = name
			}
			if c.Flags().Changed("read-only") {
				patch.ReadOnly = readOnly
			}
			if c.Flags().Changed("manage") {
				patch.CanManageProfiles = manage
			}
			if c.Flags().Changed("all") && all {
				patch.AllowedProfiles = "*"
			}
			updated, err := profile.UpdateKey(args[0], patch)
			if err != nil {
				return err
			}
			fmt.Fprintf(c.OutOrStdout(), "%s  %s\n", updated.ID, profile.DescribeScope(updated))
			return nil
		},
	}
	update.Flags().StringVar(&name, "name", "", "New name")
	update.Flags().BoolVar(&readOnly, "read-only", false, "Force read-only")
	update.Flags().BoolVar(&manage, "manage", false, "Allow profile management")
	update.Flags().BoolVar(&all, "all", false, "Allow every profile")
	_ = id
	cmd.AddCommand(create, list, update, rotate, revoke)
	return cmd
}

func daemonCmd(reg *plugins.Registry) *cobra.Command {
	cmd := &cobra.Command{Use: "daemon", Short: "Run the local credential hub"}
	start := &cobra.Command{
		Use: "start", Short: "Start the daemon in the foreground",
		RunE: func(c *cobra.Command, _ []string) error {
			vault.SetMemoryOnly(true)
			if pw, src := passFromEnv(); src == "env" {
				if err := vault.Unlock(pw); err != nil {
					return err
				}
				os.Unsetenv("AGENTIO_PASSPHRASE")
				fmt.Fprintln(c.ErrOrStderr(), "Vault unlocked from AGENTIO_PASSPHRASE")
				daemon.KeepaliveFromEnv(context.Background(), reg, ids(reg))
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
		Use: "status", Short: "Check the daemon health endpoint",
		RunE: func(c *cobra.Command, _ []string) error {
			fmt.Fprintf(c.OutOrStdout(), "daemon http://127.0.0.1:%d/health\n", daemon.Port)
			return nil
		},
	}
	cmd.AddCommand(start, status)
	return cmd
}

func passFromEnv() (string, string) {
	v := strings.TrimSpace(os.Getenv("AGENTIO_PASSPHRASE"))
	if v == "" {
		return "", ""
	}
	return v, "env"
}

func loginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login <hub>",
		Short: "Log in to a vault hub and store the token",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			origin, err := profile.ValidateHubURL(args[0])
			if err != nil {
				return err
			}
			hostName, _ := os.Hostname()
			if hostName == "" {
				hostName = "agent"
			}
			raw, _, err := auth.HubCall(origin, "/v1/device", auth.Call{Method: http.MethodPost, Body: map[string]string{"name": hostName}})
			if err != nil {
				return err
			}
			var started daemon.DeviceStart
			if err := json.Unmarshal(raw, &started); err != nil {
				return err
			}
			fmt.Fprintf(c.ErrOrStderr(), "Approve code %s at %s/ui\n", started.UserCode, origin)
			for {
				body, _, err := auth.HubCall(origin, "/v1/device/token", auth.Call{Method: http.MethodPost, Body: map[string]string{"deviceCode": started.DeviceCode}})
				if err != nil {
					return err
				}
				var poll daemon.DevicePoll
				if err := json.Unmarshal(body, &poll); err != nil {
					return err
				}
				if poll.Status == "approved" {
					if _, err := auth.SaveRemoteToken(poll.Token); err != nil {
						return err
					}
					fmt.Fprintln(c.OutOrStdout(), "Logged in")
					return nil
				}
				if poll.Status == "denied" {
					return clierr.New(clierr.AuthFailed, "Login denied", "")
				}
				time.Sleep(time.Duration(started.Interval) * time.Second)
			}
		},
	}
}

func logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use: "logout", Short: "Forget the stored hub token",
		RunE: func(c *cobra.Command, _ []string) error {
			ok, err := auth.ClearRemoteToken()
			if err != nil {
				return err
			}
			if !ok {
				fmt.Fprintln(c.OutOrStdout(), "Not logged in")
				return nil
			}
			fmt.Fprintln(c.OutOrStdout(), "Logged out")
			return nil
		},
	}
}

func statusCmd(reg *plugins.Registry) *cobra.Command {
	var asJSON bool
	var noTest bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Check configured profiles",
		RunE: func(c *cobra.Command, _ []string) error {
			rows, err := host.Statuses(context.Background(), reg, ids(reg), !noTest)
			if err != nil {
				return err
			}
			if asJSON {
				raw, err := json.MarshalIndent(rows, "", "  ")
				if err != nil {
					return err
				}
				fmt.Fprintln(c.OutOrStdout(), string(raw))
				return nil
			}
			if len(rows) == 0 {
				fmt.Fprintln(c.OutOrStdout(), "No profiles configured.")
				return nil
			}
			for _, row := range rows {
				extra := ""
				if row.ReadOnly {
					extra += " [read-only]"
				}
				if row.Info != "" {
					extra += " " + row.Info
				}
				if row.Error != "" {
					extra += " " + row.Error
				}
				fmt.Fprintf(c.OutOrStdout(), "%s/%s%s %s\n", row.Service, row.Profile, extra, row.Status)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output structured JSON")
	cmd.Flags().BoolVar(&noTest, "no-test", false, "List profiles without calling validate")
	return cmd
}

func reauthCmd(reg *plugins.Registry) *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:    "reauth",
		Short:  "Re-authenticate expired or invalid profiles",
		Hidden: true,
		RunE: func(c *cobra.Command, _ []string) error {
			rows, err := host.Statuses(context.Background(), reg, ids(reg), true)
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

func docsCmd(reg *plugins.Registry) *cobra.Command {
	return &cobra.Command{
		Use:   "docs",
		Short: "Machine-readable command index",
		RunE: func(c *cobra.Command, _ []string) error {
			type row struct {
				Service string `json:"service"`
				Path    string `json:"path"`
				Summary string `json:"summary"`
				Access  string `json:"access,omitempty"`
				Example string `json:"example,omitempty"`
			}
			var rows []row
			for _, p := range reg.Plugins() {
				for _, spec := range p.Commands {
					ex := ""
					if len(spec.Examples) > 0 {
						ex = spec.Examples[0]
					}
					rows = append(rows, row{Service: p.ID, Path: spec.Path, Summary: spec.Description, Access: spec.Access, Example: ex})
				}
			}
			raw, _ := json.MarshalIndent(map[string]any{"version": Version, "commands": rows}, "", "  ")
			fmt.Fprintln(c.OutOrStdout(), string(raw))
			return nil
		},
	}
}

func skillCmd(reg *plugins.Registry) *cobra.Command {
	return &cobra.Command{
		Use:   "skill <service>",
		Short: "Print a SKILL.md for one service",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p := reg.Find(args[0])
			if p == nil {
				return clierr.New(clierr.NotFound, "no commands found for service \""+args[0]+"\"", "")
			}
			var b strings.Builder
			fmt.Fprintf(&b, "---\nname: agentio-%s\ndescription: %s\n---\n\n# %s via agentio\n\n", p.ID, p.Description, p.DisplayName)
			for _, spec := range p.Commands {
				fmt.Fprintf(&b, "## agentio %s %s\n\n%s\n\n", p.ID, spec.Path, spec.Description)
				if len(spec.Examples) > 0 {
					b.WriteString("```\n")
					for _, ex := range spec.Examples {
						b.WriteString(ex + "\n")
					}
					b.WriteString("```\n\n")
				}
			}
			fmt.Fprint(c.OutOrStdout(), b.String())
			return nil
		},
	}
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
