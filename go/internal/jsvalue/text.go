package jsvalue

import (
	"bytes"
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
