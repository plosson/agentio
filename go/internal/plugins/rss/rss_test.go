package rss_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/cli"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Every expected stdout, stderr and request list below is what the Bun CLI
// printed and sent for the same fixture, served by a local mock.

type route struct {
	status   int
	ctype    string
	body     string
	location string
}

type feedServer struct {
	mu   sync.Mutex
	hits []string
	url  string
}

// requests is "<path> <User-Agent>" for each request, in order.
func (s *feedServer) requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.hits...)
}

func serve(t *testing.T, routes map[string]route) *feedServer {
	t.Helper()
	s := &feedServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits = append(s.hits, r.URL.Path+" "+r.Header.Get("User-Agent"))
		s.mu.Unlock()
		rt, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if rt.location != "" {
			w.Header().Set("Location", rt.location)
			w.WriteHeader(302)
			return
		}
		ct := rt.ctype
		if ct == "" {
			ct = "application/xml"
		}
		w.Header().Set("Content-Type", ct)
		if rt.status != 0 {
			w.WriteHeader(rt.status)
		}
		_, _ = io.WriteString(w, rt.body)
	}))
	t.Cleanup(srv.Close)
	s.url = srv.URL
	return s
}

// setup gives the CLI a vault in a temporary HOME (Bun refuses to run any
// service command without one) and pins local time to UTC.
func setup(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	prev := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = prev })
}

func run(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = cli.Execute(plugins.Default, append([]string{"rss"}, args...), &out, &errOut, strings.NewReader(""))
	return out.String(), errOut.String(), code
}

type want struct {
	stdout, stderr string
	code           int
	requests       []string
}

func check(t *testing.T, s *feedServer, w want, args ...string) {
	t.Helper()
	before := len(s.requests())
	for i, a := range args {
		args[i] = strings.ReplaceAll(a, "{{URL}}", s.url)
	}
	stdout, stderr, code := run(t, args...)
	wantOut := strings.ReplaceAll(w.stdout, "{{URL}}", s.url)
	wantErr := strings.ReplaceAll(w.stderr, "{{URL}}", s.url)
	if stdout != wantOut || stderr != wantErr || code != w.code {
		t.Errorf("%v\n--- stdout\n%s--- want\n%s--- stderr %q want %q; exit %d want %d", args, stdout, wantOut, stderr, wantErr, code, w.code)
	}
	if w.requests != nil {
		got := s.requests()[before:]
		if strings.Join(got, "\n") != strings.Join(w.requests, "\n") {
			t.Errorf("%v requests:\n%s\nwant\n%s", args, strings.Join(got, "\n"), strings.Join(w.requests, "\n"))
		}
	}
}

func repeat(line string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = line
	}
	return out
}

const rss2Feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Synthetic &amp; Co&nbsp;Blog</title>
  <link>http://example.test/</link>
  <description>Notes about nothing</description>
  <language>en-us</language>
  <lastBuildDate>Tue, 10 Jun 2025 04:00:00 GMT</lastBuildDate>
  <item>
    <title>First post</title>
    <link>http://example.test/p/1</link>
    <guid isPermaLink="false">guid-1</guid>
    <pubDate>Tue, 10 Jun 2025 04:00:00 GMT</pubDate>
    <dc:creator>Alice</dc:creator>
    <category>Tech</category>
    <category><![CDATA[Go & Bun]]></category>
    <description><![CDATA[<p>Hello <b>world</b> &amp; friends&nbsp;there</p><p>Second &eacute;</p>]]></description>
    <content:encoded><![CDATA[<p>Full content</p>]]></content:encoded>
  </item>
  <item>
    <title></title>
    <link>http://example.test/p/2</link>
    <dc:date>2024-02-03T04:05:06+02:00</dc:date>
    <author>bob@example.test (Bob)</author>
    <description>Plain text that runs long, and longer, and longer still, well past the one hundred and fifty characters the list keeps before it cuts to an ellipsis 😀 tail</description>
  </item>
  <item>
    <title>Undated</title>
    <guid>guid-3</guid>
  </item>
