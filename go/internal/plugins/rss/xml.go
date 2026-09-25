package rss

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// parseXML is xml2js.parseString with the options rss-parser leaves at their
// defaults, over sax in strict mode. The result is {rootName: value}, where
// an element is a string when it only holds text, and otherwise an *Object
// whose "_" is its text, "$" its attributes, and every other key an []any of
// its children with that name.
//
// xml2js settles on the first of two events: sax reporting an error, or the
// root element closing. So any error before the root closes rejects the
// document, and anything after it (trailing text, a second root) is ignored.
func parseXML(doc string) (*jsvalue.Object, error) {
	if jsvalue.Trim(doc) == "" {
		return nil, errors.New("Unable to parse XML.")
	}
	p := &saxParser{state: sBegin, quote: noQuote}
	for _, c := range strings.TrimPrefix(doc, "\uFEFF") {
		if c == '\n' {
			p.line++
			p.column = 0
		} else {
			p.column++
			if c > 0xFFFF {
				p.column++ // sax counts UTF-16 code units
			}
		}
		p.c = c
		if err := p.step(c); err != nil {
			return nil, err
		}
		if p.result != nil {
			return p.result, nil
		}
	}
	// sax end(): an open root, or input that stops inside markup, fails.
	if p.sawRoot && !p.closedRoot {
		p.c = 0
		return nil, p.fail("Unclosed root tag")
	}
	if p.state != sBegin && p.state != sBeginWhitespace && p.state != sText {
		p.c = 0
		return nil, p.fail("Unexpected end")
	}
	return nil, errors.New("Unable to parse XML.")
}

type saxState int

const (
	sBegin saxState = iota
	sBeginWhitespace
	sText
	sTextEntity
	sOpenWaka
	sSGMLDecl
	sSGMLDeclQuoted
	sDoctype
	sDoctypeQuoted
	sDoctypeDTD
	sDoctypeDTDQuoted
	sComment
	sCommentEnding
	sCommentEnded
	sCDATA
	sCDATAEnding
	sCDATAEnding2
	sProcInst
	sProcInstBody
	sProcInstEnding
	sOpenTag
	sOpenTagSlash
	sAttrib
	sAttribName
	sAttribNameSawWhite
	sAttribValue
	sAttribValueQuoted
	sAttribValueClosed
	sAttribValueEntityQ
	sCloseTag
	sCloseTagSawWhite
)

// element is an open xml2js node. children also holds xml2js's CDATA
// marker, a "cdata" key set to true, which collides with a child element
// named cdata exactly as it does in xml2js.
type element struct {
	name     string
	text     strings.Builder
	attrs    *jsvalue.Object
	children *jsvalue.Object
}

func (e *element) set(key string, v any) {
	if e.children == nil {
		e.children = jsvalue.NewObject()
	}
	e.children.Set(key, v)
}

type saxParser struct {
	state      saxState
	stack      []*element
	sawRoot    bool
	closedRoot bool
	doctype    string
	sawDoctype bool
	sgmlDecl   string
	quote      rune
	tagName    string
	attrName   string
	attrValue  strings.Builder
	tag        *element
	entity     string
	cdata      strings.Builder
	result     *jsvalue.Object

	line, column int
	c            rune
}

// fail is sax error(): the message with the position of the current char.
func (p *saxParser) fail(msg string) error {
	char := ""
	if p.c != 0 {
		char = string(p.c)
	}
	return fmt.Errorf("%s\nLine: %d\nColumn: %d\nChar: %s", msg, p.line, p.column, char)
}

// noQuote is sax's empty parser.q, which no character equals.
const noQuote rune = -1

func isXMLSpace(c rune) bool { return c == ' ' || c == '\n' || c == '\r' || c == '\t' }
func isQuote(c rune) bool    { return c == '"' || c == '\'' }

// nameStart and nameBody are sax's per-code-unit classes; an astral
// character is two surrogates to sax and never matches.
func nameStart(c rune) bool {
	switch {
	case c == ':' || c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'):
		return true
	case c >= 0xC0 && c <= 0xD6, c >= 0xD8 && c <= 0xF6, c >= 0xF8 && c <= 0x2FF,
		c >= 0x370 && c <= 0x37D, c >= 0x37F && c <= 0x1FFF, c >= 0x200C && c <= 0x200D,
		c >= 0x2070 && c <= 0x218F, c >= 0x2C00 && c <= 0x2FEF, c >= 0x3001 && c <= 0xD7FF,
		c >= 0xF900 && c <= 0xFDCF, c >= 0xFDF0 && c <= 0xFFFD:
		return true
	}
	return false
}

