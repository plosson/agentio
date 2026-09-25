package vault

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
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

// Bun keeps the whole document, so Go must carry the members it does not
// model through a load and save. The members Go models are the struct's json
// tags, so a new field can never be mistaken for an unknown one.

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

// unmarshalKeeping resets the struct v points to and decodes the JSON object b
// into it, keeping numbers as json.Number. It returns the members v has no
// field for.
func unmarshalKeeping(b []byte, v any) (map[string]json.RawMessage, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(b, &members); err != nil {
		return nil, err
	}
	rv := reflect.ValueOf(v).Elem()
	rv.SetZero()
	for _, f := range jsonFields(rv.Type()) {
		raw, ok := members[f.name]
		if !ok {
			continue
		}
		delete(members, f.name)
		if err := decodeNumbers(raw, rv.Field(f.index).Addr().Interface()); err != nil {
			return nil, err
		}
	}
	if len(members) == 0 {
		return nil, nil
	}
	return members, nil
}

// marshalKeeping encodes the struct v with the members of extra. Without
// extra the output is v's own encoding; with it, members are sorted by key.
func marshalKeeping(v any, extra map[string]json.RawMessage) ([]byte, error) {
	if len(extra) == 0 {
		return json.Marshal(v)
	}
	rv := reflect.ValueOf(v)
	fields := jsonFields(rv.Type())
	members := make(map[string]any, len(fields)+len(extra))
	for k, x := range extra {
		members[k] = x
	}
	for _, f := range fields {
		fv := rv.Field(f.index)
		if f.omitEmpty && isEmptyJSON(fv) {
			continue
		}
		members[f.name] = fv.Interface()
	}
	return json.Marshal(members)
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
