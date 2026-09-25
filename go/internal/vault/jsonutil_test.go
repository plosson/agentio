package vault

import (
	"encoding/json"
	"testing"
)

// keepingDoc stands in for a struct that gains an omitempty field.
type keepingDoc struct {
	Name  string `json:"name"`
	Added string `json:"added,omitempty"`

	extra map[string]json.RawMessage
}

type plainKeepingDoc keepingDoc

func (d keepingDoc) MarshalJSON() ([]byte, error) { return marshalKeeping(plainKeepingDoc(d), d.extra) }

func (d *keepingDoc) UnmarshalJSON(b []byte) (err error) {
	d.extra, err = unmarshalKeeping(b, (*plainKeepingDoc)(d))
	return err
}

// A cleared omitempty field must stay cleared: it is a known member, not an
// unknown one to write back from what was loaded.
func TestClearedOmitemptyFieldDoesNotComeBack(t *testing.T) {
	var d keepingDoc
	if err := json.Unmarshal([]byte(`{"name":"n","added":"stale","other":1}`), &d); err != nil {
		t.Fatal(err)
	}
	if d.Added != "stale" {
		t.Fatalf("added not loaded: %q", d.Added)
	}
	d.Added = ""
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b); got != `{"name":"n","other":1}` {
		t.Fatalf("got %s", got)
	}
}

// A known member must win over an extra of the same name, and a reused
// target must not keep values the input does not have.
func TestKeepingDoesNotLeakOldOrShadowedValues(t *testing.T) {
	d := keepingDoc{Name: "old", Added: "old", extra: map[string]json.RawMessage{"name": json.RawMessage(`"shadow"`)}}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b); got != `{"added":"old","name":"old"}` {
		t.Fatalf("got %s", got)
	}
	if err := json.Unmarshal([]byte(`{"name":"new"}`), &d); err != nil {
		t.Fatal(err)
	}
	if d.Added != "" || d.extra != nil || d.Name != "new" {
		t.Fatalf("stale state after reload: %+v", d)
	}
}

func TestKeepingRejectsNonObjectsAndBadMembers(t *testing.T) {
	for _, in := range []string{`[]`, `"s"`, `{"name":1}`, `{"name":"a",}`} {
		var d keepingDoc
		if err := json.Unmarshal([]byte(in), &d); err == nil {
			t.Errorf("%s: no error", in)
		}
	}
}

// Credential numbers must survive exactly, at any depth.
func TestContentsKeepsNumbersExact(t *testing.T) {
	in := `{"version":1,"credentials":{"s":{"p":{"n":12345678901234567890,"f":0.1000}}},"x":{"n":1e400}}`
	c, err := decodeContents([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"config":{"profiles":{}},"credentials":{"s":{"p":{"f":0.1000,"n":12345678901234567890}}},"version":1,"x":{"n":1e400}}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}
