package jsvalue

import (
	"errors"
	"slices"
)

// ObjectOf is an object literal, `{ k1: v1, k2: v2 }`: kv alternates string
// keys and values, and the keys keep that order. A repeated key keeps its
// first place and its last value, as in JavaScript.
func ObjectOf(kv ...any) *Object {
	if len(kv)%2 != 0 {
		panic("jsvalue.ObjectOf: odd number of arguments")
	}
	o := NewObject()
	for i := 0; i < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok {
			panic("jsvalue.ObjectOf: a key is not a string")
		}
		o.Set(key, kv[i+1])
	}
	return o
}

// Value is o[key] read the way a Go map reads: nil when the key is absent.
// Use Get where an absent key and a null differ.
func (o *Object) Value(key string) any {
	v, _ := o.Get(key)
	return v
}

// StrValue is o[key] when it is a string, else "".
func (o *Object) StrValue(key string) string {
	s, _ := o.Str(key)
	return s
}

// Has is `key in o`.
func (o *Object) Has(key string) bool {
	_, ok := o.Get(key)
	return ok
}

// Len is Object.keys(o).length.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Delete is `delete o[key]`: the key leaves its place, and a later Set of it
// goes last.
func (o *Object) Delete(key string) {
	if o == nil {
		return
	}
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	o.keys = slices.DeleteFunc(o.keys, func(k string) bool { return k == key })
}

// Clone is a deep copy: nested objects and arrays are copied too, so the copy
// can change without touching o. nil stays nil.
func (o *Object) Clone() *Object {
	if o == nil {
		return nil
	}
	out := &Object{keys: slices.Clone(o.keys), vals: make(map[string]any, len(o.vals)), asInserted: o.asInserted}
	for k, v := range o.vals {
		out.vals[k] = CloneValue(v)
	}
	return out
}

// CloneValue is a deep copy of a Parse value: objects and arrays are copied,
// anything else is returned as is.
func CloneValue(v any) any {
	switch x := v.(type) {
	case *Object:
		return x.Clone()
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = CloneValue(e)
		}
		return out
	}
	return v
}

// UnmarshalJSON is JSON.parse of an object, keys in order. Anything but an
// object is an error.
func (o *Object) UnmarshalJSON(b []byte) error {
	v, err := Parse(b)
	if err != nil {
		return err
	}
	parsed, ok := v.(*Object)
	if !ok {
		return errors.New("jsvalue: not a JSON object")
	}
	*o = *parsed
	return nil
}