</channel>
</rss>
`

const rss2List = "Articles from Synthetic & Co\u00a0Blog (3)\n\n" +
	"[1] First post\n    Author: Alice\n    Date: Tue, 10 Jun 2025 04:00:00 GMT\n    Link: http://example.test/p/1\n" +
	"    > Hello world & friends\u00a0there\nSecond é\n\n" +
	"[2] Untitled\n    Author: bob@example.test (Bob)\n    Date: 2024-02-03T02:05:06.000Z\n    Link: http://example.test/p/2\n" +
	"    > Plain text that runs long, and longer, and longer still, well past the one hundred and fifty characters the list keeps before it cuts to an ellipsis \uFFFD...\n\n" +
	"[3] Undated\n\n"

func TestRSS2MatchesBun(t *testing.T) {
	setup(t)
	s := serve(t, map[string]route{"/feed.xml": {body: rss2Feed}})
	four := repeat("/feed.xml rss-parser", 4)
	check(t, s, want{stdout: rss2List, requests: four}, "articles", "{{URL}}/feed.xml")
	check(t, s, want{stdout: "Title: Synthetic & Co\u00a0Blog\nFeed URL: {{URL}}/feed.xml\nDescription: Notes about nothing\n" +
		"Site: http://example.test/\nLanguage: en-us\nLast Updated: Tue, 10 Jun 2025 04:00:00 GMT\nArticles: 3\n",
		requests: four[:2]}, "info", "{{URL}}/feed.xml")
	check(t, s, want{stdout: "Title: First post\nAuthor: Alice\nDate: Tue, 10 Jun 2025 04:00:00 GMT\nLink: http://example.test/p/1\n" +
		"Categories: Tech, Go & Bun\n---\n<p>Full content</p>\n"}, "get", "{{URL}}/feed.xml", "guid-1")
	// An article is found by its link too; without content the description prints.
	check(t, s, want{stdout: "Title: Untitled\nAuthor: bob@example.test (Bob)\nDate: 2024-02-03T02:05:06.000Z\nLink: http://example.test/p/2\n---\n" +
		"Plain text that runs long, and longer, and longer still, well past the one hundred and fifty characters the list keeps before it cuts to an ellipsis 😀 tail\n"},
		"get", "{{URL}}/feed.xml", "http://example.test/p/2")
	check(t, s, want{stderr: "Error [NOT_FOUND]: Article not found: nope\nSuggestion: Use \"agentio rss articles\" to list available articles\n", code: 5},
		"get", "{{URL}}/feed.xml", "nope")
	// A trailing slash is dropped before the first request.
	check(t, s, want{stdout: rss2List, requests: four}, "articles", "  {{URL}}/feed.xml/ ")
}

func TestLimitAndSinceMatchBun(t *testing.T) {
	setup(t)
	s := serve(t, map[string]route{"/feed.xml": {body: rss2Feed}})
	first, _, _ := strings.Cut(rss2List, "[2]")
	withoutLast, _, _ := strings.Cut(rss2List, "[3]")
	withoutLast = strings.Replace(withoutLast, "(3)", "(2)", 1)
	for _, c := range []struct {
		args []string
		out  string
	}{
		{[]string{"--limit", "1"}, strings.Replace(first, "(3)", "(1)", 1)},
		{[]string{"--limit", "1.9"}, strings.Replace(first, "(3)", "(1)", 1)},
		{[]string{"--limit", "0"}, "No articles found\n"},
		{[]string{"--limit", "abc"}, "No articles found\n"},
		{[]string{"--limit", ""}, "No articles found\n"},
		{[]string{"--limit", "-1"}, withoutLast},
		{[]string{"--limit", "99999999999999999999"}, rss2List},
		// An article without a date is always kept.
		{[]string{"--since", "2025-01-01"}, strings.Replace(first, "(3)", "(2)", 1) + "[2] Undated\n\n"},
		{[]string{"--since", "2024-02-03T02:05:06Z"}, rss2List},
		{[]string{"--since", "2024-02-03T02:05:07Z"}, strings.Replace(first, "(3)", "(2)", 1) + "[2] Undated\n\n"},
		// An Invalid Date compares false: only the undated article is left.
		{[]string{"--since", "nonsense"}, "Articles from Synthetic & Co\u00a0Blog (1)\n\n[1] Undated\n\n"},
		{[]string{"--since", ""}, rss2List},
	} {
		check(t, s, want{stdout: c.out}, append([]string{"articles", "{{URL}}/feed.xml"}, c.args...)...)
	}
}

const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Atom Feed</title>
  <link href="http://example.test/atom.xml" rel="self"/>
  <link href="http://example.test/"/>
  <updated>2025-01-02T03:04:05Z</updated>
  <entry>
    <title>Atom one</title>
    <id>tag:example.test,2025:1</id>
    <link href="http://example.test/a/1"/>
    <link rel="alternate" href="http://example.test/a/1/alt"/>
    <published>2025-01-02T03:04:05+01:00</published>
    <author><name>Carol</name></author>
    <content type="html">&lt;p&gt;Atom &amp;amp; content&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Atom two</title>
    <link href="http://example.test/a/2"/>
    <updated>Mon, 01 Jan 2024 10:00:00 +0000</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Para &amp; <em>em</em></p><br/></div></content>
  </entry>
  <entry>
    <title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">X</div></title>
    <link href="http://example.test/a/3"/>
  </entry>
</feed>
`

