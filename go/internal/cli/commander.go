package cli

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Bun's CLI is a Commander program. commanderParse reads the command line the
// way Commander's _parseCommand does (node_modules/commander/lib/command.js),
// over the cobra tree, so a mistyped line fails with Commander's message, in
// Commander's order, before any command or hook runs. A line it accepts comes
// back as an argv cobra parses without judgement: the command words, each
// option as --name[=value], then "--" and the operands.

// parsed is what Commander does with a command line.
type parsed struct {
	argv    []string       // run: the argv for cobra
	err     string         // an "error: …" message; exit 1
	help    *cobra.Command // print this command's help
	helpErr bool           // Commander help({ error: true }): to stderr, exit 1
	version bool           // -V, --version: print the version, exit 0
}

// flagSpecs is the Commander flags string (Option.flags, used in its error
// messages) of a plugin option, kept on the pflag flag.
const flagSpecs = "agentio-commander-flags"

// hostPlaceholders are the value names Bun gives the host commands' options
// (`--profile <name>`, `--url <url>`, …).
var hostPlaceholders = map[string]string{
	"profile": "name", "to": "name", "name": "name", "url": "url", "path": "path",
	"file": "path", "key": "key", "passphrase": "value",
}

// negativeNumber is Commander's negativeNumberArg: an operand of a command
// with no subcommands, not an option.
var negativeNumber = regexp.MustCompile(`^-(\d+|\d*\.\d+)(e[+-]?\d+)?$`)

func commanderParse(root *cobra.Command, args []string) parsed {
	return parseLevel(root, nil, args)
}

// parseLevel is _parseCommand for cmd: operands come from its parent, and
// words (the parent's unknown words) are what its own option parse reads.
func parseLevel(cmd *cobra.Command, operands, words []string) parsed {
	lvl, stop := parseOptions(cmd, words)
	if stop != nil {
		return *stop
	}
	operands = append(append([]string(nil), operands...), lvl.operands...)
	unknown := lvl.unknown
	all := append(append([]string(nil), operands...), unknown...)

	if len(operands) > 0 {
		if sub := findCommand(cmd, operands[0]); sub != nil {
			return parseLevel(sub, operands[1:], unknown)
		}
		if hasHelpCommand(cmd) && operands[0] == "help" {
			return helpCommand(cmd, operands[1:])
		}
	}
	if def := defaultChild(cmd); def != nil {
		if helpRequested(unknown) {
			return parsed{help: cmd}
		}
		return parseLevel(def, operands, unknown)
	}
	if cmd.HasSubCommands() && len(all) == 0 && !cmd.Runnable() {
		return parsed{help: cmd, helpErr: true}
	}
	if helpRequested(unknown) {
		return parsed{help: cmd}
	}
	if msg := missingMandatory(cmd, lvl.given); msg != "" {
		return parsed{err: msg}
	}
	unknownOption := func() string {
		if len(unknown) > 0 {
			return unknownOptionError(cmd, unknown[0])
		}
		return ""
	}
	switch {
	case cmd.Runnable() || !cmd.HasSubCommands():
		if msg := unknownOption(); msg != "" {
			return parsed{err: msg}
		}
		if msg := checkArguments(cmd, all); msg != "" {
			return parsed{err: msg}
		}
	case len(operands) > 0:
		return parsed{err: unknownCommandError(cmd, all[0])}
	default:
		if msg := unknownOption(); msg != "" {
			return parsed{err: msg}
		}
		return parsed{help: cmd, helpErr: true}
	}
	argv := commandWords(cmd)
	argv = append(argv, lvl.options...)
	if len(all) > 0 {
		argv = append(append(argv, "--"), all...)
	}
	return parsed{argv: argv}
}

type levelOptions struct {
	operands, unknown []string
	options           []string // cobra words for the options this level took
	given             map[string]bool
}

