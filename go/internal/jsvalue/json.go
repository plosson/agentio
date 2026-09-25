// Package jsvalue reproduces what the Bun CLI gets from JavaScript itself:
// JSON.parse and JSON.stringify with key order kept, String(n), Number(s),
// parseInt, toFixed, new Date(s), and UTF-16 string slicing. A ported service
// uses it so its output matches Bun byte for byte without a private copy of
// these rules.
package jsvalue

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Object is a JSON object that remembers key order. A repeated key keeps its
// first position and its last value, as JSON.parse does.
type Object struct {
	keys []string
	vals map[string]any
	// asInserted keeps integer-like keys where they were set (Bun's native
	// SQL row objects); a plain object puts them first.
	asInserted bool
}

// NewObject is an empty object literal.
func NewObject() *Object { return &Object{vals: map[string]any{}} }

// NewInsertionOrderObject is an object whose keys all keep insertion order,
// integer-like ones included: the row objects Bun's SQL client builds.
func NewInsertionOrderObject() *Object { return &Object{vals: map[string]any{}, asInserted: true} }

// Set is o[key] = v: a new key goes last, an existing key keeps its place.
func (o *Object) Set(key string, v any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// Get returns the value and whether the key is present (undefined vs null).
func (o *Object) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Keys is Object.keys(o): array-index keys ascending, then the others in
// insertion order, as JavaScript orders an object's own properties.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	if o.asInserted {
		return slices.Clone(o.keys)
	}
	var indices, names []string
	for _, k := range o.keys {
		if _, ok := arrayIndex(k); ok {
			indices = append(indices, k)
		} else {
			names = append(names, k)
		}
	}
	if len(indices) == 0 {
		return slices.Clone(o.keys)
	}
	slices.SortFunc(indices, func(a, b string) int {
		x, _ := arrayIndex(a)
		y, _ := arrayIndex(b)
		return int(x) - int(y)
	})
	return append(indices, names...)
}

// arrayIndex is a canonical integer key below 2^32-1 ("0", "7"; not "07").
func arrayIndex(k string) (uint32, bool) {
	n, err := strconv.ParseUint(k, 10, 32)
	if err != nil || n == math.MaxUint32 || strconv.FormatUint(n, 10) != k {
		return 0, false
	}
	return uint32(n), true
}

// Str is a strict string field: anything else, including null, is absent.
func (o *Object) Str(key string) (string, bool) {
	v, _ := o.Get(key)
	s, ok := v.(string)
	return s, ok
}

// Text is `value ?? null` interpolated: String(v) for a present non-null
// value, nil for null or undefined.
func (o *Object) Text(key string) *string {
	v, _ := o.Get(key)
	if v == nil {
		return nil
	}
	s := String(v)
	return &s
}

// MarshalJSON is JSON.stringify(o) without indentation.
func (o *Object) MarshalJSON() ([]byte, error) {
	return Stringify(o), nil
}

// Parse is JSON.parse keeping object key order: objects are *Object, arrays
// []any, numbers json.Number (so the text the server sent is kept).
func Parse(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return v, nil
}

func readValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch d {
	case '{':
		o := NewObject()
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, _ := kt.(string)
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			o.Set(key, v)
		}
		_, err := dec.Token()
		return o, err
	case '[':
		arr := []any{}
		for dec.More() {
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		_, err := dec.Token()
		return arr, err
	}
	return nil, fmt.Errorf("unexpected %v", d)
}

// Stringify is JSON.stringify(v) for Parse values and plain Go values:
// strings are quoted as writeString does (no escaping of <, >, &, U+2028 or
// U+2029), numbers use String(n) text, and NaN, Infinity and out-of-range
// numbers are written as null.
//
// A Go map has no insertion order, so its keys are written sorted, as
// encoding/json does; a value whose JavaScript key order matters must be an
// *Object. A struct keeps its field order and its json tags. A nil map, nil
// slice or nil pointer is null, as encoding/json writes it.
func Stringify(v any) []byte {
	var b bytes.Buffer
	writeValue(&b, v)
	return b.Bytes()
}

