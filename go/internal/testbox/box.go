// Package testbox points HOME at a temp directory and clears process caches
// so a test cannot touch a real vault, and fakes the network failures tests need.
package testbox

import (
	"io"
	"sort"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/vault"
)

func Isolate(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AGENTIO_TEST", "1")
	t.Setenv("AGENTIO_PASSPHRASE", "")
	t.Setenv("AGENTIO_TOKEN", "")
	t.Setenv("AGENTIO_KEY", "")
	t.Setenv("AGENTIO_CONFIG", "")
	t.Setenv("AGENTIO_PASSPHRASE_STORE", "")
	t.Setenv("AGENTIO_KEEPALIVE_HOURS", "0")
	t.Setenv("AGENTIO_TRUSTED_IP_HEADER", "")
	vault.Reset()
	auth.Reset()
}

// Terminal is r read as a terminal (host.IsTerminal): a person at a keyboard,
// for the prompts that only run on one.
func Terminal(r io.Reader) io.Reader { return terminal{r} }

type terminal struct{ io.Reader }

func (terminal) IsTerminal() bool { return true }

// Object is m as a credential object, for a test that writes its fixture as
// a Go map: keys sorted (a map has no order), nested maps converted too. A
// test about key order builds its object with jsvalue.ObjectOf instead.
func Object(m map[string]any) *jsvalue.Object {
	if m == nil {
		return nil
	}
	return objectValue(m).(*jsvalue.Object)
}

func objectValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := jsvalue.NewObject()
		for _, k := range keys {
			o.Set(k, objectValue(x[k]))
		}
		return o
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = objectValue(e)
		}
		return out
	}
	return v
}

// Map is a credential object as a Go map, nested objects included, for a
// test that compares or indexes it as one. nil stays nil.
func Map(o *jsvalue.Object) map[string]any {
	if o == nil {
		return nil
	}
	return mapValue(o).(map[string]any)
}

func mapValue(v any) any {
	switch x := v.(type) {
	case *jsvalue.Object:
		m := make(map[string]any, x.Len())
		for _, k := range x.Keys() {
			if val, _ := x.Get(k); val != jsvalue.Undefined {
				m[k] = mapValue(val)
			}
		}
		return m
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = mapValue(e)
		}
		return out
	}
	return v
}