// parseOptions is Commander's parseOptions for cmd's own options. A version
// flag or a value-less option stops the parse there, as in Commander.
func parseOptions(cmd *cobra.Command, args []string) (levelOptions, *parsed) {
	lvl := levelOptions{given: map[string]bool{}}
	toUnknown := false
	leaf := !cmd.HasSubCommands()
	take := func(f *pflag.Flag, value *string) *parsed {
		if f.Name == "version" && !cmd.HasParent() {
			return &parsed{version: true}
		}
		lvl.given[f.Name] = true
		if value == nil {
			lvl.options = append(lvl.options, "--"+f.Name)
		} else {
			lvl.options = append(lvl.options, "--"+f.Name+"="+*value)
		}
		return nil
	}
	push := func(arg string) {
		if toUnknown {
			lvl.unknown = append(lvl.unknown, arg)
		} else {
			lvl.operands = append(lvl.operands, arg)
		}
	}
	var group string // the rest of a -abc group
	for i := 0; i < len(args) || group != ""; {
		arg := group
		if arg == "" {
			arg = args[i]
			i++
		}
		group = ""
		if arg == "--" {
			if toUnknown {
				lvl.unknown = append(lvl.unknown, arg)
			}
			for _, rest := range args[i:] {
				push(rest)
			}
			break
		}
		if maybeOption(arg) {
			if f := findOption(cmd, arg); f != nil {
				switch optionKind(f) {
				case "required":
					if i >= len(args) {
						return lvl, &parsed{err: "error: option '" + flagSpec(f) + "' argument missing"}
					}
					value := args[i]
					i++
					if stop := take(f, &value); stop != nil {
						return lvl, stop
					}
				case "optional":
					if i < len(args) && (!maybeOption(args[i]) || negativeNumber.MatchString(args[i])) {
						value := args[i]
						i++
						if stop := take(f, &value); stop != nil {
							return lvl, stop
						}
					} else if stop := take(f, nil); stop != nil {
						return lvl, stop
					}
				default:
					if stop := take(f, nil); stop != nil {
						return lvl, stop
					}
				}
				continue
			}
		}
		// A -abc group: the first letter, if known, then the rest.
		if len(arg) > 2 && arg[0] == '-' && arg[1] != '-' {
			if f := findOption(cmd, arg[:2]); f != nil {
				if optionKind(f) != "bool" {
					value := arg[2:]
					if stop := take(f, &value); stop != nil {
						return lvl, stop
					}
				} else {
					if stop := take(f, nil); stop != nil {
						return lvl, stop
					}
					group = "-" + arg[2:]
				}
				continue
			}
		}
		// --name=value for an option that takes a value.
		if strings.HasPrefix(arg, "--") && strings.Index(arg, "=") > 2 {
			eq := strings.Index(arg, "=")
			if f := findOption(cmd, arg[:eq]); f != nil && optionKind(f) != "bool" {
				value := arg[eq+1:]
				if stop := take(f, &value); stop != nil {
					return lvl, stop
				}
				continue
			}
		}
		if !toUnknown && maybeOption(arg) && !(leaf && negativeNumber.MatchString(arg)) {
			toUnknown = true
		}
		push(arg)
	}
	return lvl, nil
}

func maybeOption(arg string) bool { return len(arg) > 1 && arg[0] == '-' }

// findOption is Commander's _findOption: the exact long or short flag.
func findOption(cmd *cobra.Command, arg string) *pflag.Flag {
	var found *pflag.Flag
	cmd.LocalFlags().VisitAll(func(f *pflag.Flag) {
		if found != nil || f.Name == "help" {
			return
		}
		if arg == "--"+f.Name || (f.Shorthand != "" && arg == "-"+f.Shorthand) {
			found = f
		}
	})
	return found
}

// optionKind is Commander's option.required (<value>), option.optional
// ([value]) or a boolean.
func optionKind(f *pflag.Flag) string {
	switch {
	case f.Value.Type() == "bool":
		return "bool"
	case f.NoOptDefVal == optionalBare:
		return "optional"
	default:
		return "required"
	}
}

