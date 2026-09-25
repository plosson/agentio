package vault

import (
	"encoding/json"
	"testing"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// A credential keeps its stored key order through a decode and a write, and
// under another profile name; a changed one is sorted like any map.
func TestCredentialsKeepTheirStoredOrderUntilChanged(t *testing.T) {
	in := `{"version":1,"config":{"profiles":{}},"credentials":{"s":{"a":{"z":1,"y":{"q":1,"p":2}},"b":{"k2":"v","k1":"v"}}}}`
	c, err := decodeContents([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	c.Credentials["s"]["renamed"] = c.Credentials["s"]["a"]
	delete(c.Credentials["s"], "a")
	c.Credentials["s"]["b"]["k0"] = "new"
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":1,"config":{"profiles":{}},"credentials":{"s":{"b":{"k0":"new","k1":"v","k2":"v"},"renamed":{"z":1,"y":{"q":1,"p":2}}}}}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
	again, err := decodeContents(b)
	if err != nil {
		t.Fatal(err)
	}
	ordered := Ordered(again.Credentials["s"]["renamed"])
	if got := string(jsvalue.Stringify(ordered)); got != `{"z":1,"y":{"q":1,"p":2}}` {
		t.Fatalf("Ordered: %s", got)
	}
	if got := string(jsvalue.Stringify(Ordered(map[string]any{"b": 1, "a": 2}))); got != `{"a":2,"b":1}` {
		t.Fatalf("unknown object: %s", got)
	}
}