func TestAtomMatchesBun(t *testing.T) {
	setup(t)
	s := serve(t, map[string]route{"/atom.xml": {body: atomFeed}})
	// The third title is XHTML markup, an object: printing it throws in Bun
	// after the first two articles are out.
	check(t, s, want{stdout: "Articles from Atom Feed (3)\n\n" +
		"[1] Atom one\n    Date: 2025-01-02T02:04:05.000Z\n    Link: http://example.test/a/1/alt\n    > Atom & content\n\n" +
		"[2] Atom two\n    Date: 2024-01-01T10:00:00.000Z\n    Link: http://example.test/a/2\n    > Para & em\n\n",
		stderr: "Error: No default value\n", code: 1}, "articles", "{{URL}}/atom.xml")
	// XHTML content is rebuilt as XML under a <div>.
	check(t, s, want{stdout: "Title: Atom two\nDate: 2024-01-01T10:00:00.000Z\nLink: http://example.test/a/2\n---\n" +
		`<div type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Para &amp; <em>em</em></p><br/></div></div>` + "\n"},
		"get", "{{URL}}/atom.xml", "http://example.test/a/2")
	// No link is rel="alternate", so the site is the first link.
	check(t, s, want{stdout: "Title: Atom Feed\nFeed URL: {{URL}}/atom.xml\nSite: http://example.test/atom.xml\n" +
		"Last Updated: 2025-01-02T03:04:05Z\nArticles: 3\n"}, "info", "{{URL}}/atom.xml")
	// An Atom entry is found by link only: rss-parser keeps its id elsewhere.
	check(t, s, want{stderr: "Error [NOT_FOUND]: Article not found: tag:example.test,2025:1\nSuggestion: Use \"agentio rss articles\" to list available articles\n", code: 5},
		"get", "{{URL}}/atom.xml", "tag:example.test,2025:1")
}