// flagSpec is the option's Commander flags string.
func flagSpec(f *pflag.Flag) string {
	if spec := f.Annotations[flagSpecs]; len(spec) > 0 {
		return spec[0]
	}
	long := "--" + f.Name
	if f.Shorthand != "" {
		long = "-" + f.Shorthand + ", " + long
	}
	switch optionKind(f) {
	case "bool":
		return long
	case "optional":
		return long + " [value]"
	}
	if name := hostPlaceholders[f.Name]; name != "" {
		return long + " <" + name + ">"
	}
	return long + " <value>"
}

func findCommand(cmd *cobra.Command, name string) *cobra.Command {
	for _, c := range cmd.Commands() {
		if c.Name() == name || c.HasAlias(name) {
			return c
		}
	}
	return nil
}

// hasHelpCommand is Commander's implicit `help [command]`: on a command with
// subcommands and no action of its own.
func hasHelpCommand(cmd *cobra.Command) bool {
	return cmd.HasSubCommands() && !cmd.Runnable() && findCommand(cmd, "help") == nil
}

// helpCommand is _dispatchHelpCommand: `help` shows cmd, `help <sub>` shows
// the subcommand, and an unknown name is help({ error: true }) for cmd.
func helpCommand(cmd *cobra.Command, rest []string) parsed {
	if len(rest) == 0 {
		return parsed{help: cmd}
	}
	if sub := findCommand(cmd, rest[0]); sub != nil {
		return parsed{help: sub}
	}
	return parsed{help: cmd, helpErr: true}
}

func defaultChild(cmd *cobra.Command) *cobra.Command {
	if name := cmd.Annotations[defaultCommand]; name != "" {
		return findCommand(cmd, name)
	}
	return nil
}

