package falco

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// A port of the fast-xml-parser 5 XMLParser that Bun's parseUbl builds, with
// its options: ignoreAttributes false, attributeNamePrefix "@_",
// removeNSPrefix, htmlEntities, no value parsing, trimValues. It does not
// validate: the declared encoding is ignored (the caller decodes as UTF-8), a
// bare & or an unknown entity stays literal, control characters pass through,
// and a closing tag closes the current element whatever its name.

// fxEntry is one child of an element: text when node is nil.
type fxEntry struct {
	text string
	node *fxNode
}

type fxNode struct {
	tag      string
	children []fxEntry
	attrs    *jsvalue.Object
}

// fxParser is the per-document state of OrderedObjParser.
type fxParser struct {
	src        string
	entities   map[string]string // DOCTYPE entities
	xml11      bool              // <?xml version="1.1"?> lets C0 references through
	expanded   int               // growth from entity expansion, capped at maxExpandedLength
	doctype    bool
	isArrayTag func(string) bool
}

const (
	fxMaxNestedTags     = 100
	fxMaxExpandedLength = 100000
	fxMaxEntitySize     = 10000
	fxMaxEntityCount    = 1000
)

// fxNamedEntities is XML plus COMMON_HTML and CURRENCY from @nodable/entities,
// the set htmlEntities: true selects.
var fxNamedEntities = map[string]string{
	"amp": "&", "apos": "'", "gt": ">", "lt": "<", "quot": "\"",
	"nbsp": " ", "copy": "©", "reg": "®", "trade": "™", "mdash": "—", "ndash": "–",
	"hellip": "…", "laquo": "«", "raquo": "»", "lsquo": "‘", "rsquo": "’", "ldquo": "“",
	"rdquo": "”", "bull": "•", "para": "¶", "sect": "§", "deg": "°", "frac12": "½",
	"frac14": "¼", "frac34": "¾",
	"cent": "¢", "pound": "£", "curren": "¤", "yen": "¥", "euro": "€", "dollar": "$", "fnof": "ƒ", "inr": "₹",
	"af": "؋", "birr": "ብር", "peso": "₱", "rub": "₽", "won": "₩", "yuan": "¥", "cedil": "¸",
}

// parseFastXML is new XMLParser(options).parse(src) with isArray reporting the
// tags that are always arrays.
func parseFastXML(src string, isArrayTag func(string) bool) (*jsvalue.Object, error) {
	p := &fxParser{src: strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(src), isArrayTag: isArrayTag}
	root, err := p.parse()
	if err != nil {
		return nil, err
	}
	return p.compress(root.children), nil
}

