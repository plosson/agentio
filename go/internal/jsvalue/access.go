package jsvalue

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
)

type undefinedValue struct{}

// Undefined is JavaScript's undefined in a Parse value tree: what reading a
// missing member gives. String gives "undefined"; Stringify leaves it out of
// an object and writes null for it in an array.
var Undefined any = undefinedValue{}

// Nullish is `v == null`: null or undefined.
func Nullish(v any) bool { return v == nil || v == Undefined }

// Member is base[key] on a non-nullish Parse value: an object's member, an
// array's element or length, a string's length; Undefined otherwise.
func Member(base any, key string) any {
	switch b := base.(type) {
	case *Object:
		if v, ok := b.Get(key); ok {
			return v
		}
	case []any:
		if key == "length" {
			return float64(len(b))
		}
		if i, err := strconv.Atoi(key); err == nil && i >= 0 && i < len(b) && strconv.Itoa(i) == key {
			return b[i]
		}
	case string:
		if key == "length" {
			return float64(Length(b))
		}
	}
	return Undefined
}

// Optional is `base?.key`: undefined when base is null or undefined.
func Optional(base any, key string) any {
	if Nullish(base) {
		return Undefined
	}
	return Member(base, key)
}

// Spread is `{ ...v }`: an object's members in order, an array's elements
// under their indices, a string's characters under theirs (a character
// outside the BMP stays whole: Go has no lone surrogate), nothing for
// anything else.
func Spread(v any) *Object {
	out := NewObject()
	switch x := v.(type) {
	case *Object:
		for _, k := range x.Keys() {
			val, _ := x.Get(k)
			out.Set(k, val)
		}
	case []any:
		for i, e := range x {
			out.Set(strconv.Itoa(i), e)
		}
	case string:
		i := 0
		for _, r := range x {
			out.Set(strconv.Itoa(i), string(r))
			i++
		}
	}
	return out
}

// TypeError is the error JavaScriptCore throws for reading a member of base
// (null or undefined) in expr, the source text Bun reports.
func TypeError(base any, expr string) error {
	name := "null"
	if base == Undefined {
		name = "undefined"
	}
	return errors.New(name + " is not an object (evaluating '" + expr + "')")
}

// Path is `text.k1.k2…` as JavaScript runs it: each key is read from the
// value so far, and a read from null or undefined throws, reported with the
// expression up to the key that failed.
func Path(base any, text string, keys ...string) (any, error) {
	cur, expr := base, text
	for _, k := range keys {
		expr += "." + k
		if Nullish(cur) {
			return nil, TypeError(cur, expr)
		}
		cur = Member(cur, k)
	}
	return cur, nil
}

// Items are the elements `text.map(…)` walks: a nullish text throws as
// reading its map does. A value that is not an array has no map either.
func Items(v any, text string) ([]any, error) {
	if Nullish(v) {
		return nil, TypeError(v, text+".map")
	}
	items, ok := v.([]any)
	if !ok {
		return nil, errors.New(text + ".map is not a function")
	}
	return items, nil
}

// Map is `text.map(f)`: Items, then f on each element in order; the first
// error (a TypeError f raises) stops it.
func Map(v any, text string, f func(any) (any, error)) ([]any, error) {
	items, err := Items(v, text)
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(items))
	for _, item := range items {
		mapped, err := f(item)
		if err != nil {
			return nil, err
		}
		out = append(out, mapped)
	}
	return out, nil
}

// StrictEqual is a === b for Parse values and Go scalars: numbers by value,
// objects and arrays by identity.
func StrictEqual(a, b any) bool {
	if na, ok := number(a); ok {
		nb, ok := number(b)
		return ok && na == nb
	}
	switch x := a.(type) {
	case nil, undefinedValue, string, bool:
		return a == b
	case *Object:
		y, ok := b.(*Object)
		return ok && x == y
	case []any:
		y, ok := b.([]any)
		return ok && len(x) > 0 && len(y) > 0 && &x[0] == &y[0] && len(x) == len(y)
	}
	return false
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(string(n), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return math.NaN(), true
		}
		return f, true
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
