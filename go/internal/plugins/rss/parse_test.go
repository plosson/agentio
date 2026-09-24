package rss

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// Expected values below were printed by Bun (xml2js, rss-parser, entities).

func xmlJSON(t *testing.T, doc string) string {
	t.Helper()
	r, err := parseXML(doc)
	if err != nil {
		return "ERR"
	}
	return string(jsvalue.Stringify(r))
}

func TestParseXMLIsXML2JS(t *testing.T) {
	for doc, want := range map[string]string{
		`<r><a>t</a><a x="1">u</a></r>`:                 `{"r":{"a":["t",{"_":"u","$":{"x":"1"}}]}}`,
		`<r>  <c>t<d/>u</c>  </r>`:                      `{"r":{"c":[{"_":"tu","d":[""]}]}}`,
		`<r> </r>`:                                      `{"r":" "}`,
		`<r><![CDATA[ ]]><c/></r>`:                      `{"r":{"_":" ","c":[""]}}`,
		`<r>&nbsp;&copy;&AMP;&#x41;&#0065;</r>`:         "{\"r\":\"\u00a0©&AA\"}",
		`<r a="1" a="2" __proto__="3"/>`:                `{"r":{"$":{"a":"1"}}}`,
		`<r>a</r> trailing <junk`:                       `{"r":"a"}`,
		"\ufeff\ufeff<r>x</r>":                          `{"r":"x"}`,
		"<r>a\r\nb</r>":                                 `{"r":"a\r\nb"}`,
		`<!DOCTYPE r [<!ENTITY e "v">]><r>x</r>`:        `{"r":"x"}`,
		`<r><?pi x?><!-- c --><x:y z:w="q">v</x:y></r>`: `{"r":{"x:y":[{"_":"v","$":{"z:w":"q"}}]}}`,
		// xml2js marks CDATA with a "cdata" key, which a cdata element shares.
		`<r><![CDATA[ ]]><cdata>c</cdata></r>`: `{"r":{"cdata":[true,"c"]}}`,
		`<r><cdata>c</cdata><![CDATA[x]]></r>`: `{"r":"x"}`,
		// sax never records the quote of a declaration, so it never ends.
		`<r><!x "q"></r>`: "ERR",
		`<r>&bogus;</r>`:  "ERR",
		`<r>&#0;</r>`:     "ERR",
		`<r>&#x0041;</r>`: `{"r":"A"}`,
		`<r>&#x41g;</r>`:  "ERR",
		`<r><a b></r>`:    "ERR",
		`<r><_/></r>`:     "ERR",
		"":                "ERR",
		" \n ":            "ERR",
	} {
		if got := xmlJSON(t, doc); got != want {
			t.Errorf("%q: got %s want %s", doc, got, want)
		}
	}
}