func TestRDFAndRSS091MatchBun(t *testing.T) {
	setup(t)
	s := serve(t, map[string]route{
		"/rdf.xml": {body: `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
 <channel rdf:about="http://example.test/"><title>RDF Feed</title><link>http://example.test/</link><description>rdf</description></channel>
 <item rdf:about="http://example.test/r/1"><title>R1</title><link>http://example.test/r/1</link><dc:date>2024-05-06T07:08:09+02:00</dc:date><dc:creator>Dora</dc:creator><description>&lt;div&gt;a&lt;/div&gt;&lt;div&gt;b&lt;/div&gt;c&lt;br/&gt;d &amp;copy &amp;notit; &amp;#x80;</description></item>
</rdf:RDF>
`},
		"/rss091.xml": {body: `<?xml version="1.0"?>
<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">
<rss version="0.91"><channel><title>Old feed</title><item><title>One</title><link>http://example.test/o/1</link></item></channel></rss>
`},
	})
	// Block tags become line breaks unless the previous match used the
	// character before them; legacy entities decode without ";".
	check(t, s, want{stdout: "Articles from RDF Feed (1)\n\n[1] R1\n    Author: Dora\n    Date: 2024-05-06T05:08:09.000Z\n" +
		"    Link: http://example.test/r/1\n    > a\nb\ncd © ¬it; €\n\n"}, "articles", "{{URL}}/rdf.xml")
	check(t, s, want{stdout: "Title: Old feed\nFeed URL: {{URL}}/rss091.xml\nArticles: 1\n"}, "info", "{{URL}}/rss091.xml")
}

func TestObjectValuesFailWhereBunThrows(t *testing.T) {
	setup(t)
	s := serve(t, map[string]route{"/o.xml": {body: `<rss version="2.0" xmlns:content="c"><channel><title>Objects</title>
<item><title>Rich</title><guid>rich</guid><content:encoded><p>Hi <b>there</b> "q"</p><p>2</p><p a="b"><q><r>deep</r></q></p></content:encoded><description><p>markup &amp; <i>more</i></p><br/></description></item>
<item><title>Cat</title><guid>cat</guid><category domain="d">X</category></item>
<item><title>Late</title><guid>late</guid><pubDate><x/></pubDate></item>
</channel></rss>`}})
	// Markup inside content:encoded stays an object, which console.log inspects.
	check(t, s, want{stdout: `Title: Rich
---
[Object: null prototype] {
  p: [
    [Object: null prototype] {
      _: "Hi  \"q\"",
      b: [ "there" ],
    }, "2", [Object: null prototype] {
      $: [Object ...],
      q: [
        [Object ...]
      ],
    }
  ],
}
`}, "get", "{{URL}}/o.xml", "rich")
	check(t, s, want{stdout: "Articles from Objects (3)\n\n[1] Rich\n    > markup & more\n\n[2] Cat\n\n[3] Late\n",
		stderr: "Error: No default value\n", code: 1}, "articles", "{{URL}}/o.xml")
	// A category with attributes cannot be joined.
	check(t, s, want{stdout: "Title: Cat\n", stderr: "Error: No default value\n", code: 1}, "get", "{{URL}}/o.xml", "cat")
	// Nor can an object date be compared with --since: nothing is printed.
	check(t, s, want{stderr: "Error: No default value\n", code: 1}, "articles", "{{URL}}/o.xml", "--since", "2020-01-01")
}

func TestEncodingsMatchBun(t *testing.T) {
	setup(t)
	latin := "<?xml version=\"1.0\"?>\r\n<rss version=\"2.0\"><channel><title>Caf\xe9 \xff</title><item><title>A\r\nB</title><guid>a</guid></item></channel></rss> trailing <junk"
	s := serve(t, map[string]route{
		"/latin.xml": {ctype: "text/xml; charset=ISO-8859-1", body: latin},
		// A quoted charset is not recognized: the body is UTF-8, each bad byte U+FFFD.
		"/quoted.xml": {ctype: `text/xml; charset="ISO-8859-1"`, body: "\xef\xbb\xbf" + latin},
		// Read as Latin-1, the UTF-8 BOM is text before the root.
		"/bom.xml": {ctype: "text/xml; charset=ISO-8859-1", body: "\xef\xbb\xbf" + latin},
	})
	check(t, s, want{stdout: "Title: Café ÿ\nFeed URL: {{URL}}/latin.xml\nArticles: 1\n"}, "info", "{{URL}}/latin.xml")
	// CRLF inside text is kept as sax reads it.
	check(t, s, want{stdout: "Title: A\r\nB\n---\nNo content available\n"}, "get", "{{URL}}/latin.xml", "a")
	check(t, s, want{stdout: "Title: Caf\uFFFD \uFFFD\nFeed URL: {{URL}}/quoted.xml\nArticles: 1\n"}, "info", "{{URL}}/quoted.xml")
	check(t, s, want{stderr: "Error [NOT_FOUND]: Could not find RSS feed for: {{URL}}/bom.xml\nSuggestion: Try providing the direct feed URL instead\n", code: 5},
		"info", "{{URL}}/bom.xml")
}

