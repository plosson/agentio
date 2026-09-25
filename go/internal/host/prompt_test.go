package host

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/testbox"
)

// tty is a fake terminal: answers typed at a keyboard, one line each.
func tty(answers string) io.Reader { return testbox.Terminal(strings.NewReader(answers)) }

func prompter(in io.Reader) (*Prompter, *bytes.Buffer) {
	var errOut bytes.Buffer
	return NewPrompter(Streams{In: in, Out: io.Discard, Err: &errOut}), &errOut
}

// piped hands answers over as a pipe does, in one write or in several.
func piped(t *testing.T, parts ...string) io.Reader {
	t.Helper()
	pr, pw := io.Pipe()
	go func() {
		testbox.Feed(pw, parts...)
		_ = pw.Close()
	}()
	return pr
}

var menu = []plugins.Choice{
	{Name: "Webhook", Description: "Simple incoming webhook URL"},
	{Name: "OAuth", Description: "Full API access"},
	{Name: "Other"},
}

func wantRefusal(t *testing.T, err error) {
	t.Helper()
	var ce *clierr.Error
	if !errors.As(err, &ce) || ce.Code != clierr.InvalidParams ||
		ce.Message != "Interactive input required but not running in terminal" ||
		ce.Suggestion != "Run this command in an interactive terminal" {
		t.Fatalf("want Bun's non-TTY refusal, got %v", err)
	}
}

// Bun interactiveSelect off a TTY: the default, or a refusal. Piped answers
// are not read, so they stay for whoever reads stdin next.
func TestSelectOffATerminalRefusesOrTakesTheDefaultWithoutReadingStdin(t *testing.T) {
	in := piped(t, "2\nleft\n")
	p, errOut := prompter(in)
	if _, err := p.Select("Choose profile type:", menu, -1); err == nil {
		t.Fatal("a piped answer was taken off a terminal")
	} else {
		wantRefusal(t, err)
	}
	got, err := p.Select("Choose:", menu, 2)
	if err != nil || got != 2 {
		t.Fatalf("default: %d %v", got, err)
	}
	if errOut.Len() != 0 {
		t.Fatalf("a menu was shown off a terminal: %q", errOut.String())
	}
	if line, err := p.Ask("next?", false); err != nil || line != "2" {
		t.Fatalf("stdin was consumed by the menu: %q %v", line, err)
	}
}

// On a terminal: Enter takes the default (or the first choice), a number or
// the start of a name picks, and anything else asks again, as inquirer never
// submits an invalid pick.
func TestSelectOnATerminal(t *testing.T) {
	cases := []struct {
		answers string
		def     int
		want    int
	}{
		{"\n", -1, 0},
		{"\n", 1, 1},
		{"3\n", -1, 2},
		{" 2 \n", 0, 1},
		{"oauth\n", -1, 1},
		{"OT\n", -1, 2},
		{"0\n9\n-1\nnope\n2\n", -1, 1},
	}
	for _, c := range cases {
		p, errOut := prompter(tty(c.answers))
		got, err := p.Select("Choose profile type:", menu, c.def)
		if err != nil || got != c.want {
			t.Fatalf("%q: got %d %v, want %d", c.answers, got, err, c.want)
		}
		for _, name := range []string{"Choose profile type:", "Webhook", "Simple incoming webhook URL", "OAuth", "Other"} {
			if !strings.Contains(errOut.String(), name) {
				t.Fatalf("menu does not show %q: %q", name, errOut.String())
			}
		}
	}
	// A closed terminal aborts, as inquirer does.
	p, _ := prompter(tty("7\n"))
	if _, err := p.Select("Choose:", menu, -1); err == nil || err.Error() != "User force closed the prompt with SIGINT" {
		t.Fatalf("closed terminal: %v", err)
	}
}

// Bun interactiveCheckbox off a TTY: the checked choices; none checked is a
// refusal when an answer is required and an empty pick otherwise.
func TestCheckboxOffATerminal(t *testing.T) {
	checked := []plugins.Choice{{Name: "a", Checked: true}, {Name: "b"}, {Name: "c", Checked: true}}
	p, errOut := prompter(piped(t, "2\n"))
	got, err := p.Checkbox("Pick:", checked, true)
	if err != nil || !reflect.DeepEqual(got, []int{0, 2}) {
		t.Fatalf("checked: %v %v", got, err)
	}
	if _, err := p.Checkbox("Pick:", menu, true); err == nil {
		t.Fatal("required pick with nothing checked accepted off a terminal")
	} else {
		wantRefusal(t, err)
	}
	got, err = p.Checkbox("Pick:", menu, false)
	if err != nil || len(got) != 0 {
		t.Fatalf("optional pick: %v %v", got, err)
	}
	if errOut.Len() != 0 {
		t.Fatalf("a menu was shown off a terminal: %q", errOut.String())
	}
	if line, _ := p.Ask("next?", false); line != "2" {
		t.Fatalf("stdin was consumed: %q", line)
	}
}

