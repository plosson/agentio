package rss

import (
	"errors"
	"html"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// A value read from the XML tree is a string, an *jsvalue.Object, or nil for
// undefined, as rss-parser sees it. Printing an object is where Bun fails
// (see format.go), so the fields keep whichever one rss-parser produced.

// feed is RssFeed from src/plugins/rss/types.ts, as parseFeed builds it.
type feed struct {
	Title         any       `json:"title"`
	Description   any       `json:"description,omitempty"`
	Link          any       `json:"link,omitempty"`
	Language      any       `json:"language,omitempty"`
	LastBuildDate any       `json:"lastBuildDate,omitempty"`
	Items         []article `json:"items"`
}

// article is RssArticle, as parseArticle builds it.
type article struct {
	ID          any `json:"id"`
	Title       any `json:"title"`
	Link        any `json:"link,omitempty"`
	Description any `json:"description,omitempty"`
	Content     any `json:"content,omitempty"`
	Author      any `json:"author,omitempty"`
	PubDate     any `json:"pubDate,omitempty"`
	Categories  any `json:"categories,omitempty"`
}

// errTypeError is a TypeError rss-parser hits while building the feed
// (reading "$" of a link that has no attributes); the promise rejects.
var errTypeError = errors.New("TypeError: undefined is not an object")

// parseFeedXML is rss-parser parseString followed by RssClient.parseFeed.
func parseFeedXML(doc string) (*feed, error) {
	result, err := parseXML(doc)
	if err != nil {
		return nil, err
	}
	root := result.Keys()[0]
	value, _ := result.Get(root)
	obj, _ := value.(*jsvalue.Object)
	version := ""
	if attrs, ok := prop(obj, "$").(*jsvalue.Object); ok {
		version, _ = attrs.Str("version")
	}
	switch {
	case root == "feed" && jsvalue.Truthy(value):
		return buildAtom(value)
	case root == "rss" && strings.HasPrefix(version, "2"):
		return buildRSS(prop(obj, "channel"), nil, false)
	case root == "rdf:RDF" && jsvalue.Truthy(value):
		return buildRSS(prop(value, "channel"), prop(value, "item"), true)
	case root == "rss" && strings.Contains(version, "0.9"):
		return buildRSS(prop(obj, "channel"), nil, false)
	}
	return nil, errors.New("Feed not recognized as RSS 1 or 2.")
}

// prop is JavaScript property access on a tree value: an element's key, and
// on a string only String.prototype.link, which rss-parser's field lists
// happen to name (it reads as a function whose [0] is undefined).
func prop(v any, key string) any {
	switch t := v.(type) {
	case *jsvalue.Object:
		if t == nil {
			return nil
		}
		got, _ := t.Get(key)
		return got
	case string:
		if key == "link" {
			return stringLink{}
		}
	}
	return nil
}

// stringLink is String.prototype.link: truthy, length 1, [0] undefined.
type stringLink struct{}

// first is `xml[key][0]`; ok is false when xml[key] is undefined.
func first(v any, key string) (any, bool) {
	switch t := prop(v, key).(type) {
	case []any:
		return t[0], true
	case stringLink:
		return nil, true
	}
	return nil, false
}

// textOf is rss-parser's `if (x && typeof x._ === 'string') x = x._`.
func textOf(v any) any {
	if o, ok := v.(*jsvalue.Object); ok {
		if s, ok := o.Str("_"); ok {
			return s
		}
	}
	return v
}

// copyField is one entry of utils.copyFromXML without options.
func copyField(xml any, dest map[string]any, from, to string) {
	if v, ok := first(xml, from); ok {
		dest[to] = v
	}
	dest[to] = textOf(dest[to])
}

func buildRSS(channelList any, rdfItems any, rdf bool) (*feed, error) {
	list, ok := channelList.([]any)
	if !ok {
		return nil, errTypeError // xmlObj.rss.channel[0] on undefined
	}
	channel := list[0]
	items := rdfItems
	if !rdf {
		items = prop(channel, "item")
	}
	raw := map[string]any{}
	for _, f := range [][2]string{
		{"author", "creator"}, {"dc:publisher", "publisher"}, {"dc:creator", "creator"}, {"dc:source", "source"},
		{"dc:title", "title"}, {"dc:type", "type"}, {"title", "title"}, {"description", "description"},
		{"author", "author"}, {"pubDate", "pubDate"}, {"webMaster", "webMaster"}, {"managingEditor", "managingEditor"},
		{"generator", "generator"}, {"link", "link"}, {"language", "language"}, {"copyright", "copyright"},
		{"lastBuildDate", "lastBuildDate"},
	} {
		copyField(channel, raw, f[0], f[1])
	}
	out := &feed{
		Title:         untitled(raw["title"], "Untitled Feed"),
		Description:   raw["description"],
		Link:          raw["link"],
		Language:      raw["language"],
		LastBuildDate: raw["lastBuildDate"],
		Items:         []article{},
	}
	itemList, _ := items.([]any)
	for _, x := range itemList {
		a, err := parseItemRSS(x)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, a)
	}
	return out, nil
}

