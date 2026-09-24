package rss

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// errNoDefault is the TypeError JavaScriptCore throws when a template
// literal or join meets an element object: xml2js builds them with a null
// prototype, so they have no toString. handleError prints "Error: <message>".
var errNoDefault = errors.New("No default value")

// printer is console.log into a buffer. Once a line cannot be built it
// keeps the lines before it and the error, as Bun printed up to the throw.
type printer struct {
	b   strings.Builder
	err error
}

func (p *printer) log(parts ...any) {
	if p.err != nil {
		return
	}
	var line strings.Builder
	for _, part := range parts {
		s, err := interpolate(part)
		if err != nil {
			p.err = err
			return
		}
		line.WriteString(s)
	}
	p.b.WriteString(line.String() + "\n")
}

// interpolate is `${v}` for a tree value.
func interpolate(v any) (string, error) {
	switch t := v.(type) {
	case nil:
		return "undefined", nil
	case string:
		return t, nil
	case bool:
		return strconv.FormatBool(t), nil
	case int:
		return strconv.Itoa(t), nil
	}
	return "", errNoDefault
}

// join is Array#join(sep).
func join(items []any, sep string) (string, error) {
	parts := make([]string, len(items))
	for i, e := range items {
		s, err := interpolate(e)
		if err != nil {
			return "", err
		}
		parts[i] = s
	}
	return strings.Join(parts, sep), nil
}

// articleList is what `rss articles` prints: printRssArticleList(articles, info.title).
type articleList struct {
	Feed     any       `json:"feed"`
	Articles []article `json:"articles"`
}

// partial is the output Bun had written when printing threw.
type partial string

func renderArticleList(l articleList) (string, error) {
	var p printer
	if len(l.Articles) == 0 {
		p.log("No articles found")
		return p.b.String(), nil
	}
	p.log("Articles from ", l.Feed, " (", len(l.Articles), ")\n")
	for i, a := range l.Articles {
		p.log("[", i+1, "] ", a.Title)
		if jsvalue.Truthy(a.Author) {
			p.log("    Author: ", a.Author)
		}
		if jsvalue.Truthy(a.PubDate) {
			p.log("    Date: ", a.PubDate)
		}
		if jsvalue.Truthy(a.Link) {
			p.log("    Link: ", a.Link)
		}
		if d, _ := a.Description.(string); d != "" {
			p.log("    > ", jsvalue.Truncate(d, 150))
		}
		p.log("")
	}
	return p.b.String(), p.err
}

func renderArticle(a *article) (string, error) {
	var p printer
	p.log("Title: ", a.Title)
	if jsvalue.Truthy(a.Author) {
		p.log("Author: ", a.Author)
	}
	if jsvalue.Truthy(a.PubDate) {
		p.log("Date: ", a.PubDate)
	}
	if jsvalue.Truthy(a.Link) {
		p.log("Link: ", a.Link)
	}
	if cats, _ := a.Categories.([]any); len(cats) > 0 && p.err == nil {
		joined, err := join(cats, ", ")
		if err != nil {
			p.err = err
		}
		p.log("Categories: ", joined)
	}
	p.log("---")
	if p.err == nil {
		// console.log of a value: text as is, an element object inspected.
		body := or(or(a.Content, a.Description), "No content available")
		if s, ok := body.(string); ok {
			p.b.WriteString(s + "\n")
		} else {
			p.b.WriteString(inspect(body, 0, 0) + "\n")
		}
	}
	return p.b.String(), p.err
}

func renderInfo(f *info) (string, error) {
	var p printer
	p.log("Title: ", f.Title)
	p.log("Feed URL: ", f.FeedURL)
	if jsvalue.Truthy(f.Description) {
		p.log("Description: ", f.Description)
	}
	if jsvalue.Truthy(f.Link) {
		p.log("Site: ", f.Link)
	}
	if jsvalue.Truthy(f.Language) {
		p.log("Language: ", f.Language)
	}
	if jsvalue.Truthy(f.LastBuildDate) {
		p.log("Last Updated: ", f.LastBuildDate)
	}
	p.log("Articles: ", len(f.Items))
	return p.b.String(), p.err
}

// format renders any value the commands return, for the host.
func format(v any) string {
	var s string
	switch t := v.(type) {
	case partial:
		return string(t)
	case articleList:
		s, _ = renderArticleList(t)
	case *article:
		s, _ = renderArticle(t)
	case *info:
		s, _ = renderInfo(t)
	}
	return s
}

// render runs the renderer once in Run: when printing would throw, the value
// becomes the text printed so far and the error follows it.
func render(v any) (any, error) {
	var err error
	var s string
	switch t := v.(type) {
	case articleList:
		s, err = renderArticleList(t)
	case *article:
		s, err = renderArticle(t)
	case *info:
		s, err = renderInfo(t)
	}
	if err == nil {
		return v, nil
	}
	if s == "" {
		return nil, err
	}
	return partial(s), err
}

var identifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// inspect is Bun's console.log rendering of an xml2js value: null-prototype
// objects one key per line, arrays inline unless they open with an object,
// and objects nested three containers deep shown as [Object ...].
func inspect(v any, depth, indent int) string {
	pad := func(n int) string { return strings.Repeat("  ", n) }
	switch t := v.(type) {
	case string:
		return quote(t)
	case bool:
		return strconv.FormatBool(t)
	case *jsvalue.Object:
		if depth >= 3 {
			return "[Object ...]"
		}
		var b strings.Builder
		b.WriteString("[Object: null prototype] {\n")
		for _, k := range t.Keys() {
			val, _ := t.Get(k)
			key := k
			if !identifier.MatchString(k) {
				key = quote(k)
			}
			b.WriteString(pad(indent+1) + key + ": " + inspect(val, depth+1, indent+1) + ",\n")
		}
		b.WriteString(pad(indent) + "}")
		return b.String()
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = inspect(e, depth+1, indent+1)
		}
		if len(t) > 0 {
			if _, isObj := t[0].(*jsvalue.Object); isObj {
				return "[\n" + pad(indent+1) + strings.Join(parts, ", ") + "\n" + pad(indent) + "]"
			}
		}
		return "[ " + strings.Join(parts, ", ") + " ]"
	}
	return "undefined"
}

// quote is Bun's inspect quoting of a string.
func quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		case '\r':
			b.WriteString(`\r`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