func (p *fxParser) parse() (*fxNode, error) {
	s := p.src
	root := &fxNode{tag: "!xml"}
	current := root
	var stack []*fxNode
	var text strings.Builder
	at := func(i int) byte {
		if i < len(s) {
			return s[i]
		}
		return 0
	}
	for i := 0; i < len(s); i++ {
		if s[i] != '<' {
			text.WriteByte(s[i])
			continue
		}
		switch {
		case at(i+1) == '/':
			closeIndex, err := fxClosingIndex(s, ">", i, "Closing Tag is not closed.")
			if err != nil {
				return nil, err
			}
			tagName := jsvalue.Trim(s[i+2 : closeIndex])
			if c := strings.IndexByte(tagName, ':'); c != -1 {
				tagName = tagName[c+1:]
			}
			if _, err := fxSanitize(tagName); err != nil {
				return nil, err
			}
			if err := p.saveText(&text, current); err != nil {
				return nil, err
			}
			current = root
			if n := len(stack); n > 0 {
				current, stack = stack[n-1], stack[:n-1]
			}
			i = closeIndex
		case at(i+1) == '?':
			tag, ok := fxReadTagExp(s, i, false, "?>")
			if !ok {
				return nil, errors.New("Pi Tag is not closed.")
			}
			if err := p.saveText(&text, current); err != nil {
				return nil, err
			}
			attrs, err := p.attributes(tag.exp)
			if err != nil {
				return nil, err
			}
			if attrs != nil {
				version, _ := attrs.Str("@_version")
				p.xml11 = jsvalue.Number(version) == 1.1
			}
			child := &fxNode{tag: tag.name, children: []fxEntry{{text: ""}}}
			if tag.name != tag.exp && tag.attrExpPresent {
				child.attrs = attrs
			}
			current.children = append(current.children, fxEntry{node: child})
			i = tag.closeIndex + 1
		case at(i+1) == '!' && at(i+2) == '-' && at(i+3) == '-':
			end, err := fxClosingIndex(s, "-->", i+4, "Comment is not closed.")
			if err != nil {
				return nil, err
			}
			i = end
		case at(i+1) == '!' && at(i+2) == 'D':
			if p.doctype {
				return nil, errors.New("Multiple DOCTYPE declarations found.")
			}
			p.doctype = true
			end, err := p.readDocType(i)
			if err != nil {
				return nil, err
			}
			i = end
		case at(i+1) == '!' && at(i+2) == '[':
			end, err := fxClosingIndex(s, "]]>", i, "CDATA is not closed.")
			if err != nil {
				return nil, err
			}
			closeIndex := end - 2
			if err := p.saveText(&text, current); err != nil {
				return nil, err
			}
			// substring(i + 9, closeIndex), which swaps reversed bounds.
			from, to := min(i+9, len(s)), closeIndex
			if from > to {
				from, to = to, from
			}
			current.children = append(current.children, fxEntry{text: s[from:to]})
			i = closeIndex + 2
		default:
			tag, ok := fxReadTagExp(s, i, true, ">")
			if !ok {
				pos := jsvalue.Length(s[:i])
				units := utf16.Encode([]rune(s))
				context := string(utf16.Decode(units[max(0, pos-50):min(len(units), pos+50)]))
				return nil, fmt.Errorf("readTagExp returned undefined at position %d. Context: \"%s\"", pos, context)
			}
			tagName, tagExp, attrExpPresent := tag.name, tag.exp, tag.attrExpPresent
			tagName, err := fxSanitize(tagName)
			if err != nil {
				return nil, err
			}
			if tagName == "#text" {
				return nil, fmt.Errorf("Invalid tag name: %s", tagName)
			}
			if text.Len() > 0 && current.tag != "!xml" {
				if err := p.saveText(&text, current); err != nil {
					return nil, err
				}
			}
			selfClosing := false
			if tagExp != "" && tagExp[len(tagExp)-1] == '/' {
				selfClosing = true
				if tagName != "" && tagName[len(tagName)-1] == '/' {
					tagName = tagName[:len(tagName)-1]
					tagExp = tagName
				} else {
					tagExp = tagExp[:len(tagExp)-1]
				}
				attrExpPresent = tagName != tagExp
			}
			child := &fxNode{tag: tagName}
			if tagName != tagExp && attrExpPresent {
				if child.attrs, err = p.attributes(tagExp); err != nil {
					return nil, err
				}
			}
			if selfClosing {
				if tagName, err = fxSanitize(tagName); err != nil {
					return nil, err
				}
				child.tag = tagName
				current.children = append(current.children, fxEntry{node: child})
			} else {
				if len(stack) > fxMaxNestedTags {
					return nil, errors.New("Maximum nested tags exceeded")
				}
				stack = append(stack, current)
				current.children = append(current.children, fxEntry{node: child})
				current = child
			}
			text.Reset()
			i = tag.closeIndex
		}
	}
	return root, nil
}

// saveText is saveTextToParentTag: collected text is trimmed, its entities
// decoded, and kept when anything is left.
func (p *fxParser) saveText(text *strings.Builder, parent *fxNode) error {
	if text.Len() == 0 {
		return nil
	}
	val := jsvalue.Trim(text.String())
	text.Reset()
	if val == "" {
		return nil
	}
	val, err := p.decode(val)
	if err != nil {
		return err
	}
	if val != "" {
		parent.children = append(parent.children, fxEntry{text: val})
	}
	return nil
}

// fxAttrRe is fast-xml-parser's attribute pattern with JavaScript's \s.
var fxAttrRe = regexp.MustCompile(`([^` + fxJSSpace + `=]+)[` + fxJSSpace + `]*(=[` + fxJSSpace + `]*(?:"([\s\S]*?)"|'([\s\S]*?)'))?`)