func TestSnippetIsRSSParsers(t *testing.T) {
	for in, want := range map[string]string{
		// A match takes the character after its tag, so the next tag loses
		// its break and is dropped whole.
		"<p>a</p><p>b</p>":     "a\nb",
		"x<br>y<hr>z<header>w": "x\nyz\nw",
		"a</div>b<br/>c":       "a\nbc",
		"a<p>\r\nb":            "a\n\r\nb",
		// "." stops at \r, so a tag holding one is not a block tag.
		"a<p x='\r'>b":                           "a<p x='\r'>b",
		"&amp &notit; &#x80; &#128512; &#xD800;": "& ¬it; € 😀 \uFFFD",
		"&unknown; &AMP; &#;":                    "&unknown; & &#;",
		"  \u00a0<b>t</b>\ufeff ":                "t",
	} {
		if got := snippet(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestInspectIsBunConsoleLog(t *testing.T) {
	r, err := parseXML(`<a><k>q"\` + "\t\x0b</k><my-el>x</my-el><p><q><r>1</r></q></p></a>")
	if err != nil {
		t.Fatal(err)
	}
	v, _ := r.Get("a")
	want := "[Object: null prototype] {\n  k: [ \"q\\\"\\\\\\t\\u000b\" ],\n  \"my-el\": [ \"x\" ],\n  p: [\n    [Object: null prototype] {\n      q: [\n        [Object ...]\n      ],\n    }\n  ],\n}"
	if got := inspect(v, 0, 0); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestSliceAndOriginAreJavaScripts(t *testing.T) {
	items := []article{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	nan := jsvalue.ParseInt("x")
	for _, c := range []struct {
		limit float64
		n     int
	}{{2, 2}, {0, 0}, {-1, 2}, {-5, 0}, {1e20, 3}, {nan, 0}} {
		if got := len(jsSlice(items, c.limit)); got != c.n {
			t.Errorf("slice(0, %v) = %d want %d", c.limit, got, c.n)
		}
	}
	for base, want := range map[string]string{
		"https://Example.TEST:443/blog": "https://example.test",
		"http://u:p@host:8080/x":        "http://host:8080",
		"http://[::1]:80/":              "http://[::1]",
	} {
		if got := origin(base); got != want {
			t.Errorf("origin(%q) = %q want %q", base, got, want)
		}
	}
}

func TestDecodeBodyFollowsTheContentType(t *testing.T) {
	for _, c := range []struct{ body, ctype, want string }{
		{"caf\xe9", "text/xml; charset=ISO-8859-1", "café"},
		{"caf\xe9", "text/xml; charset=latin1;", "caf\uFFFD"}, // "latin1;" is not a known name
		{"caf\xe9", "text/xml; charset=ascii", "cafi"},
		{"c\x00a\x00", "text/xml; encoding=UTF16LE", "ca"},
		{"\xef\xbb\xbfx\xe2\x82", "text/xml", "\ufeffx\uFFFD"},
	} {
		if got := decodeBody([]byte(c.body), c.ctype); got != c.want {
			t.Errorf("%q %q: got %q want %q", c.body, c.ctype, got, c.want)
		}
	}
}

type failure struct{ code, message, suggestion string }

func (f *failure) Error() string { return f.code + ": " + f.message }

func testClient() *client {
	return &client{ctx: context.Background(), fetch: func(ctx context.Context, r *http.Request) (*http.Response, error) {
		return http.DefaultClient.Do(r)
	}, fail: func(code, message, suggestion string) error { return &failure{code, message, suggestion} }}
}

// getFeed re-reads a feed discovery accepted; its failures are Bun's.
func TestGetFeedErrorsMatchBun(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gone":
			w.WriteHeader(404)
		case "/text":
			_, _ = w.Write([]byte("plain text"))
		default:
			_, _ = w.Write([]byte(`<feed><entry><link>x</link></entry></feed>`))
		}
	}))
	url := srv.URL
	c := testClient()
	for path, want := range map[string]failure{
		"/gone": {"API_ERROR", "Failed to parse feed: Error: Status code 404", "Verify the feed URL is valid"},
		"/text": {"INVALID_PARAMS", "Invalid RSS feed format", "The URL may not be an RSS feed"},
		"/type": {"API_ERROR", "Failed to parse feed: TypeError: undefined is not an object", "Verify the feed URL is valid"},
	} {
		_, err := c.getFeed(url + path)
		var f *failure
		if !errors.As(err, &f) || *f != want {
			t.Errorf("%s: %v", path, err)
		}
	}
	srv.Close()
	_, err := c.getFeed(url + "/gone")
	var f *failure
	if !errors.As(err, &f) || f.code != "NETWORK_ERROR" || f.message != "Cannot reach feed: "+url+"/gone" ||
		f.suggestion != "Check the URL and your internet connection" {
		t.Errorf("refused: %v", err)
	}
}

func TestExtractFeedURLIsBuns(t *testing.T) {
	base := "http://blog.test/b"
	for page, want := range map[string]string{
		`<link rel="alternate" type="application/rss+xml" href="/f.xml">`:           "http://blog.test/f.xml",
		`<link rel="alternate" type="application/atom+xml" href="f.xml">`:           "http://blog.test/b/f.xml",
		`<link rel="alternate" type="application/rss+xml" href="https://x.test/f">`: "https://x.test/f",
		// The type is matched case-sensitively; a link without href is skipped.
		`<link rel="alternate" type="Application/RSS+XML" href="/a"><link rel="alternate" type="application/rss+xml"><link rel="alternate" type="application/rss+xml" href="/b">`: "http://blog.test/b",
		`<link rel="stylesheet" href="/s.css"><link type="application/rss+xml" href="/norel">`:                                                                                    "",
		// The href is used as written: entities are not decoded.
		`<link rel="alternate" type="application/rss+xml" href="/f?a=1&amp;b=2">`: "http://blog.test/f?a=1&amp;b=2",
	} {
		if got := extractFeedURL(page, base); got != want {
			t.Errorf("%s: got %q want %q", page, got, want)
		}
	}
	if strings.Contains(extractFeedURL("", base), "x") {
		t.Fatal("empty page")
	}
}