// untitled is `value || fallback`.
func untitled(v any, fallback string) any { return or(v, fallback) }

// or is `a || b` over tree values; an element object is truthy.
func or(a, b any) any {
	if jsvalue.Truthy(a) {
		return a
	}
	return b
}

func parseItemRSS(x any) (article, error) {
	raw := map[string]any{}
	for _, f := range [][2]string{
		{"author", "creator"}, {"dc:creator", "creator"}, {"dc:date", "date"}, {"dc:language", "language"},
		{"dc:rights", "rights"}, {"dc:source", "source"}, {"dc:title", "title"}, {"title", "title"},
		{"link", "link"}, {"pubDate", "pubDate"}, {"author", "author"}, {"summary", "summary"},
		{"content:encoded", "content:encoded"}, {"enclosure", "enclosure"}, {"dc:creator", "dc:creator"},
		{"dc:date", "dc:date"}, {"comments", "comments"},
		// RssClient's customFields.
		{"content:encoded", "contentEncoded"}, {"dc:creator", "dcCreator"},
	} {
		copyField(x, raw, f[0], f[1])
	}
	if d, ok := first(x, "description"); ok {
		content, err := getContent(d)
		if err != nil {
			return article{}, err
		}
		raw["content"] = content
		raw["contentSnippet"] = snippet(content)
	}
	if g, ok := first(x, "guid"); ok {
		raw["guid"] = g
		if o, isObj := g.(*jsvalue.Object); isObj {
			if u, _ := o.Get("_"); jsvalue.Truthy(u) {
				raw["guid"] = u
			}
		}
	}
	if c, ok := prop(x, "category").([]any); ok {
		raw["categories"] = c
	}
	setISODate(raw)
	return toArticle(raw), nil
}

// setISODate: `item.isoDate = new Date((pubDate || date).trim()).toISOString()`,
// skipped when that throws.
func setISODate(raw map[string]any) {
	date := or(raw["pubDate"], raw["date"])
	s, ok := date.(string)
	if !ok || s == "" {
		return
	}
	if t, ok := jsvalue.ParseDate(jsvalue.Trim(s)); ok {
		raw["isoDate"] = jsvalue.ISOString(t)
	}
}

// toArticle is RssClient.parseArticle.
func toArticle(raw map[string]any) article {
	id := or(or(or(raw["guid"], raw["link"]), raw["title"]), "")
	return article{
		ID:          id,
		Title:       untitled(raw["title"], "Untitled"),
		Link:        raw["link"],
		Description: or(raw["contentSnippet"], raw["content"]),
		Content:     or(raw["contentEncoded"], raw["content"]),
		Author:      or(raw["creator"], raw["dcCreator"]),
		PubDate:     or(raw["pubDate"], raw["isoDate"]),
		Categories:  raw["categories"],
	}
}