const fxJSSpace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// attributes is buildAttributesMap: nil when no attribute has a value.
func (p *fxParser) attributes(exp string) (*jsvalue.Object, error) {
	var attrs *jsvalue.Object
	for _, m := range fxAttrRe.FindAllStringSubmatchIndex(exp, -1) {
		if m[4] == -1 {
			continue // no value: allowBooleanAttributes is off
		}
		name := exp[m[2]:m[3]]
		if parts := strings.Split(name, ":"); parts[0] == "xmlns" {
			continue
		} else if len(parts) == 2 {
			name = parts[1]
		}
		if name == "" {
			continue
		}
		start, end := m[6], m[7]
		if start == -1 {
			start, end = m[8], m[9]
		}
		raw := exp[start:end]
		val, err := p.decode(jsvalue.Trim(raw))
		if err != nil {
			return nil, err
		}
		if attrs == nil {
			attrs = jsvalue.NewObject()
		}
		attrs.Set("@_"+name, val)
	}
	return attrs, nil
}

// compress is node2json: a single text child becomes the element's value, a
// repeated or listed tag becomes an array, attributes sit beside "#text".
func (p *fxParser) compress(children []fxEntry) *jsvalue.Object {
	obj := jsvalue.NewObject()
	var text *string
	for _, c := range children {
		if c.node == nil {
			if text == nil {
				t := c.text
				text = &t
			} else {
				*text += c.text
			}
			continue
		}
		inner := p.compress(c.node.children)
		var val any = inner
		switch keys := inner.Keys(); {
		case c.node.attrs != nil:
			for _, k := range c.node.attrs.Keys() {
				v, _ := c.node.attrs.Get(k)
				inner.Set(k, v)
			}
		case len(keys) == 1 && keys[0] == "#text":
			val, _ = inner.Get("#text")
		case len(keys) == 0:
			val = ""
		}
		existing, present := obj.Get(c.node.tag)
		switch {
		case present:
			arr, ok := existing.([]any)
			if !ok {
				arr = []any{existing}
			}
			obj.Set(c.node.tag, append(arr, val))
		case p.isArrayTag(c.node.tag):
			obj.Set(c.node.tag, []any{val})
		default:
			obj.Set(c.node.tag, val)
		}
	}
	if text != nil && *text != "" {
		obj.Set("#text", *text)
	}
	return obj
}

// decode is EntityDecoder.decode: named and numeric references resolve,
// anything else, a bare & included, stays as written.
func (p *fxParser) decode(s string) (string, error) {
	if !strings.Contains(s, "&") {
		return s, nil
	}
	var out strings.Builder
	last := 0
	for i := 0; i < len(s); {
		if s[i] != '&' {
			i++
			continue
		}
		// The reference must close within 32 UTF-16 units of the &.
		j, units := i+1, 1
		for j < len(s) && s[j] != ';' && units <= 32 {
			r, size := utf8.DecodeRuneInString(s[j:])
			j += size
			units += utf16.RuneLen(r)
		}
		if j >= len(s) || s[j] != ';' || units > 33 || j == i+1 {
			i++
			continue
		}
		token := s[i+1 : j]
		var replacement string
		var ok bool
		if token[0] == '#' {
			replacement, ok = p.numericReference(token)
		} else if replacement, ok = p.entities[token]; !ok {
			replacement, ok = fxNamedEntities[token]
		}
		if !ok {
			i++
			continue
		}
		out.WriteString(s[last:i])
		out.WriteString(replacement)
		last = j + 1
		i = last
		if delta := jsvalue.Length(replacement) - (jsvalue.Length(token) + 2); delta > 0 {
			p.expanded += delta
			if p.expanded > fxMaxExpandedLength {
				return "", fmt.Errorf("[EntityReplacer] Expanded content length limit exceeded: %d > %d", p.expanded, fxMaxExpandedLength)
			}
		}
	}
	out.WriteString(s[last:])
	return out.String(), nil
}

// numericReference is _resolveNCR: an out-of-range code point stays literal,
// NUL, a surrogate and (in XML 1.0) a C0 control other than tab, LF and CR
// are removed.
func (p *fxParser) numericReference(token string) (string, bool) {
	var cp float64
	if len(token) > 1 && (token[1] == 'x' || token[1] == 'X') {
		cp = jsvalue.ParseIntRadix(token[2:], 16)
	} else {
		cp = jsvalue.ParseInt(token[1:])
	}
	if math.IsNaN(cp) || cp < 0 || cp > 0x10FFFF {
		return "", false
	}
	switch c := rune(cp); {
	case c == 0, c >= 0xD800 && c <= 0xDFFF:
		return "", true
	case !p.xml11 && c >= 0x01 && c <= 0x1F && c != 0x09 && c != 0x0A && c != 0x0D:
		return "", true
	default:
		return string(c), true
	}
}

type fxTag struct {
	name, exp      string
	closeIndex     int
	attrExpPresent bool
}

