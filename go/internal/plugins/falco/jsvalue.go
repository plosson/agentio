package falco

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Falco records are printed the way Bun prints a JSON.parse result: every
// field the server sent, in the server's order. A Go map loses that order, so
// records are kept as an ordered value and re-serialized like JSON.stringify.

// object is a JSON object that remembers key order. A repeated key keeps its
// first position and its last value, as JSON.parse does.
type object struct {
	keys []string
	vals map[string]any
}

func newObject() *object { return &object{vals: map[string]any{}} }

func (o *object) set(key string, v any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// get returns the value and whether the key is present (undefined vs null).
func (o *object) get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// str is a strict string field: anything else, including null, is absent.
func (o *object) str(key string) (string, bool) {
	v, _ := o.get(key)
	s, ok := v.(string)
	return s, ok
}

// text is `value ?? null` interpolated: String(v) for a present non-null
// value, nil for null or undefined.
func (o *object) text(key string) *string {
	v, _ := o.get(key)
	if v == nil {
		return nil
	}
	s := jsString(v)
	return &s
}

func (o *object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	writeJS(&b, o)
	return b.Bytes(), nil
}

// parseJS is JSON.parse keeping object key order. Numbers stay json.Number.
func parseJS(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := readJS(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return v, nil
}

func readJS(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := newObject()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := kt.(string)
				v, err := readJS(dec)
				if err != nil {
					return nil, err
				}
				o.set(key, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := readJS(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("unexpected %v", t)
	default:
		return tok, nil
	}
}

// writeJS is JSON.stringify for values from parseJS and plain Go values.
func writeJS(b *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case string:
		writeJSString(b, t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			b.WriteString("null")
			return
		}
		if math.IsInf(f, 0) || math.IsNaN(f) {
			b.WriteString("null")
			return
		}
		b.WriteString(jsNumberString(f))
	case float64:
		if math.IsInf(t, 0) || math.IsNaN(t) {
			b.WriteString("null")
			return
		}
		b.WriteString(jsNumberString(t))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case *object:
		if t == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		for i, k := range t.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSString(b, k)
			b.WriteByte(':')
			writeJS(b, t.vals[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJS(b, e)
		}
		b.WriteByte(']')
	case json.Marshaler:
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

// writeJSString quotes like JSON.stringify: only quote, backslash and control
// characters are escaped; <, >, &, U+2028 and U+2029 are written as is.
func writeJSString(b *bytes.Buffer, s string) {
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

// jsNumberString is Number.prototype.toString() for a finite number.
func jsNumberString(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == 0 {
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		mant, exp, _ := strings.Cut(s, "e")
		if exp[0] == '+' {
			exp = exp[1:]
			return mant + "e+" + strings.TrimLeft(exp, "0")
		}
		return mant + "e-" + strings.TrimLeft(exp[1:], "0")
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsString is String(v) for a decoded JSON value.
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return string(t)
		}
		return jsNumberString(f)
	case float64:
		return jsNumberString(t)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// truthy is JavaScript's `!!value` for a decoded JSON value.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0 && !math.IsNaN(f)
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int64:
		return x != 0
	case int:
		return x != 0
	default:
		return true
	}
}

// jsNumber is Number(string): surrounding whitespace is ignored, an empty
// string is 0, and anything unparsable is NaN.
func jsNumber(s string) float64 {
	s = strings.TrimFunc(s, isJSSpace)
	if s == "" {
		return 0
	}
	lower := strings.ToLower(s)
	for _, p := range []struct {
		prefix string
		base   int
	}{{"0x", 16}, {"0o", 8}, {"0b", 2}} {
		if strings.HasPrefix(lower, p.prefix) {
			n, ok := new(big.Int).SetString(s[2:], p.base)
			if !ok || strings.ContainsAny(s[2:], "+-_") {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r == '.' || r == 'e' || r == 'E' || r == '+' || r == '-') {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// toFixed is Number.prototype.toFixed(digits): an exact tie rounds away from zero.
func toFixed(f float64, digits int) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.Abs(f) >= 1e21 || math.IsInf(f, 0) {
		return jsNumberString(f)
	}
	exact := new(big.Float).SetPrec(0).SetFloat64(f)
	scaled := new(big.Float).SetPrec(2048).Mul(exact, new(big.Float).SetPrec(2048).SetFloat64(math.Pow10(digits)))
	scaled.Abs(scaled)
	whole, _ := scaled.Int(nil)
	frac := new(big.Float).SetPrec(2048).Sub(scaled, new(big.Float).SetPrec(2048).SetInt(whole))
	if frac.Cmp(big.NewFloat(0.5)) >= 0 {
		whole.Add(whole, big.NewInt(1))
	}
	s := whole.String()
	if digits > 0 {
		for len(s) <= digits {
			s = "0" + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if f < 0 {
		s = "-" + s
	}
	return s
}

// isJSSpace is the WhiteSpace and LineTerminator set that trim() and \s use.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// jsSlice is s.slice(0, n) counted in UTF-16 code units.
func jsSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			if w == 2 && units+1 == n {
				// A split surrogate pair: JavaScript keeps the lone high half,
				// which prints as the replacement character.
				return s[:i] + "�"
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// decodeUTF8 is TextDecoder('utf-8').decode: a leading BOM is dropped and
// each invalid byte becomes U+FFFD.
func decodeUTF8(b []byte) string {
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size <= 1 {
			sb.WriteRune(utf8.RuneError)
			b = b[1:]
			continue
		}
		sb.WriteRune(r)
		b = b[size:]
	}
	return sb.String()
}

// encodeURIComponent escapes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	var sb strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			sb.WriteByte(c)
			continue
		}
		fmt.Fprintf(&sb, "%%%02X", c)
	}
	return sb.String()
}

// formEscape is URLSearchParams serialization of one name or value.
func formEscape(s string) string {
	var sb strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("*-._", c) >= 0:
			sb.WriteByte(c)
		case c == ' ':
			sb.WriteByte('+')
		default:
			fmt.Fprintf(&sb, "%%%02X", c)
		}
	}
	return sb.String()
}

// query is URLSearchParams: pairs in insertion order, set() replaces in place.
type query struct {
	keys []string
	vals map[string]string
}

func newQuery() *query { return &query{vals: map[string]string{}} }

func (q *query) set(k, v string) {
	if _, ok := q.vals[k]; !ok {
		q.keys = append(q.keys, k)
	}
	q.vals[k] = v
}

func (q *query) String() string {
	parts := make([]string, len(q.keys))
	for i, k := range q.keys {
		parts[i] = formEscape(k) + "=" + formEscape(q.vals[k])
	}
	return strings.Join(parts, "&")
}
