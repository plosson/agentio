package cli

import (
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// Help is Commander's (node_modules/commander/lib/help.js formatHelp and
// command.js outputHelp) over the cobra tree: the Usage line, the description,
// Arguments, Options and Commands (under their help groups), each item padded
// to one column and wrapped to the help width, then the text Bun appends after
// the help (addExamples, addHelpText('after')).

// argDescription is the annotation prefix, per argument name, of a command
// argument's description (Commander argument.description).
const argDescription = "agentio-arg:"

// afterHelp is the annotation holding the text Commander's
// addHelpText('after', text) writes after the help.
const afterHelp = "agentio-after-help"

// describeArgument sets the description of one of cmd's arguments.
func describeArgument(cmd *cobra.Command, name, description string) {
	if description == "" {
		return
	}
	if cmd.Annotations == nil {
		cmd.Annotations = map[string]string{}
	}
	cmd.Annotations[argDescription+name] = description
}

// helpWidth is Commander's getOutHelpWidth/getErrHelpWidth: the terminal's
// columns when w is one, else 80. Tests replace it.
var helpWidth = func(w io.Writer) int {
	if f, ok := w.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		if cols, _, err := term.GetSize(int(f.Fd())); err == nil {
			return cols
		}
	}
	return 80
}

// outputHelp writes cmd's help to w, as Commander's outputHelp does.
func outputHelp(w io.Writer, cmd *cobra.Command) {
	text := formatHelp(cmd, helpWidth(w))
	// addExamples appends its block to helpInformation.
	if cmd.Example != "" {
		text += "\nExamples:\n\n" + cmd.Example + "\n"
	}
	// addHelpText writes its text and a newline.
	if after := cmd.Annotations[afterHelp]; after != "" {
		text += after + "\n"
	}
	_, _ = io.WriteString(w, text)
}

type helpItem struct{ term, description string }

// formatHelp is Help.formatHelp.
func formatHelp(cmd *cobra.Command, width int) string {
	var args, options []helpItem
	for _, arg := range visibleArguments(cmd) {
		args = append(args, helpItem{arg.name, arg.description})
	}
	for _, opt := range helpOptions(cmd) {
		options = append(options, helpItem{opt.Flags, opt.helpDescription()})
	}
	options = append(options, helpItem{"-h, --help", "display help for command"})
	type group struct {
		title string
		items []helpItem
	}
	var groups []*group
	byTitle := map[string]*group{}
	groupOf := func(sub *cobra.Command) *group {
		title := "Commands:"
		if sub.GroupID != "" {
			for _, g := range cmd.Groups() {
				if g.ID == sub.GroupID {
					title = g.Title
				}
			}
		}
		if byTitle[title] == nil {
			byTitle[title] = &group{title: title}
			groups = append(groups, byTitle[title])
		}
		return byTitle[title]
	}
	// Groups come in the order of all subcommands, hidden ones included.
	for _, sub := range cmd.Commands() {
		groupOf(sub)
	}
	for _, sub := range visibleCommands(cmd) {
		g := groupOf(sub)
		g.items = append(g.items, helpItem{subcommandTerm(sub), sub.Short})
	}
	if hasHelpCommand(cmd) {
		g := byTitle["Commands:"]
		if g == nil {
			g = &group{title: "Commands:"}
			groups = append(groups, g)
		}
		g.items = append(g.items, helpItem{"help [command]", "display help for command"})
	}

	termWidth := 0
	for _, list := range [][]helpItem{args, options} {
		for _, item := range list {
			termWidth = max(termWidth, displayWidth(item.term))
		}
	}
	for _, g := range groups {
		for _, item := range g.items {
			termWidth = max(termWidth, displayWidth(item.term))
		}
	}

	out := []string{"Usage: " + commandUsage(cmd), ""}
	if cmd.Short != "" {
		out = append(out, boxWrap(cmd.Short, width), "")
	}
	list := func(heading string, items []helpItem) {
		if len(items) == 0 {
			return
		}
		out = append(out, heading)
		for _, item := range items {
			out = append(out, formatItem(item, termWidth, width))
		}
		out = append(out, "")
	}
	list("Arguments:", args)
	list("Options:", options)
	for _, g := range groups {
		list(g.title, g.items)
	}
	return strings.Join(out, "\n")
}