// fxReadTagExp is readTagExp: the tag runs to the closing sequence outside
// quotes; the name ends at the first whitespace.
func fxReadTagExp(s string, i int, removeNSPrefix bool, closing string) (fxTag, bool) {
	var data strings.Builder
	quote := byte(0)
	closeIndex := -1
	for k := i + 1; k < len(s); k++ {
		c := s[k]
		if quote != 0 {
			if c == quote {
				quote = 0
			}
		} else if c == '"' || c == '\'' {
			quote = c
		} else if c == closing[0] && (len(closing) == 1 || (k+1 < len(s) && s[k+1] == closing[1])) {
			closeIndex = k
			break
		} else if c == '\t' {
			data.WriteByte(' ')
			continue
		}
		data.WriteByte(c)
	}
	if closeIndex == -1 {
		return fxTag{}, false
	}
	full := data.String()
	tag := fxTag{name: full, exp: full, closeIndex: closeIndex, attrExpPresent: true}
	if sep := strings.IndexFunc(full, jsvalue.IsSpace); sep != -1 {
		_, size := utf8.DecodeRuneInString(full[sep:])
		tag.name = full[:sep]
		tag.exp = strings.TrimLeftFunc(full[sep+size:], jsvalue.IsSpace)
	}
	if removeNSPrefix {
		if c := strings.IndexByte(tag.name, ':'); c != -1 {
			tag.name = tag.name[c+1:]
			tag.attrExpPresent = tag.name != full[c+1:]
		}
	}
	return tag, true
}

// fxClosingIndex is findClosingIndex: the index of the last character of
// the first str at or after i.
func fxClosingIndex(s, str string, i int, msg string) (int, error) {
	if i > len(s) {
		i = len(s)
	}
	k := strings.Index(s[i:], str)
	if k == -1 {
		return 0, errors.New(msg)
	}
	return i + k + len(str) - 1, nil
}

// fxSanitize is sanitizeName for a tag name.
func fxSanitize(name string) (string, error) {
	switch name {
	case "__proto__", "constructor", "prototype":
		return "", fmt.Errorf("[SECURITY] Invalid name: \"%s\" is a reserved JavaScript keyword that could cause prototype pollution", name)
	case "hasOwnProperty", "toString", "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__":
		return "__" + name, nil
	}
	return name, nil
}

// fxNCName is xml-naming's XML 1.0 NCName; fxQName allows one prefix.
const fxNCName = `[A-Za-z_\x{C0}-\x{D6}\x{D8}-\x{F6}\x{F8}-\x{2FF}\x{370}-\x{37D}\x{37F}-\x{486}\x{488}-\x{1FFF}\x{200C}-\x{200D}` +
	`\x{2070}-\x{218F}\x{2C00}-\x{2FEF}\x{3001}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFFD}]` +
	`[A-Za-z_\x{C0}-\x{D6}\x{D8}-\x{F6}\x{F8}-\x{2FF}\x{370}-\x{37D}\x{37F}-\x{486}\x{488}-\x{1FFF}\x{200C}-\x{200D}` +
	`\x{2070}-\x{218F}\x{2C00}-\x{2FEF}\x{3001}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFFD}\-.0-9\x{B7}\x{300}-\x{36F}\x{203F}-\x{2040}]*`

var fxQName = regexp.MustCompile(`^` + fxNCName + `(?::` + fxNCName + `)?$`)

