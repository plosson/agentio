package plugincache

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/plosson/agentio/go/internal/testbox"
)

func TestCacheRejectsPathTricksAndCorruptFiles(t *testing.T) {
	testbox.Isolate(t)
	if _, err := Path("../acme", "scope", "note"); err == nil {
		t.Fatal("plugin id with a slash was accepted")
	}
	if _, err := Path("acme", "scope", ".."); err == nil {
		t.Fatal("cache name .. was accepted")
	}
	if err := Write("acme", "ada@x", "note", map[string]string{"text": "hi"}); err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	ok, err := Read("acme", "ada@x", "note", &got)
	if err != nil || !ok || got["text"] != "hi" {
		t.Fatalf("%v %v %#v", ok, err, got)
	}
	path, err := Path("acme", "ada@x", "note")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	ok, err = Read("acme", "ada@x", "note", &got)
	if err != nil || ok {
		t.Fatalf("corrupt cache was returned: %v %v", ok, err)
	}
	if rel, _ := filepath.Rel(os.TempDir(), path); len(rel) >= 2 && rel[:2] == ".." {
		t.Fatalf("cache escaped the temp home: %s", path)
	}
}

// The file is JSON.stringify(value), as Bun writes it: no HTML escaping.
func TestWriteIsJSONStringify(t *testing.T) {
	testbox.Isolate(t)
	if err := Write("acme", "scope", "note", map[string]string{"text": "a&<b> "}); err != nil {
		t.Fatal(err)
	}
	path, _ := Path("acme", "scope", "note")
	raw, _ := os.ReadFile(path)
	if string(raw) != "{\"text\":\"a&<b> \"}" {
		t.Fatalf("%q", raw)
	}
}
