package jsvalue

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"strings"
	"unicode/utf8"
)

// IsSpace is the WhiteSpace and LineTerminator set that trim(), \s and
// parseInt skip. It differs from unicode.IsSpace: U+FEFF is in, U+0085 is out.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Trim is s.trim().
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// Slice is s.slice(0, n) counted in UTF-16 code units. A surrogate pair cut
// in half keeps its lone high half, which prints as U+FFFD.
func Slice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			if w == 2 && units+1 == n {
				return s[:i] + "\uFFFD"
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// Truncate is `s.length > n ? s.slice(0, n) + '...' : s`.
func Truncate(s string, n int) string {
	if sliced := Slice(s, n); sliced != s {
		return sliced + "..."
	}
	return s
}

// DecodeUTF8 is new TextDecoder('utf-8').decode(b): a leading BOM is dropped
// and each invalid byte becomes U+FFFD.
func DecodeUTF8(b []byte) string {
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

// EncodeURIComponent escapes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func EncodeURIComponent(s string) string {
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

// DecodeURIComponent is decodeURIComponent(s). ok is false where JavaScript
// throws a URIError: a "%" not followed by two hex digits, or escapes that do
// not decode to UTF-8 (an encoded surrogate included).
func DecodeURIComponent(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			out = append(out, s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", false
		}
		hi, lo := unhex(s[i+1]), unhex(s[i+2])
		if hi < 0 || lo < 0 {
			return "", false
		}
		out = append(out, byte(hi<<4|lo))
		i += 2
	}
	// Unescaped text is whole characters, so an escaped lead byte followed by
	// anything but its escaped continuation bytes fails here, as in JavaScript.
	if !utf8.Valid(out) {
		return "", false
	}
	return string(out), true
}

func unhex(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
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

// SearchParams is URLSearchParams: pairs in insertion order, Set replaces a
// value in place.
type SearchParams struct {
	keys []string
	vals map[string]string
}

// NewSearchParams is new URLSearchParams().
func NewSearchParams() *SearchParams { return &SearchParams{vals: map[string]string{}} }

// Set is params.set(k, v).
func (q *SearchParams) Set(k, v string) {
	if _, ok := q.vals[k]; !ok {
		q.keys = append(q.keys, k)
	}
	q.vals[k] = v
}

// String is params.toString().
func (q *SearchParams) String() string {
	parts := make([]string, len(q.keys))
	for i, k := range q.keys {
		parts[i] = formEscape(k) + "=" + formEscape(q.vals[k])
	}
	return strings.Join(parts, "&")
}

// Length is s.length: UTF-16 code units.
func Length(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// PadEnd is s.padEnd(n): spaces up to n UTF-16 code units.
func PadEnd(s string, n int) string {
	if l := Length(s); l < n {
		return s + strings.Repeat(" ", n-l)
	}
	return s
}

// BufferString is Buffer#toString('utf-8'): a BOM is kept and each maximal
// invalid subpart becomes one U+FFFD (a truncated "\xe2\x82" is one, where
// TextDecoder gives two).
func BufferString(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r != utf8.RuneError || size > 1 {
			sb.WriteRune(r)
			b = b[size:]
			continue
		}
		sb.WriteRune(utf8.RuneError)
		b = b[invalidSubpart(b):]
	}
	return sb.String()
}

// invalidSubpart is the length of the maximal subpart of an ill-formed
// sequence at b[0] (Unicode 3.9, "U+FFFD substitution of maximal subparts").
func invalidSubpart(b []byte) int {
	lead := b[0]
	var need int
	lo, hi := byte(0x80), byte(0xBF)
	switch {
	case lead >= 0xC2 && lead <= 0xDF:
		need = 1
	case lead == 0xE0:
		need, lo = 2, 0xA0
	case lead == 0xED:
		need, hi = 2, 0x9F
	case lead >= 0xE1 && lead <= 0xEF:
		need = 2
	case lead == 0xF0:
		need, lo = 3, 0x90
	case lead == 0xF4:
		need, hi = 3, 0x8F
	case lead >= 0xF1 && lead <= 0xF3:
		need = 3
	default:
		return 1
	}
	n := 1
	for n <= need && n < len(b) {
		c := b[n]
		if n > 1 {
			lo, hi = 0x80, 0xBF
		}
		if c < lo || c > hi {
			break
		}
		n++
	}
	return n
}

// DecodeBase64 is Buffer.from(s, 'base64'): the standard and URL-safe
// alphabets both decode, other characters are skipped, and "=" ends the input.
func DecodeBase64(s string) []byte {
	out := make([]byte, 0, len(s)*3/4)
	var acc uint32
	bits := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		var v byte
		switch {
		case c >= 'A' && c <= 'Z':
			v = c - 'A'
		case c >= 'a' && c <= 'z':
			v = c - 'a' + 26
		case c >= '0' && c <= '9':
			v = c - '0' + 52
		case c == '+' || c == '-':
			v = 62
		case c == '/' || c == '_':
			v = 63
		case c == '=':
			return out
		default:
			continue
		}
		acc = acc<<6 | uint32(v)
		bits += 6
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(acc>>bits))
		}
	}
	return out
}

// RandomUUID is crypto.randomUUID(): a version 4 UUID in lowercase hex.
func RandomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