func buildAtom(root any) (*feed, error) {
	out := &feed{Items: []article{}}
	raw := map[string]any{}
	if links := prop(root, "link"); links != nil {
		link, err := getLink(links, "alternate", 0)
		if err != nil {
			return nil, err
		}
		if _, err := getLink(links, "self", 1); err != nil {
			return nil, err
		}
		raw["link"] = link
	}
	if title, ok := atomTitle(root); ok {
		raw["title"] = title
	}
	if u, ok := first(root, "updated"); ok {
		raw["lastBuildDate"] = u
	}
	entries, _ := prop(root, "entry").([]any)
	for _, e := range entries {
		a, err := parseItemAtom(e)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, a)
	}
	out.Title = untitled(raw["title"], "Untitled Feed")
	out.Link = raw["link"]
	out.LastBuildDate = raw["lastBuildDate"]
	return out, nil
}

// atomTitle is `title = x.title[0] || ”; if (title._) title = title._;
// if (title) set`.
func atomTitle(v any) (any, bool) {
	t, ok := first(v, "title")
	if !ok {
		return nil, false
	}
	if o, isObj := t.(*jsvalue.Object); isObj {
		if u, _ := o.Get("_"); jsvalue.Truthy(u) {
			t = u
		}
	}
	if jsvalue.Truthy(t) {
		return t, true
	}
	return nil, false
}

// getLink is utils.getLink: the href of the first link with that rel, else
// of links[fallback]. Reading "$" of a link without attributes throws.
func getLink(links any, rel string, fallback int) (any, error) {
	list, ok := links.([]any)
	if !ok {
		// String.prototype.link: links[0] is undefined, so links[0].$ throws.
		return nil, errTypeError
	}
	attrsOf := func(v any) (*jsvalue.Object, error) {
		a, ok := prop(v, "$").(*jsvalue.Object)
		if !ok {
			return nil, errTypeError
		}
		return a, nil
	}
	for _, l := range list {
		a, err := attrsOf(l)
		if err != nil {
			return nil, err
		}
		if r, ok := a.Str("rel"); ok && r == rel {
			href, _ := a.Get("href")
			return href, nil
		}
	}
	if fallback < len(list) && jsvalue.Truthy(list[fallback]) {
		a, err := attrsOf(list[fallback])
		if err != nil {
			return nil, err
		}
		href, _ := a.Get("href")
		return href, nil
	}
	return nil, nil
}

func parseItemAtom(e any) (article, error) {
	raw := map[string]any{}
	copyField(e, raw, "content:encoded", "contentEncoded")
	copyField(e, raw, "dc:creator", "dcCreator")
	if title, ok := atomTitle(e); ok {
		raw["title"] = title
	}
	if links := prop(e, "link"); links != nil {
		// `entry.link && entry.link.length`: never empty.
		link, err := getLink(links, "alternate", 0)
		if err != nil {
			return article{}, err
		}
		raw["link"] = link
	}
	for _, key := range []string{"published", "updated"} {
		if raw["pubDate"] != nil {
			break
		}
		// `entry.published[0].length`: only a non-empty string counts.
		if s, _ := first(e, key); s != nil {
			if str, ok := s.(string); ok && str != "" {
				t, ok := jsvalue.ParseDate(str)
				if !ok {
					return article{}, errors.New("RangeError: Invalid Date")
				}
				raw["pubDate"] = jsvalue.ISOString(t)
			}
		}
	}
	if c, ok := first(e, "content"); ok {
		content, err := getContent(c)
		if err != nil {
			return article{}, err
		}
		raw["content"] = content
		raw["contentSnippet"] = snippet(content)
	}
	if s, ok := first(e, "summary"); ok {
		if _, err := getContent(s); err != nil {
			return article{}, err
		}
	}
	setISODate(raw)
	return toArticle(raw), nil
}

// getContent is utils.getContent: the text of an element, or the element
// rebuilt as XML under a <div> when it has markup.
func getContent(v any) (string, error) {
	o, ok := v.(*jsvalue.Object)
	if !ok {
		s, _ := v.(string)
		return s, nil
	}
	if s, ok := o.Str("_"); ok {
		return s, nil
	}
	var b strings.Builder
	if err := buildElement(&b, "div", o); err != nil {
		return "", err
	}
	return b.String(), nil
}