// fxUnsafeEntity is is-unsafe's HTML and XML patterns: a DOCTYPE entity whose
// value matches one is dropped.
var fxUnsafeEntity = func() []*regexp.Regexp {
	sp := `[` + fxJSSpace + `]`
	var out []*regexp.Regexp
	for _, p := range []string{
		`(?i)<script[` + fxJSSpace + `>/]`, `(?i)</script[` + fxJSSpace + `>]`,
		`(?i)j[\t\n\r ]*a[\t\n\r ]*v[\t\n\r ]*a[\t\n\r ]*s[\t\n\r ]*c[\t\n\r ]*r[\t\n\r ]*i[\t\n\r ]*p[\t\n\r ]*t[\t\n\r ]*:`,
		`(?i)vbscript[\t\n\r ]*:`, `(?i)data[\t\n\r ]*:[\t\n\r ]*text/html`, `(?i)data[\t\n\r ]*:[\t\n\r ]*application/xhtml`,
		`(?i)data[\t\n\r ]*:[\t\n\r ]*image/svg\+xml`, `(?i)\bon\w{1,30}` + sp + `*=`,
		`(?i)(?:&#x0*3[Cc];?|&#0*60;?|&lt;)` + sp + `*script`,
		`(?i)(?:&#x0*6[Aa];?|&#0*106;?)` + sp + `*(?:&#x0*61;?|a)[\s\S]{0,80}script` + sp + `*:`,
		`(?i)style[\s\S]{0,20}expression` + sp + `*\(`, `(?i)<(?:object|embed)[` + fxJSSpace + `>/]`, `(?i)<base[` + fxJSSpace + `>]`,
		`(?i)<meta[\s\S]{0,40}http-equiv[\s\S]{0,20}refresh`, `(?i)srcdoc` + sp + `*=`, `(?i)<iframe[` + fxJSSpace + `>/]`,
		`(?i)<form[` + fxJSSpace + `>/]`,
		`(?i)<!\[CDATA\[`, `\]\]>`, `(?i)<\?(?:xml[\- ]|php|asp)`, `(?i)<!DOCTYPE(?:[` + fxJSSpace + `\[]|$)`,
		`(?i)\bSYSTEM` + sp + `+["']`, `(?i)\bPUBLIC` + sp + `+["']`, `(?i)<!ENTITY[` + fxJSSpace + `%]`, `(?:&\w{1,20};){3,}`,
		`(?i)\bxmlns(?::\w{1,40})?` + sp + `*=`, `<!--`, `-->`, `\?>`,
	} {
		out = append(out, regexp.MustCompile(p))
	}
	return out
}()

// readDocType is DocTypeReader.readDocType: it skips the declaration and
// keeps the internal entities, returning the index of its closing '>'.
func (p *fxParser) readDocType(i int) (int, error) {
	s := p.src
	at := func(k int) byte {
		if k < len(s) {
			return s[k]
		}
		return 0
	}
	if !strings.HasPrefix(s[min(i+3, len(s)):], "OCTYPE") {
		return 0, errors.New("Invalid Tag instead of DOCTYPE")
	}
	entities := map[string]string{}
	count := 0
	depth, hasBody, comment := 1, false, false
	quote := byte(0)
	for i += 9; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if !hasBody && !comment && (c == '"' || c == '\'') {
			quote = c
			continue
		}
		switch {
		case c == '<' && !comment:
			var err error
			switch rest := s[i+1:]; {
			case hasBody && strings.HasPrefix(rest, "!ENTITY"):
				var name, val string
				if name, val, i, err = p.readEntity(i + 8); err != nil {
					return 0, err
				}
				if !strings.Contains(val, "&") {
					if count >= fxMaxEntityCount {
						return 0, fmt.Errorf("Entity count (%d) exceeds maximum allowed (%d)", count+1, fxMaxEntityCount)
					}
					entities[name] = val
					count++
				}
			case hasBody && strings.HasPrefix(rest, "!ELEMENT"):
				if i, err = p.readElementDecl(i + 9); err != nil {
					return 0, err
				}
			case hasBody && strings.HasPrefix(rest, "!ATTLIST"):
				i += 8
			case hasBody && strings.HasPrefix(rest, "!NOTATION"):
				if i, err = p.readNotation(i + 10); err != nil {
					return 0, err
				}
			case strings.HasPrefix(rest, "!--"):
				comment = true
			default:
				return 0, errors.New("Invalid DOCTYPE")
			}
			depth++
		case c == '>':
			if comment {
				if at(i-1) == '-' && at(i-2) == '-' {
					comment = false
					depth--
				}
			} else {
				depth--
			}
		case c == '[':
			hasBody = true
		}
		if depth == 0 {
			break
		}
	}
	if quote != 0 || depth != 0 {
		return 0, errors.New("Unclosed DOCTYPE")
	}
	p.entities = map[string]string{}
	for name, val := range entities {
		if !slices.ContainsFunc(fxUnsafeEntity, func(re *regexp.Regexp) bool { return re.MatchString(val) }) {
			p.entities[name] = val
		}
	}
	p.expanded = 0
	return i, nil
}

func (p *fxParser) skipSpace(i int) int {
	for i < len(p.src) {
		r, size := utf8.DecodeRuneInString(p.src[i:])
		if !jsvalue.IsSpace(r) {
			break
		}
		i += size
	}
	return i
}

