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
}

// NewObject is an empty object literal.
func NewObject() *Object { return &Object{vals: map[string]any{}} }

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

// Keys is Object.keys(o) in insertion order.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	return slices.Clone(o.keys)
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

// Stringify is JSON.stringify(v) for Parse values and plain Go values.
// NaN, Infinity and out-of-range numbers are written as null.
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
	case nil:
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
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case *Object:
		if t == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		for i, k := range t.keys {
			if i > 0 {
				b.WriteByte(',')
			}
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
		raw, err := t.MarshalJSON()
		if err != nil {
			b.WriteString("null")
			return
		}
		b.Write(raw)
	default:
		raw, _ := json.Marshal(t)
		b.Write(raw)
	}
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