func TestDiscoveryFollowsBun(t *testing.T) {
	setup(t)
	rdf := `<rdf:RDF><channel><title>RDF Feed</title></channel></rdf:RDF>`
	s := serve(t, map[string]route{
		// A JSON feed is advertised first; parsing it fails and the common
		// paths are tried, none of which exist.
		"/blog":      {ctype: "text/html", body: `<html><head><link rel="alternate" type="application/feed+json" href="/feed.json"><link rel="alternate" type="application/rss+xml" href="/rss091.xml"></head></html>`},
		"/feed.json": {ctype: "application/json", body: `{"version":"https://jsonfeed.org/version/1"}`},
		// A relative href is appended to the blog URL; missing, then /rss.xml.
		"/blog2":         {ctype: "text/html", body: `<html><head><LINK REL="alternate" type="application/atom+xml" href="missing.xml"></head></html>`},
		"/blog2/rss.xml": {body: rdf},
		// An advertised feed that parses is used as is.
		"/blog3":      {ctype: "text/html", body: `<link rel='alternate' type='application/rss+xml' href='/f/rdf.xml'>`},
		"/f/rdf.xml":  {body: rdf},
		"/down":       {status: 500, body: "oops"},
		"/down/feed":  {body: rdf},
		"/rss091.xml": {body: rdf},
	})
	notFound := "Error [NOT_FOUND]: Could not find RSS feed for: {{URL}}/blog\nSuggestion: Try providing the direct feed URL instead\n"
	check(t, s, want{stderr: notFound, code: 5, requests: []string{
		"/blog rss-parser", "/blog agentio-rss/1.0", "/feed.json rss-parser",
		"/blog/feed rss-parser", "/blog/feed.xml rss-parser", "/blog/rss rss-parser", "/blog/rss.xml rss-parser",
		"/blog/atom.xml rss-parser", "/blog/index.xml rss-parser", "/blog/feed/atom rss-parser", "/blog/feed/rss rss-parser",
	}}, "info", "{{URL}}/blog")
	check(t, s, want{stdout: "Title: RDF Feed\nFeed URL: {{URL}}/blog2/rss.xml\nArticles: 0\n", requests: []string{
		"/blog2 rss-parser", "/blog2 agentio-rss/1.0", "/blog2/missing.xml rss-parser",
		"/blog2/feed rss-parser", "/blog2/feed.xml rss-parser", "/blog2/rss rss-parser", "/blog2/rss.xml rss-parser",
		"/blog2/rss.xml rss-parser",
	}}, "info", "{{URL}}/blog2")
	check(t, s, want{stdout: "Title: RDF Feed\nFeed URL: {{URL}}/f/rdf.xml\nArticles: 0\n", requests: []string{
		"/blog3 rss-parser", "/blog3 agentio-rss/1.0", "/f/rdf.xml rss-parser", "/f/rdf.xml rss-parser",
	}}, "info", "{{URL}}/blog3")
	// A page that fails is skipped, not reported.
	check(t, s, want{stdout: "Title: RDF Feed\nFeed URL: {{URL}}/down/feed\nArticles: 0\n", requests: []string{
		"/down rss-parser", "/down agentio-rss/1.0", "/down/feed rss-parser", "/down/feed rss-parser",
	}}, "info", "{{URL}}/down")
}

