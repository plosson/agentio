package falco

import (
	"regexp"
	"strings"
)

// Peppol UBL invoices may carry the rendered PDF as a base64-encoded
// <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="...">
// inside <cac:AdditionalDocumentReference> > <cac:Attachment>.
var embeddedRe = regexp.MustCompile(`(?is)<(?:[a-z]+:)?EmbeddedDocumentBinaryObject\b([^>]*)>(.*?)</(?:[a-z]+:)?EmbeddedDocumentBinaryObject>`)

var jsSpaces = regexp.MustCompile(`[\s\x{0b}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// readAttr reads an attribute in either quote style. Matching only double
// quotes made the mimeCode guard fail open and accept a non-PDF attachment.
func readAttr(attrs, name string) *string {
	re := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(name) + `\s*=\s*("([^"]*)"|'([^']*)')`)
	m := re.FindStringSubmatchIndex(attrs)
	if m == nil {
		return nil
	}
	for _, g := range []int{2, 3} {
		if m[2*g] >= 0 {
			v := attrs[m[2*g]:m[2*g+1]]
			return &v
		}
	}
	return nil
}

type embeddedPdf struct {
	filename *string
	bytes    []byte
}

// extractEmbeddedPdf returns the first embedded PDF, or nil when the sender
// embedded none. An attachment declaring a non-PDF mime code is skipped; one
// with no readable mimeCode is accepted, since omitting it is common.
func extractEmbeddedPdf(xml string) *embeddedPdf {
	for _, m := range embeddedRe.FindAllStringSubmatch(xml, -1) {
		attrs, body := m[1], m[2]
		if mime := readAttr(attrs, "mimeCode"); mime != nil && *mime != "" && !strings.HasPrefix(strings.ToLower(*mime), "application/pdf") {
			continue
		}
		b64 := jsSpaces.ReplaceAllString(body, "")
		if b64 == "" {
			continue
		}
		return &embeddedPdf{filename: readAttr(attrs, "filename"), bytes: decodeBase64Lenient(b64)}
	}
	return nil
}

// decodeBase64Lenient is Buffer.from(s, 'base64'): both alphabets, other
// characters skipped, decoding stops at the first '=', and a trailing partial
// group yields what bits it completes.
func decodeBase64Lenient(s string) []byte {
	var out []byte
	var acc uint32
	n := 0
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
			i = len(s)
			continue
		default:
			continue
		}
		acc = acc<<6 | uint32(v)
		n++
		if n == 4 {
			out = append(out, byte(acc>>16), byte(acc>>8), byte(acc))
			acc, n = 0, 0
		}
	}
	switch n {
	case 2:
		out = append(out, byte(acc>>4))
	case 3:
		out = append(out, byte(acc>>10), byte(acc>>2))
	}
	if out == nil {
		out = []byte{}
	}
	return out
}
