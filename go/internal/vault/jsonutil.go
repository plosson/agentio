package vault

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"sync"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// decodeNumbers unmarshals b keeping numbers as json.Number, so credential
// values round-trip without float rounding.
func decodeNumbers(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	return dec.Decode(v)
}

// Bun keeps the whole document, in its order, so Go must carry the members
// it does not model through a load and save, and write every member where it
// was: JSON.parse and JSON.stringify keep an object's key order. The members
// Go models are the struct's json tags, so a new field can never be mistaken
// for an unknown one.

// members is what a decoded object keeps besides its modeled fields: the
// order its members came in and the ones Go does not model.
type members struct {
	order []string
	extra map[string]json.RawMessage
}

type jsonField struct {
	index     int
	name      string
	omitEmpty bool
}

var jsonFieldCache sync.Map // reflect.Type -> []jsonField

func jsonFields(t reflect.Type) []jsonField {
	if f, ok := jsonFieldCache.Load(t); ok {
		return f.([]jsonField)
	}
	var fields []jsonField
	for i := 0; i < t.NumField(); i++ {
		sf := t.Field(i)
		tag := sf.Tag.Get("json")
		if !sf.IsExported() || tag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if name == "" {
			name = sf.Name
		}
		fields = append(fields, jsonField{i, name, strings.Contains(","+opts+",", ",omitempty,")})
	}
	f, _ := jsonFieldCache.LoadOrStore(t, fields)
	return f.([]jsonField)
}

// memberOrder is the order JSON.parse gives the members of the object b.
func memberOrder(b []byte) []string {
	v, err := jsvalue.Parse(b)
	if err != nil {
		return nil
	}
	obj, ok := v.(*jsvalue.Object)
	if !ok {
		return nil
	}
	return obj.Keys()
}

// unmarshalKeeping resets the struct v points to and decodes the JSON object b
// into it, keeping numbers as json.Number. It returns the member order and
// the members v has no field for.
func unmarshalKeeping(b []byte, v any) (members, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return members{}, err
	}
	rv := reflect.ValueOf(v).Elem()
	rv.SetZero()
	for _, f := range jsonFields(rv.Type()) {
		r, ok := raw[f.name]
		if !ok {
			continue
		}
		delete(raw, f.name)
		if err := decodeNumbers(r, rv.Field(f.index).Addr().Interface()); err != nil {
			return members{}, err
		}
	}
	m := members{order: memberOrder(b)}
	if len(raw) > 0 {
		m.extra = raw
	}
	return m, nil
}

// marshalKeeping encodes the struct v with the members kept from its decode,
// as JSON.stringify writes the object Bun holds: members in their decoded
// order, then fields set since in declaration order (a Go struct declares
// them in the order Bun's object literal does).
func marshalKeeping(v any, m members) ([]byte, error) {
	rv := reflect.ValueOf(v)
	fields := jsonFields(rv.Type())
	byName := make(map[string]jsonField, len(fields))
	for _, f := range fields {
		byName[f.name] = f
	}
	var b bytes.Buffer
	b.WriteByte('{')
	written := map[string]bool{}
	write := func(name string, raw []byte) {
		if written[name] {
			return
		}
		written[name] = true
		if b.Len() > 1 {
			b.WriteByte(',')
		}
		key, _ := json.Marshal(name)
		b.Write(key)
		b.WriteByte(':')
		b.Write(raw)
	}
	field := func(f jsonField) error {
		fv := rv.Field(f.index)
		if f.omitEmpty && omitted(fv) {
			return nil
		}
		raw, err := json.Marshal(fv.Interface())
		if err != nil {
			return err
		}
		write(f.name, raw)
		return nil
	}
	for _, name := range m.order {
		if f, ok := byName[name]; ok {
			if err := field(f); err != nil {
				return nil, err
			}
		} else if raw, ok := m.extra[name]; ok {
			write(name, raw)
		}
	}
	for _, f := range fields {
		if err := field(f); err != nil {
			return nil, err
		}
	}
	for _, name := range sortedKeys(m.extra) {
		write(name, m.extra[name])
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// omitted is whether an omitempty field is left out. A pointer, slice or map
// is left out only when nil, so a stored [] or false (Bun's `apiKeys: []`
// after the last key is revoked) is written back; anything else follows
// encoding/json's omitempty.
func omitted(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Interface, reflect.Pointer, reflect.Slice, reflect.Map:
		return v.IsNil()
	}
	return isEmptyJSON(v)
}

// isEmptyJSON is encoding/json's omitempty test.
func isEmptyJSON(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	case reflect.Bool:
		return !v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int() == 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return v.Uint() == 0
	case reflect.Float32, reflect.Float64:
		return v.Float() == 0
	case reflect.Interface, reflect.Pointer:
		return v.IsNil()
	}
	return false
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