func TestRedirectsStopAfterFive(t *testing.T) {
	setup(t)
	routes := map[string]route{"/feed.xml": {body: rss2Feed}}
	for i, next := range []string{"/r1", "/r2", "/r3", "/r4", "/r5", "/feed.xml"} {
		routes["/r"+string(rune('0'+i))] = route{location: next}
	}
	s := serve(t, routes)
	info := "Title: Synthetic & Co\u00a0Blog\nFeed URL: {{URL}}/r1\nDescription: Notes about nothing\n" +
		"Site: http://example.test/\nLanguage: en-us\nLast Updated: Tue, 10 Jun 2025 04:00:00 GMT\nArticles: 3\n"
	// /r1 takes five redirects to reach the feed; the feed URL stays /r1.
	check(t, s, want{stdout: info}, "info", "{{URL}}/r1")
	// /r0 needs six: every attempt fails, then discovery gives up.
	check(t, s, want{stderr: "Error [NOT_FOUND]: Could not find RSS feed for: {{URL}}/r0\nSuggestion: Try providing the direct feed URL instead\n", code: 5},
		"info", "{{URL}}/r0")
}

// Each document is one sax, xml2js or rss-parser rejection that Bun turns
// into "Could not find RSS feed"; the last two are accepted.
func TestRejectedDocumentsMatchBun(t *testing.T) {
	setup(t)
	docs := map[string]string{
		"unclosed":    `<rss version="2.0"><channel><title>t</title></channel>`,
		"mismatch":    `<rss version="2.0"><channel><title>t</title></chanel></rss>`,
		"entity":      `<rss version="2.0"><channel><title>&bogus;</title></channel></rss>`,
		"unquoted":    `<rss version="2.0"><channel><title a=b>t</title></channel></rss>`,
		"textfirst":   `x<rss version="2.0"><channel><title>t</title></channel></rss>`,
		"v10":         `<rss version="1.0"><channel><title>t</title></channel></rss>`,
		"nover":       `<rss><channel><title>t</title></channel></rss>`,
		"atomlink":    `<feed><title>t</title><entry><link>http://example.test/</link></entry></feed>`,
		"atomentry":   `<feed><title>t</title><entry/></feed>`,
		"atomdate":    `<feed><title>t</title><entry><published>soon</published></entry></feed>`,
		"empty":       ``,
		"html":        `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>x</body></html>`,
		"underscore":  `<rss version="2.0"><channel><_>x</_><title>t</title></channel></rss>`,
		"comment":     `<rss version="2.0"><channel><title>t</title></channel><!-- a -- b --></rss>`,
		"bigref":      `<rss version="2.0"><channel><title>&#x110000;</title></channel></rss>`,
		"zeroref":     `<rss version="2.0"><channel><title>&#0;</title></channel></rss>`,
		"ctlmarkup":   "<rss version=\"2.0\"><channel><title>t</title><item><description><p>\x01</p></description></item></channel></rss>",
		"ok_trailing": `<rss version="2.0"><channel><title>t &nbsp;&copy;</title></channel></rss><second/> & junk`,
		"ok_dupattr":  `<rss version="2.0" a="1" a="2"><channel><title a="1" a="2">dup</title></channel></rss>`,
	}
	routes := map[string]route{}
	for name, body := range docs {
		routes["/"+name] = route{body: body}
	}
	s := serve(t, routes)
	for name := range docs {
		w := want{stderr: "Error [NOT_FOUND]: Could not find RSS feed for: {{URL}}/" + name + "\nSuggestion: Try providing the direct feed URL instead\n", code: 5}
		switch name {
		case "ok_trailing":
			w = want{stdout: "Title: t \u00a0©\nFeed URL: {{URL}}/ok_trailing\nArticles: 0\n"}
		case "ok_dupattr":
			w = want{stdout: "Title: dup\nFeed URL: {{URL}}/ok_dupattr\nArticles: 0\n"}
		}
		check(t, s, w, "info", "{{URL}}/"+name)
	}
}

