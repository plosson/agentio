package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// `docs` and `skill` render the command tree as Bun's collectCommands
// (src/utils/command-tree.ts) sees the Commander program: visible commands in
// registration order, each option by its Commander flags string, description
// and default, and the examples block addExamples attached.

// optionDefault is a flag annotation: Commander's option.defaultValue as the
// docs print it (`${value}`). Absent when Bun declares none or declares ”,
// which the docs leave out; an empty array default prints as empty.
const optionDefault = "agentio-default"

// hostOutput marks the --json the host adds to every service command. It is a
// Go extra, so the reference Bun's tree generates does not list it.
const hostOutput = "agentio-host-output"

// argsUndescribed marks a command whose arguments have no description:
// Commander's visibleArguments then shows none of them.
const argsUndescribed = "agentio-args-undescribed"

type commandOption struct {
	Flags        string
	Description  string
	DefaultValue *string
}

type commandInfo struct {
	FullPath    string
	Description string
	Arguments   []string
	Options     []commandOption
	Examples    string
}

// collectCommands is Bun's collectCommands over the cobra tree.
func collectCommands(cmd *cobra.Command, parentPath string) []commandInfo {
	var results []commandInfo
	for _, sub := range visibleCommands(cmd) {
		fullPath := sub.Name()
		if parentPath != "" {
			fullPath = parentPath + " " + sub.Name()
		}
		var args []string
		if sub.Annotations[argsUndescribed] == "" {
			for _, arg := range arguments(sub) {
				name := arg.name
				if arg.variadic {
					name += "..."
				}
				if arg.required {
					args = append(args, "<"+name+">")
				} else {
					args = append(args, "["+name+"]")
				}
			}
		}
		options := visibleOptions(sub)
		if len(visibleCommands(sub)) == 0 || len(options) > 0 || len(args) > 0 {
			info := commandInfo{FullPath: fullPath, Description: sub.Short, Arguments: args, Options: options}
			if sub.Example != "" {
				info.Examples = "Examples:\n\n" + sub.Example
			}
			results = append(results, info)
		}
		results = append(results, collectCommands(sub, fullPath)...)
	}
	return results
}

func visibleCommands(cmd *cobra.Command) []*cobra.Command {
	var out []*cobra.Command
	for _, c := range cmd.Commands() {
		if !c.Hidden && c.Name() != "help" {
			out = append(out, c)
		}
	}
	return out
}

// visibleOptions are the command's own options in declaration order, without
// hidden ones and, as in Bun, without any whose long name contains "help".
func visibleOptions(cmd *cobra.Command) []commandOption {
	flags := cmd.Flags()
	sorted := flags.SortFlags
	flags.SortFlags = false
	defer func() { flags.SortFlags = sorted }()
	var out []commandOption
	flags.VisitAll(func(f *pflag.Flag) {
		if f.Hidden || strings.Contains(f.Name, "help") || len(f.Annotations[hostOutput]) > 0 {
			return
		}
		opt := commandOption{Flags: flagSpec(f), Description: f.Usage}
		if def := f.Annotations[optionDefault]; len(def) > 0 {
			opt.DefaultValue = &def[0]
		}
		out = append(out, opt)
	})
	return out
}

// setDefault records the default Bun declares for a host command's option.
func setDefault(flags *pflag.FlagSet, name, value string) {
	_ = flags.SetAnnotation(name, optionDefault, []string{value})
}

// examplesBlock is the text after "Examples:" in Bun's addExamples block:
// each example line indented, a blank line before each comment that opens a
// new example, then the notes as they are.
func examplesBlock(examples, notes []string) string {
	var b strings.Builder
	for i, line := range examples {
		if i > 0 {
			b.WriteString("\n")
			if strings.HasPrefix(line, "#") {
				b.WriteString("\n")
			}
		}
		b.WriteString("  " + line)
	}
	for _, line := range notes {
		b.WriteString("\n" + line)
	}
	return b.String()
}

