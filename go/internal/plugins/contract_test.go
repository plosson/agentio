package plugins

import "testing"

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