// Bun has no --json for rss; the host's --json prints the RssArticle
// fields Bun builds, leaving out the undefined ones.
func TestJSONUsesTheBunArticleFields(t *testing.T) {
	setup(t)
	s := serve(t, map[string]route{"/feed.xml": {body: rss2Feed}})
	stdout, _, code := run(t, "get", s.url+"/feed.xml", "guid-3", "--json")
	if code != 0 || stdout != "{\n  \"id\": \"guid-3\",\n  \"title\": \"Undated\"\n}\n" {
		t.Fatalf("%d %s", code, stdout)
	}
	stdout, _, _ = run(t, "articles", s.url+"/feed.xml", "--limit", "1", "--json")
	var got struct {
		Feed     string
		Articles []map[string]any
	}
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatal(err)
	}
	a := got.Articles[0]
	if got.Feed != "Synthetic & Co\u00a0Blog" || len(got.Articles) != 1 || a["content"] != "<p>Full content</p>" ||
		a["description"] != "Hello world & friends\u00a0there\nSecond é" || len(a["categories"].([]any)) != 2 {
		t.Fatalf("%s", stdout)
	}
}

// RSS has no profile in Bun: no profile commands, no --profile flag, and
// it registers right after revolut.
func TestRegisteredWithoutProfile(t *testing.T) {
	setup(t)
	p := plugins.Default.Find("rss")
	if p == nil || p.Profile != nil {
		t.Fatalf("rss plugin %+v", p)
	}
	var ids []string
	for _, q := range plugins.Default.Plugins() {
		ids = append(ids, q.ID)
	}
	joined := strings.Join(ids, " ")
	if !strings.Contains(joined, "revolut rss") {
		t.Fatalf("order %s", joined)
	}
	s := serve(t, map[string]route{"/feed.xml": {body: rss2Feed}})
	if _, _, code := run(t, "info", s.url+"/feed.xml", "--profile", "x"); code == 0 {
		t.Fatal("--profile accepted")
	}
	if stdout, _, _ := run(t, "profile", "list"); strings.Contains(stdout, "profile") {
		t.Fatalf("rss has profile commands:\n%s", stdout)
	}
	if len(s.requests()) != 0 {
		t.Fatalf("requests %v", s.requests())
	}
	stdout, _, _ := run(t, "--help")
	for _, leaf := range []string{"articles", "get", "info"} {
		if !strings.Contains(stdout, "  "+leaf+" ") {
			t.Errorf("help lacks %s:\n%s", leaf, stdout)
		}
	}
}

func TestCommandTableMatchesBun(t *testing.T) {
	type row struct{ args, flags, access string }
	want := map[string]row{
		"articles": {"<url>", "--limit <n>=20 --since <date>", "read"},
		"get":      {"<url> <article-id>", "", "read"},
		"info":     {"<url>", "", "read"},
	}
	p := plugins.Default.Find("rss")
	if p.DisplayName != "RSS" || p.Description != "Use when reading RSS feeds via the agentio CLI." || len(p.Commands) != len(want) {
		t.Fatalf("%q %q %d", p.DisplayName, p.Description, len(p.Commands))
	}
	for _, c := range p.Commands {
		var args, flags []string
		for _, a := range c.Arguments {
			if !a.Required {
				t.Errorf("%s: optional %s", c.Path, a.Name)
			}
			args = append(args, "<"+a.Name+">")
		}
		for _, o := range c.Options {
			f := o.Flags
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			flags = append(flags, f)
		}
		if got := (row{strings.Join(args, " "), strings.Join(flags, " "), c.Access}); got != want[c.Path] {
			t.Errorf("%s: %#v want %#v", c.Path, got, want[c.Path])
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
}