// withoutProfileCommands drops every `… profile …` command, as both docs and
// skill do.
func withoutProfileCommands(all []commandInfo) []commandInfo {
	var out []commandInfo
	for _, c := range all {
		if !strings.Contains(c.FullPath, " profile ") {
			out = append(out, c)
		}
	}
	return out
}

func serviceOf(c commandInfo) string {
	parts := strings.Split(c.FullPath, " ")
	if len(parts) > 1 {
		return parts[1]
	}
	return ""
}

// docsExcluded are the commands `docs` leaves out unless --service names them.
var docsExcluded = map[string]bool{"config": true, "status": true, "update": true, "claude": true, "docs": true}

func docsCommands(root *cobra.Command, services []string) []commandInfo {
	var out []commandInfo
	for _, c := range withoutProfileCommands(collectCommands(root, "agentio")) {
		service := serviceOf(c)
		if len(services) > 0 {
			for _, s := range services {
				if s == service {
					out = append(out, c)
					break
				}
			}
		} else if !docsExcluded[service] {
			out = append(out, c)
		}
	}
	return out
}

// optionLine is Bun's formatOption: flags, `: description`, ` (default: x)`.
func optionLine(opt commandOption) string {
	line := opt.Flags
	if opt.Description != "" {
		line += ": " + opt.Description
	}
	if opt.DefaultValue != nil {
		line += " (default: " + *opt.DefaultValue + ")"
	}
	return line
}

func header(c commandInfo) string {
	h := "## " + c.FullPath
	if len(c.Arguments) > 0 {
		h += " " + strings.Join(c.Arguments, " ")
	}
	return h
}

func docsMarkdown(commands []commandInfo) string {
	lines := []string{"# agentio CLI v" + Version, ""}
	for _, c := range commands {
		lines = append(lines, header(c))
		if c.Description != "" {
			lines = append(lines, c.Description)
		}
		for _, opt := range c.Options {
			lines = append(lines, optionLine(opt))
		}
		lines = append(lines, "")
	}
	return strings.TrimRightFunc(strings.Join(lines, "\n"), jsvalue.IsSpace)
}

// docsJSON is the same reference as structured data.
func docsJSON(commands []commandInfo) string {
	list := []any{}
	for _, c := range commands {
		options := []any{}
		for _, opt := range c.Options {
			o := jsvalue.NewObject()
			o.Set("flags", opt.Flags)
			o.Set("description", opt.Description)
			if opt.DefaultValue != nil {
				o.Set("defaultValue", *opt.DefaultValue)
			}
			options = append(options, o)
		}
		args := []any{}
		for _, a := range c.Arguments {
			args = append(args, a)
		}
		entry := jsvalue.NewObject()
		entry.Set("command", c.FullPath)
		entry.Set("description", c.Description)
		entry.Set("arguments", args)
		entry.Set("options", options)
		list = append(list, entry)
	}
	out := jsvalue.NewObject()
	out.Set("version", Version)
	out.Set("commands", list)
	return string(jsvalue.StringifyIndent(out))
}

func docsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:    "docs",
		Short:  "Output CLI reference for LLMs",
		Hidden: true,
		RunE: func(c *cobra.Command, _ []string) error {
			var services []string
			if f := c.Flags().Lookup("service"); f.Changed {
				for _, s := range strings.Split(f.Value.String(), ",") {
					services = append(services, jsvalue.Trim(s))
				}
			}
			commands := docsCommands(c.Root(), services)
			format, _ := c.Flags().GetString("format")
			switch format {
			case "markdown":
				fmt.Fprintln(c.OutOrStdout(), docsMarkdown(commands))
			case "json":
				fmt.Fprintln(c.OutOrStdout(), docsJSON(commands))
			default:
				return clierr.New(clierr.InvalidParams, "Unknown format: "+format, "Use --format markdown or --format json")
			}
			return nil
		},
	}
	cmd.Flags().String("service", "", "Filter by service (comma-separated)")
	cmd.Flags().String("format", "markdown", "Output format: markdown or json")
	setDefault(cmd.Flags(), "format", "markdown")
	return cmd
}