func nameBody(c rune) bool {
	return nameStart(c) || c == 0xB7 || (c >= 0x300 && c <= 0x36F) || (c >= 0x203F && c <= 0x2040) ||
		c == '.' || (c >= '0' && c <= '9') || c == '-'
}

func entityStart(c rune) bool { return c == '#' || nameStart(c) }
func entityBody(c rune) bool  { return c == '#' || nameBody(c) }

func (p *saxParser) top() *element {
	if len(p.stack) == 0 {
		return nil
	}
	return p.stack[len(p.stack)-1]
}

// addText is xml2js ontext: text goes to the innermost open element, and
// is dropped outside the root.
func (p *saxParser) addText(s string) {
	if e := p.top(); e != nil {
		e.text.WriteString(s)
	}
}

func (p *saxParser) step(c rune) error {
	switch p.state {
	case sBegin:
		p.state = sBeginWhitespace
		if c == '\uFEFF' {
			return nil
		}
		return p.beginWhitespace(c)
	case sBeginWhitespace:
		return p.beginWhitespace(c)
	case sText:
		if p.sawRoot && !p.closedRoot {
			switch c {
			case '<':
				p.state = sOpenWaka
			case '&':
				p.state = sTextEntity
			default:
				p.addText(string(c))
			}
			return nil
		}
		if c == '<' {
			p.state = sOpenWaka
			return nil
		}
		if !isXMLSpace(c) {
			return p.fail("Text data outside of root node.")
		}
	case sOpenWaka:
		switch {
		case c == '!':
			p.state = sSGMLDecl
			p.sgmlDecl = ""
		case isXMLSpace(c):
		case nameStart(c):
			p.state = sOpenTag
			p.tagName = string(c)
		case c == '/':
			p.state = sCloseTag
			p.tagName = ""
		case c == '?':
			p.state = sProcInst
		default:
			return p.fail("Unencoded <")
		}
	case sSGMLDecl:
		decl := p.sgmlDecl + string(c)
		switch {
		case decl == "--":
			p.state = sComment
			p.sgmlDecl = ""
		case p.doctype != "" && !p.sawDoctype && p.sgmlDecl != "":
			// Inside an internal DTD subset: sax keeps reading the DTD.
			p.state = sDoctypeDTD
			p.doctype += "<!" + decl
			p.sgmlDecl = ""
		case strings.ToUpper(decl) == "[CDATA[":
			p.state = sCDATA
			p.sgmlDecl = ""
			p.cdata.Reset()
		case strings.ToUpper(decl) == "DOCTYPE":
			p.state = sDoctype
			if p.sawDoctype || p.doctype != "" || p.sawRoot {
				return p.fail("Inappropriately located doctype declaration")
			}
			p.doctype = ""
			p.sgmlDecl = ""
		case c == '>':
			p.sgmlDecl = ""
			p.state = sText
		case isQuote(c):
			// sax does not record which quote opened: p.quote is still
			// noQuote, so the declaration never ends.
			p.state = sSGMLDeclQuoted
			p.sgmlDecl = decl
		default:
			p.sgmlDecl = decl
		}
	case sSGMLDeclQuoted:
		if c == p.quote {
			p.state = sSGMLDecl
			p.quote = noQuote
		}
		p.sgmlDecl += string(c)
	case sDoctype:
		if c == '>' {
			p.state = sText
			p.sawDoctype = true
			p.doctype = ""
			return nil
		}
		p.doctype += string(c)
		if c == '[' {
			p.state = sDoctypeDTD
		} else if isQuote(c) {
			p.state = sDoctypeQuoted
			p.quote = c
		}
	case sDoctypeQuoted:
		p.doctype += string(c)
		if c == p.quote {
			p.quote = noQuote
			p.state = sDoctype
		}
	case sDoctypeDTD:
		switch {
		case c == ']':
			p.doctype += string(c)
			p.state = sDoctype
		case c == '<':
			p.state = sOpenWaka
		case isQuote(c):
			p.doctype += string(c)
			p.state = sDoctypeDTDQuoted
			p.quote = c
		default:
			p.doctype += string(c)
		}
	case sDoctypeDTDQuoted:
		p.doctype += string(c)
		if c == p.quote {
			p.state = sDoctypeDTD
			p.quote = noQuote
		}
	case sComment:
		if c == '-' {
			p.state = sCommentEnding
		}
	case sCommentEnding:
		if c == '-' {
			p.state = sCommentEnded
		} else {
			p.state = sComment
		}
	case sCommentEnded:
		switch {
		case c != '>':
			return p.fail("Malformed comment")
		case p.doctype != "" && !p.sawDoctype:
			p.state = sDoctypeDTD
		default:
			p.state = sText
		}
	case sCDATA:
		if c == ']' {
			p.state = sCDATAEnding
		} else {
			p.cdata.WriteRune(c)
		}
	case sCDATAEnding:
		if c == ']' {
			p.state = sCDATAEnding2
		} else {
			p.cdata.WriteString("]" + string(c))
			p.state = sCDATA
		}
	case sCDATAEnding2:
		switch c {
		case '>':
			if p.cdata.Len() > 0 {
				if e := p.top(); e != nil {
					e.text.WriteString(p.cdata.String())
					e.set("cdata", true)
				}
			}
			p.cdata.Reset()
			p.state = sText
		case ']':
			p.cdata.WriteString("]")
		default:
			p.cdata.WriteString("]]" + string(c))
			p.state = sCDATA
		}
	case sProcInst:
		if c == '?' {
			p.state = sProcInstEnding
		} else if isXMLSpace(c) {
			p.state = sProcInstBody
		}
	case sProcInstBody:
		if c == '?' {
			p.state = sProcInstEnding
		}
	case sProcInstEnding:
		if c == '>' {
			p.state = sText
		} else {
			p.state = sProcInstBody
		}
	case sOpenTag:
		if nameBody(c) {
			p.tagName += string(c)
			return nil
		}
		p.tag = &element{name: p.tagName}
		switch {
		case c == '>':
			return p.openTag(false)
		case c == '/':
			p.state = sOpenTagSlash
		case !isXMLSpace(c):
			return p.fail("Invalid character in tag name")
		default:
			p.state = sAttrib
		}
	case sOpenTagSlash:
		if c != '>' {
			return p.fail("Forward-slash in opening tag not followed by >")
		}
		return p.openTag(true)
	case sAttrib:
		switch {
		case isXMLSpace(c):
		case c == '>':
			return p.openTag(false)
		case c == '/':
			p.state = sOpenTagSlash
		case nameStart(c):
			p.attrName = string(c)
			p.attrValue.Reset()
			p.state = sAttribName
		default:
			return p.fail("Invalid attribute name")
		}
	case sAttribName:
		switch {
		case c == '=':
			p.state = sAttribValue
		case c == '>':
			return p.fail("Attribute without value")
		case isXMLSpace(c):
			p.state = sAttribNameSawWhite
		case nameBody(c):
			p.attrName += string(c)
		default:
			return p.fail("Invalid attribute name")
		}
	case sAttribNameSawWhite:
		switch {
		case c == '=':
			p.state = sAttribValue
		case isXMLSpace(c):
		default:
			return p.fail("Attribute without value")
		}
	case sAttribValue:
		switch {
		case isXMLSpace(c):
		case isQuote(c):
			p.quote = c
			p.state = sAttribValueQuoted
		default:
			return p.fail("Unquoted attribute value")
		}
	case sAttribValueQuoted:
		switch c {
		case p.quote:
			p.attrib()
			p.quote = noQuote
			p.state = sAttribValueClosed
		case '&':
			p.state = sAttribValueEntityQ
		default:
			p.attrValue.WriteRune(c)
		}
	case sAttribValueClosed:
		switch {
		case isXMLSpace(c):
			p.state = sAttrib
		case c == '>':
			return p.openTag(false)
		case c == '/':
			p.state = sOpenTagSlash
		case nameStart(c):
			return p.fail("No whitespace between attributes")
		default:
			return p.fail("Invalid attribute name")
		}
	case sCloseTag:
		switch {
		case p.tagName == "":
			if isXMLSpace(c) {
				return nil
			}
			if !nameStart(c) {
				return p.fail("Invalid tagname in closing tag.")
			}
			p.tagName = string(c)
		case c == '>':
			return p.closeTag()
		case nameBody(c):
			p.tagName += string(c)
		case !isXMLSpace(c):
			return p.fail("Invalid tagname in closing tag")
		default:
			p.state = sCloseTagSawWhite
		}
	case sCloseTagSawWhite:
		if isXMLSpace(c) {
			return nil
		}
		if c != '>' {
			return p.fail("Invalid characters in closing tag")
		}
		return p.closeTag()
	case sTextEntity, sAttribValueEntityQ:
		back := sText
		if p.state == sAttribValueEntityQ {
			back = sAttribValueQuoted
		}
		switch {
		case c == ';':
			value, err := p.parseEntity()
			if err != nil {
				return err
			}
			if back == sText {
				p.addText(value)
			} else {
				p.attrValue.WriteString(value)
			}
			p.entity = ""
			p.state = back
		case (p.entity == "" && entityStart(c)) || (p.entity != "" && entityBody(c)):
			p.entity += string(c)
		default:
			return p.fail("Invalid character in entity name")
		}
	}
	return nil
}