// buildElement is xml2js's Builder with rss-parser's options (headless, no
// pretty printing) over xmlbuilder: attributes, then text and children in
// key order, and an element without content self-closed.
func buildElement(b *strings.Builder, name string, v any) error {
	b.WriteString("<" + name)
	var body strings.Builder
	var err error
	switch t := v.(type) {
	case *jsvalue.Object:
		for _, key := range t.Keys() {
			child, _ := t.Get(key)
			switch {
			case key == "$":
				attrs, _ := child.(*jsvalue.Object)
				for _, an := range attrs.Keys() {
					av, _ := attrs.Str(an)
					esc, e := legal(attrEscaper.Replace(av))
					if e != nil {
						return e
					}
					b.WriteString(" " + an + `="` + esc + `"`)
				}
			case key == "_":
				s, _ := child.(string)
				err = writeText(&body, s)
			default:
				items, _ := child.([]any)
				for _, item := range items {
					if err != nil {
						break
					}
					err = buildElement(&body, key, item)
				}
			}
			if err != nil {
				return err
			}
		}
	case string:
		err = writeText(&body, t)
	case bool:
		err = writeText(&body, strconv.FormatBool(t))
	}
	if err != nil {
		return err
	}
	if body.Len() == 0 {
		b.WriteString("/>")
		return nil
	}
	b.WriteString(">" + body.String() + "</" + name + ">")
	return nil
}

var (
	textEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\r", "&#xD;")
	attrEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", `"`, "&quot;", "\t", "&#x9;", "\n", "&#xA;", "\r", "&#xD;")
)

func writeText(b *strings.Builder, s string) error {
	esc, err := legal(textEscaper.Replace(s))
	b.WriteString(esc)
	return err
}

// legal is xmlbuilder's assertLegalChar for XML 1.0.
func legal(s string) (string, error) {
	for _, r := range s {
		if (r <= 0x08) || r == 0x0B || r == 0x0C || (r >= 0x0E && r <= 0x1F) || r == 0xFFFE || r == 0xFFFF {
			return "", errors.New("Invalid character in string: " + s)
		}
	}
	return s, nil
}

// Patterns of utils.stripHtml. In JavaScript "." is any character but the
// line terminators \n, \r, U+2028 and U+2029, so "(?:.|\n)" still stops at
// \r, U+2028 and U+2029.
var (
	blockTag = regexp.MustCompile(`([^\n])</?(?:h|br|p|ul|ol|li|blockquote|section|table|tr|div)[^\r\x{2028}\x{2029}]*?>([^\n])`)
	anyTag   = regexp.MustCompile(`<[^\r\x{2028}\x{2029}]*?>`)
	entityRe = regexp.MustCompile(`&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[a-zA-Z0-9]+;?)`)
)

// snippet is utils.getSnippet: block tags become line breaks, other tags go,
// HTML entities decode, and the result is trimmed.
func snippet(s string) string {
	s = blockTag.ReplaceAllString(s, "$1\n$2")
	s = anyTag.ReplaceAllString(s, "")
	return jsvalue.Trim(decodeHTML(s))
}

// decodeHTML is entities.decodeHTML (v2): named references from the HTML
// table, legacy names also without ";", and numeric references through the
// Windows-1252 remapping.
func decodeHTML(s string) string {
	return entityRe.ReplaceAllStringFunc(s, func(m string) string {
		if m[1] != '#' {
			return html.UnescapeString(m)
		}
		digits, base := strings.TrimSuffix(m[2:], ";"), 10
		if digits[0] == 'x' || digits[0] == 'X' {
			digits, base = digits[1:], 16
		}
		n, err := strconv.ParseUint(digits, base, 32)
		if err != nil {
			n = math.MaxUint32
		}
		return decodeCodePoint(n)
	})
}

// decodeCodePoint is entities' decode_codepoint.
func decodeCodePoint(n uint64) string {
	if (n >= 0xD800 && n <= 0xDFFF) || n > 0x10FFFF {
		return "\uFFFD"
	}
	if r, ok := windows1252[n]; ok {
		return string(r)
	}
	return string(rune(n))
}

// windows1252 is entities' maps/decode.json.
var windows1252 = map[uint64]rune{
	0: 65533, 128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225, 136: 710,
	137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216, 146: 8217, 147: 8220, 148: 8221,
	149: 8226, 150: 8211, 151: 8212, 152: 732, 153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376,
}