// StringifyIndent is JSON.stringify(v, null, 2).
func StringifyIndent(v any) []byte {
	compact := Stringify(v)
	var indented bytes.Buffer
	if err := json.Indent(&indented, compact, "", "  "); err != nil {
		return compact
	}
	return indented.Bytes()
}

func writeValue(b *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil, undefinedValue:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case string:
		writeString(b, t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			b.WriteString("null")
			return
		}
		writeFloat(b, f)
	case float64:
		writeFloat(b, t)
	case int:
		writeFloat(b, float64(t))
	case int64:
		writeFloat(b, float64(t))
	case *Object:
		if t == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		first := true
		for _, k := range t.Keys() {
			if t.vals[k] == Undefined {
				continue // JSON.stringify leaves undefined members out
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			writeString(b, k)
			b.WriteByte(':')
			writeValue(b, t.vals[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeValue(b, e)
		}
		b.WriteByte(']')
	case json.Marshaler:
		// Called directly: json.Marshal would escape <, > and & in the result.
		// The result is read back and written again, so a MarshalJSON built on
		// encoding/json (which escapes U+2028 and U+2029) still reads as
		// JSON.stringify.
		raw, err := t.MarshalJSON()
		if err != nil {
			b.WriteString("null")
			return
		}
		parsed, err := Parse(raw)
		if err != nil {
			b.Write(raw)
			return
		}
		writeValue(b, parsed)
	default:
		writeReflect(b, reflect.ValueOf(v))
	}
}

// writeReflect writes the plain Go values writeValue has no case for.
func writeReflect(b *bytes.Buffer, rv reflect.Value) {
	switch rv.Kind() {
	case reflect.Invalid:
		b.WriteString("null")
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			b.WriteString("null")
			return
		}
		writeValue(b, rv.Elem().Interface())
	case reflect.Bool:
		b.WriteString(strconv.FormatBool(rv.Bool()))
	case reflect.String:
		writeString(b, rv.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		// A JavaScript number: exact up to 2^53, rounded beyond, as String(n).
		writeFloat(b, float64(rv.Int()))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		writeFloat(b, float64(rv.Uint()))
	case reflect.Float32:
		// The shortest float32 text, read as the JavaScript number it names.
		f, _ := strconv.ParseFloat(strconv.FormatFloat(rv.Float(), 'g', -1, 32), 64)
		writeFloat(b, f)
	case reflect.Float64:
		writeFloat(b, rv.Float())
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			writeViaJSON(b, rv.Interface())
			return
		}
		if rv.IsNil() {
			b.WriteString("null")
			return
		}
		keys := make([]string, 0, rv.Len())
		for _, k := range rv.MapKeys() {
			keys = append(keys, k.String())
		}
		slices.Sort(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, k)
			b.WriteByte(':')
			writeValue(b, rv.MapIndex(reflect.ValueOf(k).Convert(rv.Type().Key())).Interface())
		}
		b.WriteByte('}')
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.Type().Elem().Kind() == reflect.Uint8 {
			writeViaJSON(b, rv.Interface()) // []byte: base64, as encoding/json
			return
		}
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			b.WriteString("null")
			return
		}
		b.WriteByte('[')
		for i := 0; i < rv.Len(); i++ {
			if i > 0 {
				b.WriteByte(',')
			}
			writeValue(b, rv.Index(i).Interface())
		}
		b.WriteByte(']')
	default:
		writeViaJSON(b, rv.Interface())
	}
}

// writeViaJSON writes a struct (fields in declaration order, json tags
// applied) or another type encoding/json knows, then re-writes the result
// through Parse so strings and numbers follow JSON.stringify. A value
// encoding/json cannot write (a NaN field, a channel) is null.
func writeViaJSON(b *bytes.Buffer, v any) {
	var raw bytes.Buffer
	enc := json.NewEncoder(&raw)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		b.WriteString("null")
		return
	}
	parsed, err := Parse(raw.Bytes())
	if err != nil {
		b.WriteString("null")
		return
	}
	writeValue(b, parsed)
}

