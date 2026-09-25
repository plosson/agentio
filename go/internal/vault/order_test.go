package vault

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// bunEval runs script under Bun with the document in DOC and returns what it
// prints: the reference for what Bun writes.
func bunEval(t *testing.T, doc, script string) string {
	t.Helper()
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("bun is not installed")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bun", "-e", "const v = JSON.parse(process.env.DOC);\n"+script+"\nprocess.stdout.write(JSON.stringify(v));")
	cmd.Dir = root
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir(), "DOC=" + doc}
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("bun: %v\n%s", err, ee.Stderr)
		}
		t.Fatal(err)
	}
	return string(out)
}

// Documents Bun could hold: keys out of order at every level, integer-like
// keys (JavaScript puts them first), a repeated key, numbers JSON.stringify
// rewrites, strings it does not escape, members Go does not model, an empty
// apiKeys list, a null profile list and both profile entry forms.
var orderDocs = []string{
	`{"credentials":{"svc":{"b":{"z":1,"y":{"q":1,"p":[{"d":1,"c":2}]}},"a":{"k2":"v","k1":"v"}}},"version":1,"top":{"b":1,"a":2},"config":{"server":{"z":1,"a":2},"profiles":{"svc":[{"note":"n","name":"b","readOnly":false},"a"]},"apiKeys":[]}}`,
	`{"version":1,"config":{"profiles":{"zz":null,"10":["x"],"2":[{"name":"y"}],"a":[]},"apiKeys":[{"lastUsedAt":"2026-01-01T00:00:00.000Z","name":"k","id":"k1","secretHash":"h","allowedProfiles":"*","readOnly":true,"createdAt":"2025-01-01T00:00:00.000Z","canManageProfiles":false,"x":{"2":1,"1":2}}]},"credentials":{"10":{"b":{"7":"seven","3":"three","name":"n"}},"a":{"p":{"n":1.0,"big":12345678901234567890,"e":1e21,"neg":-0,"f":0.1000}}}}`,
	`{"version":1,"config":{"profiles":{"s":["p"]}},"credentials":{"s":{"p":{"html":"<a href=\"x\">&amp;</a>","ls":"  ","ctl":"\u0001\t\n","emoji":"😀","esc":"\/"}}},"dup":1,"dup":2}`,
}

// Loaded and written back unchanged, a document is exactly what Bun writes.
func TestPlaintextIsWhatBunWrites(t *testing.T) {
	for _, doc := range orderDocs {
		c, err := decodeContents([]byte(doc))
		if err != nil {
			t.Fatal(err)
		}
		want := bunEval(t, doc, "")
		if got := string(Plaintext(c)); got != want {
			t.Errorf("document %s\n got: %s\nwant: %s", doc, got, want)
		}
		cloned, err := clone(c)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(Plaintext(cloned)); got != want {
			t.Errorf("clone of %s\n got: %s\nwant: %s", doc, got, want)
		}
	}
}

// Each change keeps every other member where it was, puts what is new last,
// and gives a deleted and re-added key a new place, as JavaScript does.
func TestChangesKeepBunsOrder(t *testing.T) {
	cases := []struct {
		name string
		js   string
		run  func(c *Contents)
	}{
		{"replace a credential in place",
			`v.credentials.svc.b = { new: 1, alpha: { y: 1, x: 2 } };`,
			func(c *Contents) {
				c.Credentials.Put("svc", "b", jsvalue.ObjectOf("new", 1, "alpha", jsvalue.ObjectOf("y", 1, "x", 2)))
			}},
		{"add a profile and a service",
			`(v.credentials.svc ??= {}).c = { z: 1, a: 2 }; (v.credentials.fresh ??= {}).p = { k: 'v' };`,
			func(c *Contents) {
				c.Credentials.Put("svc", "c", jsvalue.ObjectOf("z", 1, "a", 2))
				c.Credentials.Put("fresh", "p", jsvalue.ObjectOf("k", "v"))
			}},
		{"move a credential",
			`const s = v.credentials.svc.b; (v.credentials.svc ??= {}).moved = s; delete v.credentials.svc.b;`,
			func(c *Contents) {
				stored, _ := c.Credentials.Raw("svc", "b")
				c.Credentials.SetRaw("svc", "moved", stored)
				c.Credentials.Delete("svc", "b")
			}},
		{"delete then add back",
			`delete v.credentials.svc.b; v.credentials.svc.b = { again: true };`,
			func(c *Contents) {
				c.Credentials.Delete("svc", "b")
				c.Credentials.Put("svc", "b", jsvalue.ObjectOf("again", true))
			}},
		{"profile entries",
			`v.config.profiles.svc.push({ name: 'c' }); (v.config.profiles.other ??= []).push({ name: 'o', readOnly: true }); v.config.profiles.svc[0].readOnly = true;`,
			func(c *Contents) {
				list := append(c.Config.Profiles.Get("svc"), ProfileValue{Name: "c"})
				list[0].ReadOnly = true
				c.Config.Profiles.Set("svc", list)
				c.Config.Profiles.Set("other", []ProfileValue{{Name: "o", ReadOnly: true}})
			}},
		{"read-only cleared",
			`delete v.config.profiles.svc[0].readOnly;`,
			func(c *Contents) {
				c.Config.Profiles.Get("svc")[0].ReadOnly = false
				c.Config.Profiles.Get("svc")[0].readOnlyFalse = false
			}},
		{"api key added, touched and migrated",
			`v.config.apiKeys.push({ id: 'k2', name: 'n', secretHash: 'h', hint: 'abcd', allowedProfiles: ['svc/a'], readOnly: false, canManageProfiles: true, createdAt: 'c' });`,
			func(c *Contents) {
				yes := true
				c.Config.APIKeys = append(c.Config.APIKeys, APIKey{ID: "k2", Name: "n", SecretHash: "h", Hint: "abcd",
					AllowedProfiles: Scope{Refs: []string{"svc/a"}}, CanManageProfiles: &yes, CreatedAt: "c"})
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := orderDocs[0]
			c, err := decodeContents([]byte(doc))
			if err != nil {
				t.Fatal(err)
			}
			tc.run(c)
			want := bunEval(t, doc, tc.js)
			if got := string(Plaintext(c)); got != want {
				t.Fatalf("\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

// A key from v2.4 is migrated on its first touch as Bun's withKey does:
// canManageProfiles takes canAddProfiles' value, last, and canAddProfiles
// goes; a first lastUsedAt goes after the members Go does not model.
func TestAPIKeyMigrationKeepsBunsOrder(t *testing.T) {
	doc := `{"version":1,"config":{"profiles":{},"apiKeys":[{"id":"k1","name":"k","secretHash":"h","allowedProfiles":"*","readOnly":false,"canAddProfiles":true,"createdAt":"c","future":1}]},"credentials":{}}`
	c, err := decodeContents([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	k := &c.Config.APIKeys[0]
	v := *k.CanAddProfiles
	k.CanManageProfiles = &v
	k.CanAddProfiles = nil
	k.LastUsedAt = "2026-02-02T00:00:00.000Z"
	want := bunEval(t, doc, `const k = v.config.apiKeys[0]; k.canManageProfiles ??= k.canAddProfiles; delete k.canAddProfiles; k.lastUsedAt = '2026-02-02T00:00:00.000Z';`)
	if got := string(Plaintext(c)); got != want {
		t.Fatalf("\n got: %s\nwant: %s", got, want)
	}
	if !strings.Contains(want, `"future":1,"canManageProfiles":true,"lastUsedAt"`) {
		t.Fatalf("unexpected Bun order: %s", want)
	}
}