func (p *saxParser) beginWhitespace(c rune) error {
	if c == '<' {
		p.state = sOpenWaka
		return nil
	}
	if !isXMLSpace(c) {
		return p.fail("Non-whitespace before first tag.")
	}
	return nil
}

// attrib keeps the first of repeated attributes, as sax does.
func (p *saxParser) attrib() {
	name, value := p.attrName, p.attrValue.String()
	p.attrName = ""
	p.attrValue.Reset()
	// sax stores attributes on a plain object: "__proto__" goes nowhere.
	if _, dup := p.tag.attrs.Get(name); dup || name == "__proto__" {
		return
	}
	if p.tag.attrs == nil {
		p.tag.attrs = jsvalue.NewObject()
	}
	p.tag.attrs.Set(name, value)
}

func (p *saxParser) openTag(selfClosing bool) error {
	p.sawRoot = true
	p.stack = append(p.stack, p.tag)
	p.tag = nil
	p.state = sText
	if selfClosing {
		return p.closeTag()
	}
	p.tagName = ""
	return nil
}

func (p *saxParser) closeTag() error {
	name := p.tagName
	p.tagName = ""
	p.state = sText
	if len(p.stack) == 0 {
		return p.fail("Unmatched closing tag: " + name)
	}
	if p.top().name != name {
		return p.fail("Unexpected close tag")
	}
	e := p.stack[len(p.stack)-1]
	p.stack = p.stack[:len(p.stack)-1]
	value, err := e.value()
	if err != nil {
		return err
	}
	if parent := p.top(); parent != nil {
		return parent.push(e.name, value)
	}
	p.closedRoot = true
	p.result = jsvalue.NewObject()
	p.result.Set(e.name, value)
	return nil
}