func writeFloat(b *bytes.Buffer, f float64) {
	if math.IsInf(f, 0) || math.IsNaN(f) {
		b.WriteString("null")
		return
	}
	b.WriteString(NumberString(f))
}

// Quote is JSON.stringify(s) for a string.
func Quote(s string) string {
	var b bytes.Buffer
	writeString(&b, s)
	return b.String()
}

// writeString quotes like JSON.stringify: only quote, backslash and control
// characters are escaped; <, >, &, U+2028 and U+2029 are written as is.
func writeString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// ParseErrorMessage is the message Bun's JSON.parse throws for raw, which is
// not valid JSON: JavaScriptCore's wording for an empty input, a bare word, a
// stray character, an unterminated string or container, a bad property, and
// text after a complete value.
func ParseErrorMessage(raw []byte) string {
	p := &jscParser{s: raw}
	msg := p.value()
	if msg == "" {
		p.ws()
		if p.i < len(p.s) {
			msg = "Unable to parse JSON string"
		}
	}
	if msg == "" {
		msg = "Unable to parse JSON string"
	}
	return "JSON Parse error: " + msg
}

type jscParser struct {
	s []byte
	i int
}

func (p *jscParser) ws() {
	for p.i < len(p.s) && strings.IndexByte(" \t\r\n", p.s[p.i]) >= 0 {
		p.i++
	}
}

func (p *jscParser) value() string {
	p.ws()
	if p.i >= len(p.s) {
		return "Unexpected EOF"
	}
	c := p.s[p.i]
	switch {
	case c == '{':
		return p.container('}')
	case c == '[':
		return p.container(']')
	case c == '"':
		return p.str()
	case c == '-' || c >= '0' && c <= '9':
		p.number()
		return ""
	case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' || c == '$':
		start := p.i
		for p.i < len(p.s) && (isWordByte(p.s[p.i])) {
			p.i++
		}
		switch word := string(p.s[start:p.i]); word {
		case "true", "false", "null":
			return ""
		default:
			return `Unexpected identifier "` + word + `"`
		}
	}
	if strings.IndexByte(",:]}", c) >= 0 {
		return "Unexpected token '" + string(c) + "'"
	}
	r, _ := utf8.DecodeRune(p.s[p.i:])
	return "Unrecognized token '" + string(r) + "'"
}

// number consumes a JSON number: a leading 0 stands alone, as in JSC.
func (p *jscParser) number() {
	digits := func() {
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
	}
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else {
		digits()
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		digits()
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		digits()
	}
}

func isWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '$'
}

func (p *jscParser) str() string {
	p.i++
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case '\\':
			p.i += 2
		case '"':
			p.i++
			return ""
		default:
			p.i++
		}
	}
	return "Unterminated string"
}

func (p *jscParser) container(end byte) string {
	expected := "Expected '" + string(end) + "'"
	p.i++
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == end {
		p.i++
		return ""
	}
	for first := true; ; first = false {
		p.ws()
		if end == '}' {
			// The first member of "{" is its close or a name; after a comma a
			// name is due.
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				if first {
					return expected
				}
				return "Property name must be a string literal"
			}
			if msg := p.str(); msg != "" {
				return msg
			}
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != ':' {
				return "Expected ':' before value in object property definition"
			}
			p.i++
		} else if !first && p.i < len(p.s) && p.s[p.i] == ']' {
			return "Unexpected comma at the end of array expression"
		}
		if msg := p.value(); msg != "" {
			return msg
		}
		p.ws()
		if p.i >= len(p.s) {
			return expected
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case end:
			p.i++
			return ""
		default:
			return expected
		}
	}
}