// serviceDescriptions describe the skill of a command group that is not a
// service plugin.
var serviceDescriptions = map[string]string{
	"daemon": "Use to manage the agentio daemon (HTTP API server for health and future vault UI/API).",
	"key":    "Use to manage the API keys that let remote agents read credentials from this vault hub - create, list, update, rotate, revoke.",
}

// skillOption is Bun's skill formatOption: a Markdown bullet.
func skillOption(opt commandOption) string {
	return "- `" + opt.Flags + "`" + strings.TrimPrefix(optionLine(opt), opt.Flags)
}

func renderSkillCommand(c commandInfo) string {
	lines := []string{header(c), ""}
	if c.Description != "" {
		lines = append(lines, c.Description, "")
	}
	if len(c.Options) > 0 {
		lines = append(lines, "Options:", "")
		for _, opt := range c.Options {
			lines = append(lines, skillOption(opt))
		}
		lines = append(lines, "")
	}
	if c.Examples != "" {
		lines = append(lines, "```", jsvalue.Trim(c.Examples), "```", "")
	}
	return strings.Join(lines, "\n")
}

func generateSkill(root *cobra.Command, reg *plugins.Registry, service string) (string, error) {
	description := "Use when interacting with " + service + " via the agentio CLI."
	if p := reg.Find(service); p != nil {
		description = p.Description
	} else if d, ok := serviceDescriptions[service]; ok {
		description = d
	}
	var scoped []commandInfo
	for _, c := range withoutProfileCommands(collectCommands(root, "agentio")) {
		if serviceOf(c) == service {
			scoped = append(scoped, c)
		}
	}
	if len(scoped) == 0 {
		return "", clierr.New(clierr.NotFound, "no commands found for service \""+service+"\"", "")
	}
	title := service
	if title != "" {
		title = strings.ToUpper(title[:1]) + title[1:]
	}
	out := []string{"---", "name: agentio-" + service, "description: " + description, "---", "",
		"# " + title + " via agentio", "", "Auto-generated from `agentio skill " + service + "`. Do not edit by hand.", ""}
	for _, c := range scoped {
		out = append(out, renderSkillCommand(c))
	}
	return strings.TrimRightFunc(strings.Join(out, "\n"), jsvalue.IsSpace) + "\n", nil
}

// skillServices are the command groups with a visible command, sorted.
func skillServices(root *cobra.Command) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range withoutProfileCommands(collectCommands(root, "agentio")) {
		if s := serviceOf(c); s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

func skillCmd(reg *plugins.Registry) *cobra.Command {
	cmd := &cobra.Command{
		Use:    "skill [service]",
		Short:  "Emit auto-generated SKILL.md content for an agentio service",
		Hidden: true,
		RunE: func(c *cobra.Command, args []string) error {
			root := c.Root()
			if list, _ := c.Flags().GetBool("list"); list {
				for _, s := range skillServices(root) {
					fmt.Fprintln(c.OutOrStdout(), s)
				}
				return nil
			}
			if all, _ := c.Flags().GetBool("all"); all {
				for _, s := range skillServices(root) {
					content, err := generateSkill(root, reg, s)
					if err != nil {
						return err
					}
					file := filepath.Join("claude", "skills", "agentio-"+s, "SKILL.md")
					if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
						return err
					}
					if err := os.WriteFile(file, []byte(content), 0o666); err != nil {
						return err
					}
					fmt.Fprintf(c.ErrOrStderr(), "wrote %s\n", file)
				}
				return nil
			}
			if len(args) == 0 {
				return clierr.New(clierr.InvalidParams, "specify a service, --all, or --list", "")
			}
			content, err := generateSkill(root, reg, args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(c.OutOrStdout(), content)
			return nil
		},
	}
	cmd.Flags().Bool("all", false, "Write SKILL.md for every service in claude/skills/")
	cmd.Flags().Bool("list", false, "List services with registered commands")
	return cmd
}