// readName reads up to whitespace, or also up to a quote when stopAtQuote.
func (p *fxParser) readName(i int, stopAtQuote bool) (string, int) {
	start := i
	for i < len(p.src) {
		r, size := utf8.DecodeRuneInString(p.src[i:])
		if jsvalue.IsSpace(r) || stopAtQuote && (r == '"' || r == '\'') {
			break
		}
		i += size
	}
	return p.src[start:i], i
}

// readQuoted is readIdentifierVal: the index after the closing quote and the
// text between the quotes.
func (p *fxParser) readQuoted(i int, what string) (int, string, error) {
	if i >= len(p.src) {
		return 0, "", errors.New(`Expected quoted string, found "undefined"`)
	}
	q := p.src[i]
	if q != '"' && q != '\'' {
		r, _ := utf8.DecodeRuneInString(p.src[i:])
		return 0, "", fmt.Errorf(`Expected quoted string, found "%c"`, r)
	}
	end := strings.IndexByte(p.src[i+1:], q)
	if end == -1 {
		return 0, "", fmt.Errorf("Unterminated %s value", what)
	}
	return i + 1 + end + 1, p.src[i+1 : i+1+end], nil
}

// readEntity is readEntityExp, returning the index of the closing quote.
func (p *fxParser) readEntity(i int) (string, string, int, error) {
	name, i := p.readName(p.skipSpace(i), true)
	if !fxQName.MatchString(name) {
		return "", "", 0, fmt.Errorf("Invalid entity name %s", name)
	}
	i = p.skipSpace(i)
	if strings.ToUpper(p.src[i:min(i+6, len(p.src))]) == "SYSTEM" {
		return "", "", 0, errors.New("External entities are not supported")
	} else if i < len(p.src) && p.src[i] == '%' {
		return "", "", 0, errors.New("Parameter entities are not supported")
	}
	i, val, err := p.readQuoted(i, "entity")
	if err != nil {
		return "", "", 0, err
	}
	if n := jsvalue.Length(val); n > fxMaxEntitySize {
		return "", "", 0, fmt.Errorf("Entity \"%s\" size (%d) exceeds maximum allowed size (%d)", name, n, fxMaxEntitySize)
	}
	return name, val, i - 1, nil
}

// readElementDecl is readElementExp, returning the index of its last character.
func (p *fxParser) readElementDecl(i int) (int, error) {
	name, i := p.readName(p.skipSpace(i), false)
	if !fxQName.MatchString(name) {
		return 0, fmt.Errorf("Invalid element name: \"%s\"", name)
	}
	i = p.skipSpace(i)
	rest := p.src[i:]
	switch {
	case strings.HasPrefix(rest, "EMPTY"):
		return i + 4, nil
	case strings.HasPrefix(rest, "ANY"):
		return i + 2, nil
	case strings.HasPrefix(rest, "("):
		end := strings.IndexByte(rest, ')')
		if end == -1 {
			return 0, errors.New("Unterminated content model")
		}
		return i + end, nil
	case rest == "":
		return 0, errors.New(`Invalid Element Expression, found "undefined"`)
	}
	r, _ := utf8.DecodeRuneInString(rest)
	return 0, fmt.Errorf(`Invalid Element Expression, found "%c"`, r)
}

// readNotation is readNotationExp, returning the index of its last character.
func (p *fxParser) readNotation(i int) (int, error) {
	name, i := p.readName(p.skipSpace(i), false)
	if !fxQName.MatchString(name) {
		return 0, fmt.Errorf("Invalid entity name %s", name)
	}
	i = p.skipSpace(i)
	kind := strings.ToUpper(p.src[i:min(i+6, len(p.src))])
	if kind != "SYSTEM" && kind != "PUBLIC" {
		return 0, fmt.Errorf("Expected SYSTEM or PUBLIC, found \"%s\"", kind)
	}
	i = p.skipSpace(i + len(kind))
	var err error
	var id string
	if kind == "PUBLIC" {
		if i, _, err = p.readQuoted(i, "publicIdentifier"); err != nil {
			return 0, err
		}
		if i = p.skipSpace(i); i < len(p.src) && (p.src[i] == '"' || p.src[i] == '\'') {
			if i, _, err = p.readQuoted(i, "systemIdentifier"); err != nil {
				return 0, err
			}
		}
	} else {
		if i, id, err = p.readQuoted(i, "systemIdentifier"); err != nil {
			return 0, err
		}
		if id == "" {
			return 0, errors.New("Missing mandatory system identifier for SYSTEM notation")
		}
	}
	return i - 1, nil
}
