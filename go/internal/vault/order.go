package vault

import (
	"bytes"
	"encoding/json"
	"sort"
	"sync"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// Bun keeps a credential object's keys in the order they were stored:
// JSON.parse and JSON.stringify keep insertion order, so a save writes it, and
// the hub hands it out, as stored. A Go map has no order. So the credential
// objects of the last two vault documents decoded are remembered by content:
// while a credential's content is what was stored, it is written and served in
// its stored order, nested objects included. A new or changed one is sorted,
// like any map. Two documents cover a document decoded while another is
// being written into (an import, an export).
var (
	orderMu   sync.Mutex
	storedNow map[string]json.RawMessage
	storedWas map[string]json.RawMessage
)

// canonical is the content of a credential object, whatever its key order.
func canonical(m map[string]any) (string, bool) {
	b, err := json.Marshal(m)
	return string(b), err == nil
}

// rememberOrder records the credential objects of one decoded document.
func rememberOrder(raw map[string]map[string]json.RawMessage) {
	next := map[string]json.RawMessage{}
	for _, profiles := range raw {
		for _, cred := range profiles {
			var m map[string]any
			if decodeNumbers(cred, &m) != nil || m == nil {
				continue
			}
			var compact bytes.Buffer
			if json.Compact(&compact, cred) != nil {
				continue
			}
			if key, ok := canonical(m); ok {
				next[key] = compact.Bytes()
			}
		}
	}
	orderMu.Lock()
	storedWas, storedNow = storedNow, next
	orderMu.Unlock()
}

// storedJSON is the credential object as it was stored, when its content is
// unchanged.
func storedJSON(m map[string]any) (json.RawMessage, bool) {
	key, ok := canonical(m)
	if !ok {
		return nil, false
	}
	orderMu.Lock()
	defer orderMu.Unlock()
	if raw, ok := storedNow[key]; ok {
		return raw, true
	}
	raw, ok := storedWas[key]
	return raw, ok
}

// Ordered is a credential object as Bun holds it: its stored key order while
// its content is unchanged, else its keys sorted.
func Ordered(m map[string]any) *jsvalue.Object {
	if raw, ok := storedJSON(m); ok {
		if parsed, err := jsvalue.Parse(raw); err == nil {
			if obj, ok := parsed.(*jsvalue.Object); ok {
				return obj
			}
		}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	obj := jsvalue.NewObject()
	for _, k := range keys {
		obj.Set(k, m[k])
	}
	return obj
}

// Credentials is the vault's credentials member: service, then profile, then
// the credential object. It is written with each object in its stored order.
type Credentials map[string]map[string]map[string]any

func (c Credentials) MarshalJSON() ([]byte, error) {
	if c == nil {
		return []byte("null"), nil
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, service := range sortedKeys(c) {
		if i > 0 {
			b.WriteByte(',')
		}
		writeKey(&b, service)
		profiles := c[service]
		if profiles == nil {
			b.WriteString("null")
			continue
		}
		b.WriteByte('{')
		for j, name := range sortedKeys(profiles) {
			if j > 0 {
				b.WriteByte(',')
			}
			writeKey(&b, name)
			cred := profiles[name]
			if raw, ok := storedJSON(cred); ok && cred != nil {
				b.Write(raw)
				continue
			}
			raw, err := json.Marshal(cred)
			if err != nil {
				return nil, err
			}
			b.Write(raw)
		}
		b.WriteByte('}')
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (c *Credentials) UnmarshalJSON(b []byte) error {
	var raw map[string]map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	var decoded map[string]map[string]map[string]any
	if err := decodeNumbers(b, &decoded); err != nil {
		return err
	}
	rememberOrder(raw)
	*c = decoded
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func writeKey(b *bytes.Buffer, key string) {
	raw, _ := json.Marshal(key)
	b.Write(raw)
	b.WriteByte(':')
}