// On a terminal: numbers toggle, "a" checks all (or clears all when all are
// checked), "i" inverts, Enter submits; bad input asks again.
func TestCheckboxOnATerminal(t *testing.T) {
	cases := []struct {
		answers string
		choices []plugins.Choice
		want    []int
	}{
		{"\n", []plugins.Choice{{Name: "a", Checked: true}, {Name: "b"}}, []int{0}},
		{"2\n\n", menu, []int{1}},
		{"1 3\n3\n\n", menu, []int{0}},
		{"a\n\n", menu, []int{0, 1, 2}},
		{"a\na\n2\n\n", menu, []int{1}},
		{"1\ni\n\n", menu, []int{1, 2}},
		{"9\nzz\n2,3\n\n", menu, []int{1, 2}},
	}
	for _, c := range cases {
		p, errOut := prompter(tty(c.answers))
		got, err := p.Checkbox("Select profiles to export:", c.choices, false)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%q: got %v %v, want %v", c.answers, got, err, c.want)
		}
		if !strings.Contains(errOut.String(), "Select profiles to export:") {
			t.Fatalf("no message: %q", errOut.String())
		}
	}
	// Required and nothing picked: Bun's error after the prompt.
	p, _ := prompter(tty("\n"))
	_, err := p.Checkbox("Pick:", menu, true)
	var ce *clierr.Error
	if !errors.As(err, &ce) || ce.Code != clierr.InvalidParams || ce.Message != "At least one option must be selected" || ce.Suggestion != "" {
		t.Fatalf("empty required pick: %v", err)
	}
	p, _ = prompter(tty("1\n"))
	if _, err := p.Checkbox("Pick:", menu, false); err == nil || err.Error() != "User force closed the prompt with SIGINT" {
		t.Fatalf("closed terminal: %v", err)
	}
}

// inquirer password with validate: an invalid answer is asked again with the
// message, not refused.
func TestPasswordAsksAgainUntilValid(t *testing.T) {
	validate := func(v string) string {
		if len(v) < 8 {
			return "Passphrase must be at least 8 characters"
		}
		return ""
	}
	for name, in := range map[string]io.Reader{
		"terminal":       tty("short\n\nlong enough \n"),
		"delayed writes": testbox.Terminal(piped(t, "sho", "rt\n", "\nlong en", "ough \n")),
	} {
		p, errOut := prompter(in)
		got, err := p.Password("Create a passphrase (min 8 chars):", validate)
		if err != nil || got != "long enough " {
			t.Fatalf("%s: %q %v", name, got, err)
		}
		if strings.Count(errOut.String(), "Passphrase must be at least 8 characters") != 2 {
			t.Fatalf("%s: re-ask message: %q", name, errOut.String())
		}
	}
	p, _ := prompter(tty("short\n"))
	if _, err := p.Password("pw:", validate); err == nil || err.Error() != "User force closed the prompt with SIGINT" {
		t.Fatalf("closed terminal: %v", err)
	}
}

// inquirer input: Enter takes the default, validate asks again.
func TestInputDefaultAndValidation(t *testing.T) {
	abs := func(v string) string {
		if !strings.HasPrefix(v, "/") {
			return "Path must be absolute"
		}
		return ""
	}
	p, errOut := prompter(tty("relative\n/abs/path\n"))
	if got, err := p.Input("Vault file location:", "/default", abs); err != nil || got != "/abs/path" {
		t.Fatalf("%q %v", got, err)
	}
	if !strings.Contains(errOut.String(), "Path must be absolute") || !strings.Contains(errOut.String(), "/default") {
		t.Fatalf("prompt: %q", errOut.String())
	}
	p, _ = prompter(tty("\n"))
	if got, err := p.Input("Vault file location:", "/default", abs); err != nil || got != "/default" {
		t.Fatalf("default: %q %v", got, err)
	}
}

// inquirer confirm: y/yes and n/no prefixes, case-insensitive; anything else
// is the default.
func TestYesNo(t *testing.T) {
	cases := []struct {
		answer string
		def    bool
		want   bool
	}{
		{"\n", false, false}, {"\n", true, true},
		{"y\n", false, true}, {"YES\n", false, true}, {"yeah\n", false, true},
		{"n\n", true, false}, {"Nope\n", true, false},
		{"maybe\n", false, false}, {"maybe\n", true, true},
	}
	for _, c := range cases {
		p, _ := prompter(tty(c.answer))
		got, err := p.YesNo("Continue?", c.def)
		if err != nil || got != c.want {
			t.Fatalf("%q default %v: %v %v", c.answer, c.def, got, err)
		}
	}
	p, _ := prompter(tty(""))
	if _, err := p.YesNo("Continue?", false); err == nil || err.Error() != "User force closed the prompt with SIGINT" {
		t.Fatalf("closed terminal: %v", err)
	}
}

// The setup context offers the same select to plugins.
func TestSetupContextSelect(t *testing.T) {
	setup := NewSetupContext(Streams{In: tty("2\n"), Out: io.Discard, Err: io.Discard})
	if got, err := setup.Select("Choose:", menu); err != nil || got != 1 {
		t.Fatalf("%d %v", got, err)
	}
	setup = NewSetupContext(Streams{In: strings.NewReader("2\n"), Out: io.Discard, Err: io.Discard})
	_, err := setup.Select("Choose:", menu)
	wantRefusal(t, err)
}

// Confirm is Bun's utils/stdin confirm(): the answer is String#trim'd, which
// takes JavaScript white space (U+00A0, the BOM) but not U+0085.
func TestConfirmTrimsAsJavaScript(t *testing.T) {
	for answer, want := range map[string]bool{"\u00a0yes\u00a0\n": true, "\xef\xbb\xbfy\n": true, "\u0085y\n": false} {
		got, err := NewPrompter(Streams{In: strings.NewReader(answer), Err: io.Discard}).Confirm("Save?")
		if err != nil || got != want {
			t.Errorf("%q: got %v %v", answer, got, err)
		}
	}
}