func helpRequested(unknown []string) bool {
	for _, a := range unknown {
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}

// missingMandatory is _checkForMissingMandatoryOptions for the command (its
// ancestors have no mandatory option).
func missingMandatory(cmd *cobra.Command, given map[string]bool) string {
	msg := ""
	cmd.LocalFlags().VisitAll(func(f *pflag.Flag) {
		if msg != "" || given[f.Name] {
			return
		}
		if req := f.Annotations[cobra.BashCompOneRequiredFlag]; len(req) > 0 && req[0] == "true" {
			msg = "error: required option '" + flagSpec(f) + "' not specified"
		}
	})
	return msg
}

// unknownOptionError is Commander's unknownOption, with its suggestion from the
// visible long options of the command and its ancestors.
func unknownOptionError(cmd *cobra.Command, flag string) string {
	suggestion := ""
	if strings.HasPrefix(flag, "--") {
		var candidates []string
		for c := cmd; c != nil; c = c.Parent() {
			c.LocalFlags().VisitAll(func(f *pflag.Flag) {
				if !f.Hidden && f.Name != "help" {
					candidates = append(candidates, "--"+f.Name)
				}
			})
			candidates = append(candidates, "--help")
		}
		suggestion = suggestSimilar(flag, candidates)
	}
	return "error: unknown option '" + flag + "'" + suggestion
}

// unknownCommandError is Commander's unknownCommand, with its suggestion from
// the visible subcommands, their first alias and the implicit help command.
func unknownCommandError(cmd *cobra.Command, name string) string {
	var candidates []string
	for _, c := range cmd.Commands() {
		if c.Hidden {
			continue
		}
		candidates = append(candidates, c.Name())
		if len(c.Aliases) > 0 {
			candidates = append(candidates, c.Aliases[0])
		}
	}
	if hasHelpCommand(cmd) {
		candidates = append(candidates, "help")
	}
	return "error: unknown command '" + name + "'" + suggestSimilar(name, candidates)
}

type argumentSpec struct {
	name               string
	required, variadic bool
}

// arguments are the command's declared arguments, read from its Use line
// (`get <message-id>`, `reauth <service> [name]`, `send [to...]`).
func arguments(cmd *cobra.Command) []argumentSpec {
	var out []argumentSpec
	for _, word := range strings.Fields(cmd.Use)[1:] {
		if len(word) < 3 || !(word[0] == '<' || word[0] == '[') {
			continue
		}
		name := word[1 : len(word)-1]
		variadic := strings.HasSuffix(name, "...")
		out = append(out, argumentSpec{name: strings.TrimSuffix(name, "..."), required: word[0] == '<', variadic: variadic})
	}
	return out
}

// checkArguments is _checkNumberOfArguments.
func checkArguments(cmd *cobra.Command, args []string) string {
	declared := arguments(cmd)
	for i, arg := range declared {
		if arg.required && i >= len(args) {
			return "error: missing required argument '" + arg.name + "'"
		}
	}
	if len(declared) > 0 && declared[len(declared)-1].variadic {
		return ""
	}
	if len(args) > len(declared) {
		s := "s"
		if len(declared) == 1 {
			s = ""
		}
		forSub := ""
		if cmd.HasParent() {
			forSub = " for '" + cmd.Name() + "'"
		}
		return "error: too many arguments" + forSub + ". Expected " + strconv.Itoa(len(declared)) + " argument" + s + " but got " + strconv.Itoa(len(args)) + "."
	}
	return ""
}

// commandWords are the words that name cmd under the root.
func commandWords(cmd *cobra.Command) []string {
	var words []string
	for c := cmd; c.HasParent(); c = c.Parent() {
		words = append([]string{c.Name()}, words...)
	}
	return words
}

// suggestSimilar is Commander's suggestSimilar (lib/suggestSimilar.js).
func suggestSimilar(word string, candidates []string) string {
	if len(candidates) == 0 {
		return ""
	}
	seen := map[string]bool{}
	var unique []string
	for _, c := range candidates {
		if !seen[c] {
			seen[c] = true
			unique = append(unique, c)
		}
	}
	options := strings.HasPrefix(word, "--")
	if options {
		word = word[2:]
		for i, c := range unique {
			unique[i] = c[2:]
		}
	}
	const maxDistance = 3
	var similar []string
	best := maxDistance
	w := utf16.Encode([]rune(word)) // JavaScript compares UTF-16 code units
	for _, c := range unique {
		cr := utf16.Encode([]rune(c))
		if len(cr) <= 1 {
			continue
		}
		distance := editDistance(w, cr, maxDistance)
		length := max(len(w), len(cr))
		if float64(length-distance)/float64(length) > 0.4 {
			if distance < best {
				best = distance
				similar = []string{c}
			} else if distance == best {
				similar = append(similar, c)
			}
		}
	}
	sort.SliceStable(similar, func(i, j int) bool { return jsvalue.LocaleCompare(similar[i], similar[j]) < 0 })
	if options {
		for i, c := range similar {
			similar[i] = "--" + c
		}
	}
	switch len(similar) {
	case 0:
		return ""
	case 1:
		return "\n(Did you mean " + similar[0] + "?)"
	}
	return "\n(Did you mean one of " + strings.Join(similar, ", ") + "?)"
}

// editDistance is the optimal string alignment distance, with Commander's
// early exit when the lengths differ by more than maxDistance.
func editDistance(a, b []uint16, maxDistance int) int {
	if abs(len(a)-len(b)) > maxDistance {
		return max(len(a), len(b))
	}
	d := make([][]int, len(a)+1)
	for i := range d {
		d[i] = make([]int, len(b)+1)
		d[i][0] = i
	}
	for j := 0; j <= len(b); j++ {
		d[0][j] = j
	}
	for j := 1; j <= len(b); j++ {
		for i := 1; i <= len(a); i++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(a)][len(b)]
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
