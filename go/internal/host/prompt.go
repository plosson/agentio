package host

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/lines"
	"github.com/plosson/agentio/go/internal/plugins"
	"golang.org/x/term"
)

// Prompter asks a person questions over Streams, for every prompt Bun has:
//
//   - Ask and Confirm are Bun's utils/stdin prompt and confirm: a line read
//     from stdin, terminal or pipe alike.
//   - Input, Password and YesNo are the @inquirer prompts Bun only shows on a
//     terminal (its callers check first).
//   - Select and Checkbox are utils/interactive's interactiveSelect and
//     interactiveCheckbox, with their rules off a terminal: the default (or
//     the checked choices) without reading stdin, or a refusal.
//
// On a terminal they ask the same questions, with the same choices, defaults,
// validation and results as inquirer, drawn as plain lines: a menu is a
// numbered list and a secret is read without echo.
type Prompter struct {
	s  Streams
	rd *lines.Reader
}

// NewPrompter reads s.In through the process-wide line reader for it, so
// answers piped for several questions all arrive.
func NewPrompter(s Streams) *Prompter {
	return &Prompter{s: s, rd: lines.For(s.in())}
}

// Interactive is Bun's isInteractive(): process.stdin.isTTY.
func (p *Prompter) Interactive() bool { return IsTerminal(p.s.in()) }

// errClosed is inquirer's ExitPromptError: the terminal went away mid-prompt.
var errClosed = errors.New("User force closed the prompt with SIGINT")

func refuseOffTerminal() error {
	return clierr.New(clierr.InvalidParams,
		"Interactive input required but not running in terminal",
		"Run this command in an interactive terminal")
}

