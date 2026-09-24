package plugins

import (
	"errors"
	"strings"
	"testing"
)

// A wrong type or a missing key must read as the zero value, never panic.
func TestInputAccessorsReturnZeroForMissingOrMistypedValues(t *testing.T) {
	in := CommandInput{
		Args:    map[string]any{"id": "42", "n": 7},
		Options: map[string]any{"limit": "10", "force": true, "to": []string{"a", "b"}, "json": true, "tag": "x"},
	}
	if in.Arg("id") != "42" || in.Arg("n") != "" || in.Arg("missing") != "" {
		t.Fatalf("Arg: %q %q %q", in.Arg("id"), in.Arg("n"), in.Arg("missing"))
	}
	if in.Option("limit") != "10" || in.Option("force") != "" || in.Option("to") != "" {
		t.Fatal("Option must only return strings")
	}
	if !in.Flag("force") || in.Flag("limit") || in.Flag("missing") {
		t.Fatal("Flag must only return true for a bool true")
	}
	if got := in.List("to"); len(got) != 2 || got[1] != "b" {
		t.Fatalf("List: %v", got)
	}
	if in.List("tag") != nil || in.List("missing") != nil {
		t.Fatal("List must be nil for a non-slice or missing value")
	}
	if v, ok := in.LookupOption("limit"); !ok || v != "10" {
		t.Fatal("LookupOption must report a given value")
	}
	in.Options["due"] = ""
	if v, ok := in.LookupOption("due"); !ok || v != "" {
		t.Fatal("LookupOption must report an explicit empty value as given")
	}
	in.Options["title"] = nil
	for _, name := range []string{"title", "force", "missing"} {
		if _, ok := in.LookupOption(name); ok {
			t.Fatalf("LookupOption(%q) reported a value that was not a given string", name)
		}
	}
	var empty CommandInput
	if empty.Arg("x") != "" || empty.Option("x") != "" || empty.Flag("x") || empty.List("x") != nil {
		t.Fatal("nil maps must read as zero values")
	}

	setup := SetupOptions{Options: map[string]any{"app-key": "k", "full": true}}
	if setup.Option("app-key") != "k" || setup.Option("full") != "" || !setup.Flag("full") || setup.Flag("app-key") {
		t.Fatal("SetupOptions accessors mix up types")
	}
	if (SetupOptions{}).Option("x") != "" || (SetupOptions{}).Flag("x") {
		t.Fatal("nil setup options must read as zero values")
	}
}

// A failed call returning a typed nil must come back as an untyped nil, or the
// host would print "null" before the error.
// event stands in for an API response struct.
type event struct{ ID string }

func TestResultDropsTheTypedNilOnFailure(t *testing.T) {
	var none *event
	v, err := Result(none, errors.New("boom"))
	if v != nil || err == nil {
		t.Fatalf("%#v %v", v, err)
	}
	// A value that came with an error is dropped too.
	v, _ = Result(&event{ID: "x"}, errors.New("boom"))
	if v != nil {
		t.Fatalf("%#v", v)
	}
	if v, err := Result([]string{}, nil); err != nil || v == nil {
		t.Fatalf("%#v %v", v, err)
	}
}

func TestRequireOptionsReportsTheFirstMissingInDeclarationOrder(t *testing.T) {
	var got []string
	run := &RunContext{Fail: func(code ErrorCode, message, suggestion string) error {
		got = append(got, string(code)+"|"+message+"|"+suggestion)
		return errors.New(message)
	}}
	in := CommandInput{Options: map[string]any{"space": "", "limit": true, "query": "q"}}
	if err := RequireOptions(in, run.Fail, "--query <q>", "--limit <n>", "--space <id>"); err == nil {
		t.Fatal("a bool where a string is required passed")
	}
	// Commander's requiredOption checks `=== undefined`: a given "" is present,
	// while an absent option (nil, as the host leaves it) still fails after it.
	if err := RequireOptions(in, run.Fail, "--space <id>"); err != nil {
		t.Fatalf("a given empty string failed: %v", err)
	}
	in.Options["missing"] = nil
	if err := RequireOptions(in, run.Fail, "--space <id>", "--missing <x>"); err == nil {
		t.Fatal("an absent option after a given empty one passed")
	}
	want := []string{
		"INVALID_PARAMS|required option '--limit <n>' not specified|",
		"INVALID_PARAMS|required option '--missing <x>' not specified|",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%q", got)
	}
	if err := RequireOptions(in, run.Fail, "--query <q>"); err != nil {
		t.Fatal(err)
	}
}

// A command that validates before enforceWriteAccess answers a read-only
// profile with its input error: WriteUnlessInvalid reads "read" for that
// input so the host lets Run report it.
func TestWriteUnlessInvalidReadsOnlyForRejectedInput(t *testing.T) {
	calls := 0
	access := WriteUnlessInvalid(func(in CommandInput, fail func(ErrorCode, string, string) error) error {
		calls++
		if in.Options["to"] == "" {
			return fail("INVALID_PARAMS", "--to is required", "")
		}
		return nil
	})
	if got := access(CommandInput{Options: map[string]any{"to": ""}}); got != "read" {
		t.Fatalf("invalid input: %q", got)
	}
	if got := access(CommandInput{Options: map[string]any{"to": "a@example.com"}}); got != "write" {
		t.Fatalf("valid input: %q", got)
	}
	if calls != 2 {
		t.Fatalf("check ran %d times", calls)
	}
}