// push is xml2js assignOrPush with explicitArray.
func (e *element) push(name string, value any) error {
	if name == "_" {
		// xml2js turns the text into an array and then fails to test it.
		return errors.New("obj[charkey].match is not a function")
	}
	if name == "$" && e.attrs != nil {
		// xml2js pushes onto the attribute holder.
		return errors.New("unsupported element name $ next to attributes")
	}
	old, ok := e.children.Get(name)
	items, isList := old.([]any)
	if ok && !isList {
		items = []any{old}
	}
	e.set(name, append(items, value))
	return nil
}

// value is xml2js onclosetag: text that is only white space is dropped
// unless it came from CDATA; an element with only text is that text; an
// element with nothing is the dropped white space.
func (e *element) value() (any, error) {
	text := e.text.String()
	flag, _ := e.children.Get("cdata")
	cdata := flag == true
	keepText := cdata || strings.TrimFunc(text, jsvalue.IsSpace) != ""
	obj := jsvalue.NewObject()
	if keepText {
		obj.Set("_", text)
	}
	if e.attrs != nil {
		obj.Set("$", e.attrs)
	}
	for _, k := range e.children.Keys() {
		if v, _ := e.children.Get(k); !(k == "cdata" && cdata) {
			obj.Set(k, v)
		}
	}
	switch keys := obj.Keys(); {
	case len(keys) == 0:
		return text, nil // the dropped white space, or ""
	case len(keys) == 1 && keepText:
		return text, nil
	}
	return obj, nil
}

// parseEntity is sax parseEntity: a named entity (exact, then lower-cased)
// or a decimal or hex character reference written without stray digits.
func (p *saxParser) parseEntity() (string, error) {
	entity := p.entity
	if r, ok := saxEntities[entity]; ok {
		return string(r), nil
	}
	lower := strings.ToLower(entity)
	if r, ok := saxEntities[lower]; ok {
		return string(r), nil
	}
	num, radix := math.NaN(), 10
	digits := lower
	if strings.HasPrefix(lower, "#x") {
		digits, radix = lower[2:], 16
		num = jsvalue.ParseIntRadix(digits, radix)
	} else if strings.HasPrefix(lower, "#") {
		digits = lower[1:]
		num = jsvalue.ParseIntRadix(digits, radix)
	}
	// num.toString(radix) must give back the digits, leading zeros dropped.
	digits = strings.TrimLeft(digits, "0")
	if math.IsNaN(num) || num < 0 || num > 0x10FFFF || strconv.FormatInt(int64(num), radix) != digits {
		return "", p.fail("Invalid character entity")
	}
	return string(rune(num)), nil
}