// Ask writes question (with a trailing space) to stderr and reads the answer.
// A secret on a real terminal is read without echo.
func (p *Prompter) Ask(question string, secret bool) (string, error) {
	if !strings.HasSuffix(question, " ") {
		question += " "
	}
	fmt.Fprint(p.s.err(), question)
	if f, ok := p.s.in().(*os.File); secret && ok && term.IsTerminal(int(f.Fd())) && !p.rd.Waiting() {
		b, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(p.s.err())
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	line, err := p.rd.ReadLine(context.Background())
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// Confirm is Bun's utils/stdin confirm: `question (y/n): `, true for y or
// yes. End of input is an empty answer, so no.
func (p *Prompter) Confirm(question string) (bool, error) {
	answer, err := p.Ask(question+" (y/n): ", false)
	if err != nil && err != io.EOF {
		return false, err
	}
	switch strings.ToLower(jsvalue.Trim(answer)) {
	case "y", "yes":
		return true, nil
	default:
		return false, nil
	}
}

// ask is one inquirer question on a terminal: end of input is the prompt
// being closed, which inquirer reports as ExitPromptError.
func (p *Prompter) ask(question string, secret bool) (string, error) {
	answer, err := p.Ask(question, secret)
	if err == io.EOF {
		return "", errClosed
	}
	return answer, err
}

// Input is inquirer input: Enter takes def, and while validate returns a
// message the question is asked again.
func (p *Prompter) Input(message, def string, validate func(string) string) (string, error) {
	question := "? " + message
	if def != "" {
		question += " (" + def + ")"
	}
	for {
		answer, err := p.ask(question, false)
		if err != nil {
			return "", err
		}
		if answer == "" {
			answer = def
		}
		if msg := check(validate, answer); msg != "" {
			fmt.Fprintln(p.s.err(), "> "+msg)
			continue
		}
		return answer, nil
	}
}

// Password is inquirer password: asked again while validate returns a message.
func (p *Prompter) Password(message string, validate func(string) string) (string, error) {
	for {
		answer, err := p.ask("? "+message, true)
		if err != nil {
			return "", err
		}
		if msg := check(validate, answer); msg != "" {
			fmt.Fprintln(p.s.err(), "> "+msg)
			continue
		}
		return answer, nil
	}
}

func check(validate func(string) string, answer string) string {
	if validate == nil {
		return ""
	}
	return validate(answer)
}

var (
	yes = regexp.MustCompile(`(?i)^(y|yes)`)
	no  = regexp.MustCompile(`(?i)^(n|no)`)
)

// YesNo is inquirer confirm: an answer starting y/yes or n/no, any other
// answer (Enter included) is def.
func (p *Prompter) YesNo(message string, def bool) (bool, error) {
	hint := "(Y/n)"
	if !def {
		hint = "(y/N)"
	}
	answer, err := p.ask("? "+message+" "+hint, false)
	if err != nil {
		return false, err
	}
	switch {
	case yes.MatchString(answer):
		return true, nil
	case no.MatchString(answer):
		return false, nil
	}
	return def, nil
}

// Select is interactiveSelect. def is the default choice's index, or -1 for
// none. Off a terminal it returns def or refuses, and reads nothing. On one,
// Enter takes def (inquirer's cursor starts there, or on the first choice),
// a number or the start of a name picks, and anything else asks again.
func (p *Prompter) Select(message string, choices []plugins.Choice, def int) (int, error) {
	if !p.Interactive() {
		if def >= 0 {
			return def, nil
		}
		return 0, refuseOffTerminal()
	}
	if def < 0 {
		def = 0
	}
	p.list(message, choices, nil)
	for {
		answer, err := p.ask(fmt.Sprintf("Choice (1-%d) [%d]:", len(choices), def+1), false)
		if err != nil {
			return 0, err
		}
		answer = strings.TrimSpace(answer)
		if answer == "" {
			return def, nil
		}
		if i := pick(answer, choices); i >= 0 {
			return i, nil
		}
		fmt.Fprintf(p.s.err(), "> Enter a number from 1 to %d\n", len(choices))
	}
}

// Checkbox is interactiveCheckbox. Off a terminal it returns the checked
// choices, or refuses when required and none is checked, and reads nothing.
// On one, numbers toggle choices, "a" checks all (or clears all when all
// are checked, as inquirer's <a>), "i" inverts, and Enter submits; a
// required pick that is empty is then Bun's INVALID_PARAMS.
func (p *Prompter) Checkbox(message string, choices []plugins.Choice, required bool) ([]int, error) {
	checked := make([]bool, len(choices))
	for i, c := range choices {
		checked[i] = c.Checked
	}
	if !p.Interactive() {
		out := picked(checked)
		if len(out) > 0 || !required {
			return out, nil
		}
		return nil, refuseOffTerminal()
	}
	for {
		p.list(message, choices, checked)
		answer, err := p.ask(`Toggle by number ("1 3"), "a" all, "i" invert, Enter to submit:`, false)
		if err != nil {
			return nil, err
		}
		fields := strings.FieldsFunc(answer, func(r rune) bool { return r == ' ' || r == ',' || r == '\t' })
		if len(fields) == 0 {
			break
		}
		next := append([]bool(nil), checked...)
		ok := true
		for _, f := range fields {
			switch strings.ToLower(f) {
			case "a":
				all := len(picked(next)) == len(next)
				for i := range next {
					next[i] = !all
				}
			case "i":
				for i := range next {
					next[i] = !next[i]
				}
			default:
				n, err := strconv.Atoi(f)
				if err != nil || n < 1 || n > len(choices) {
					ok = false
				} else {
					next[n-1] = !next[n-1]
				}
			}
		}
		if !ok {
			fmt.Fprintf(p.s.err(), "> Enter numbers from 1 to %d, \"a\" or \"i\"\n", len(choices))
			continue
		}
		checked = next
	}
	out := picked(checked)
	if required && len(out) == 0 {
		return nil, clierr.New(clierr.InvalidParams, "At least one option must be selected", "")
	}
	return out, nil
}

// list draws a menu: numbered choices, with check marks for a checkbox.
func (p *Prompter) list(message string, choices []plugins.Choice, checked []bool) {
	var b strings.Builder
	b.WriteString("? " + message + "\n")
	for i, c := range choices {
		mark := ""
		if checked != nil {
			mark = "[ ] "
			if checked[i] {
				mark = "[x] "
			}
		}
		fmt.Fprintf(&b, "  %d) %s%s", i+1, mark, c.Name)
		if c.Description != "" {
			b.WriteString(" - " + c.Description)
		}
		b.WriteString("\n")
	}
	fmt.Fprint(p.s.err(), b.String())
}

// pick is the choice an answer names: its number, or the first name it
// begins, in any case (inquirer select's type-ahead).
func pick(answer string, choices []plugins.Choice) int {
	if n, err := strconv.Atoi(answer); err == nil {
		if n >= 1 && n <= len(choices) {
			return n - 1
		}
		return -1
	}
	for i, c := range choices {
		if strings.HasPrefix(strings.ToLower(c.Name), strings.ToLower(answer)) {
			return i
		}
	}
	return -1
}

func picked(checked []bool) []int {
	out := []int{}
	for i, on := range checked {
		if on {
			out = append(out, i)
		}
	}
	return out
}