// commandUsage is Help.commandUsage with Command.usage().
func commandUsage(cmd *cobra.Command) string {
	name := cmd.Name()
	if len(cmd.Aliases) > 0 {
		name += "|" + cmd.Aliases[0]
	}
	for c := cmd.Parent(); c != nil; c = c.Parent() {
		name = c.Name() + " " + name
	}
	usage := []string{"[options]"}
	if len(cmd.Commands()) > 0 {
		usage = append(usage, "[command]")
	}
	for _, arg := range arguments(cmd) {
		usage = append(usage, arg.term())
	}
	return name + " " + strings.Join(usage, " ")
}

// subcommandTerm is Help.subcommandTerm: name|alias [options] <args>.
func subcommandTerm(cmd *cobra.Command) string {
	term := cmd.Name()
	if len(cmd.Aliases) > 0 {
		term += "|" + cmd.Aliases[0]
	}
	if hasOptions(cmd) {
		term += " [options]"
	}
	for _, arg := range arguments(cmd) {
		term += " " + arg.term()
	}
	return term
}

// preformatted is Help.preformatted: a line break followed by whitespace.
var preformatted = regexp.MustCompile(`\n[^\S\r\n]`)

// formatItem is Help.formatItem: the term padded to termWidth, then the
// description wrapped to what is left of the width and indented under itself.
func formatItem(item helpItem, termWidth, width int) string {
	if item.description == "" {
		return "  " + item.term
	}
	description := item.description
	remaining := width - termWidth - 4
	if remaining >= minWidthToWrap && !preformatted.MatchString(description) {
		description = strings.ReplaceAll(boxWrap(description, remaining), "\n", "\n"+strings.Repeat(" ", termWidth+2))
	}
	padded := jsvalue.PadEnd(item.term, termWidth+jsvalue.Length(item.term)-displayWidth(item.term))
	return "  " + padded + "  " + strings.ReplaceAll(description, "\n", "\n  ")
}

// sgr is Commander's stripColor pattern.
var sgr = regexp.MustCompile(`\x1b\[\d*(;\d*)*m`)

// displayWidth is Help.displayWidth: the length without SGR escapes.
func displayWidth(s string) int {
	return jsvalue.Length(sgr.ReplaceAllString(s, ""))
}

const minWidthToWrap = 40

// boxWrap is Help.boxWrap: each line cut at whitespace to fit width, the
// space at a break dropped.
func boxWrap(text string, width int) string {
	if width < minWidthToWrap {
		return text
	}
	var wrapped []string
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		chunks := whitespaceChunks(line)
		if len(chunks) == 0 {
			wrapped = append(wrapped, "")
			continue
		}
		current := chunks[0]
		for _, chunk := range chunks[1:] {
			if displayWidth(current)+displayWidth(chunk) <= width {
				current += chunk
				continue
			}
			wrapped = append(wrapped, current)
			current = strings.TrimLeftFunc(chunk, jsvalue.IsSpace)
		}
		wrapped = append(wrapped, current)
	}
	return strings.Join(wrapped, "\n")
}

// whitespaceChunks are the matches of /[\s]*[^\s]+/g: each word with the
// whitespace before it. Trailing whitespace belongs to no chunk.
func whitespaceChunks(line string) []string {
	var chunks []string
	start := 0
	inWord := false
	for i, r := range line {
		space := jsvalue.IsSpace(r)
		if inWord && space {
			chunks = append(chunks, line[start:i])
			start = i
		}
		inWord = !space
	}
	if inWord {
		chunks = append(chunks, line[start:])
	}
	return chunks
}
