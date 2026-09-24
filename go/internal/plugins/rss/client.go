package rss

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// commonFeedPaths is COMMON_FEED_PATHS, tried in order after the page's
// advertised feed.
var commonFeedPaths = []string{"/feed", "/feed.xml", "/rss", "/rss.xml", "/atom.xml", "/index.xml", "/feed/atom", "/feed/rss"}

const (
	maxRedirects = 5                // rss-parser DEFAULT_MAX_REDIRECTS
	parseTimeout = 60 * time.Second // rss-parser DEFAULT_TIMEOUT
)

type fetchFunc = func(ctx context.Context, req *http.Request) (*http.Response, error)

// feedHTTP is the client behind rss-parser's parseURL (Node http.get): it
// does not follow redirects itself, parseURL does.
var feedHTTP = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// client is RssClient. fetch is Bun's fetch, used to read the blog page.
type client struct {
	ctx   context.Context
	fetch fetchFunc
	fail  plugins.FailFunc
}

// parseURL is rss-parser Parser.parseURL: GET with its headers, redirects
// followed by hand (at most five), any other status from 300 up an error,
// the body decoded by the Content-Type charset, then parsed.
func (c *client) parseURL(feedURL string) (*feed, error) {
	ctx, cancel := context.WithTimeout(c.ctx, parseTimeout)
	defer cancel()
	for redirects := 0; ; redirects++ {
		u, err := url.Parse(feedURL)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(feedURL, "https") != (u.Scheme == "https") || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("Protocol %q not supported", u.Scheme+":")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "rss-parser")
		req.Header.Set("Accept", "application/rss+xml")
		res, err := feedHTTP.Do(req)
		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return nil, fmt.Errorf("Request timed out after %dms", parseTimeout.Milliseconds())
			}
			return nil, err
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		if loc := res.Header.Get("Location"); res.StatusCode >= 300 && res.StatusCode < 400 && loc != "" {
			if redirects == maxRedirects {
				return nil, errors.New("Too many redirects")
			}
			next, err := u.Parse(loc)
			if err != nil {
				return nil, err
			}
			feedURL = next.String()
			continue
		}
		if res.StatusCode >= 300 {
			return nil, fmt.Errorf("Status code %d", res.StatusCode)
		}
		return parseFeedXML(decodeBody(body, res.Header.Get("Content-Type")))
	}
}

var charsetParam = regexp.MustCompile(`(encoding|charset)\s*=\s*(\S+)`)

// decodeBody is res.setEncoding(utils.getEncodingFromContentType(type)):
// UTF-8 unless the header names another encoding Node supports.
func decodeBody(body []byte, contentType string) string {
	enc := ""
	if m := charsetParam.FindStringSubmatch(contentType); m != nil {
		enc = strings.ToLower(m[2])
	}
	switch enc {
	case "iso-8859-1", "latin1", "binary":
		runes := make([]rune, len(body))
		for i, b := range body {
			runes[i] = rune(b)
		}
		return string(runes)
	case "ascii":
		runes := make([]rune, len(body))
		for i, b := range body {
			runes[i] = rune(b & 0x7f)
		}
		return string(runes)
	case "utf16le", "ucs2":
		units := make([]uint16, len(body)/2)
		for i := range units {
			units[i] = uint16(body[2*i]) | uint16(body[2*i+1])<<8
		}
		return string(utf16.Decode(units))
	case "base64", "hex":
		// The text is the encoded bytes, which never parses as a feed.
		return fmt.Sprintf("%x", body)
	}
	return jsvalue.BufferString(body)
}

// discoverFeed is RssClient.discoverFeed: the URL itself, then the feed the
// page advertises, then the common paths. Every failure along the way is
// swallowed.
func (c *client) discoverFeed(raw string) (string, error) {
	base := jsvalue.Trim(raw)
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	base = strings.TrimSuffix(base, "/")

	if _, err := c.parseURL(base); err == nil {
		return base, nil
	}
	if page, ok := c.fetchPage(base); ok {
		if advertised := extractFeedURL(page, base); advertised != "" {
			if _, err := c.parseURL(advertised); err == nil {
				return advertised, nil
			}
		}
	}
	for _, path := range commonFeedPaths {
		if _, err := c.parseURL(base + path); err == nil {
			return base + path, nil
		}
	}
	return "", c.fail("NOT_FOUND", "Could not find RSS feed for: "+raw, "Try providing the direct feed URL instead")
}

// fetchPage is `fetch(baseUrl, { headers: { 'User-Agent': 'agentio-rss/1.0' } })`
// and response.text() when the response is ok.
func (c *client) fetchPage(pageURL string) (string, bool) {
	req, err := http.NewRequestWithContext(c.ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", "agentio-rss/1.0")
	res, err := c.fetch(c.ctx, req)
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", false
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", false
	}
	return jsvalue.DecodeUTF8(body), true
}

var (
	alternateLink = regexp.MustCompile(`(?i)<link[^>]*rel=["']alternate["'][^>]*>`)
	hrefAttr      = regexp.MustCompile(`(?i)href=["']([^"']+)["']`)
)

// extractFeedURL is RssClient.extractFeedUrl: the first alternate link of an
// RSS, Atom or JSON feed type, made absolute against the blog URL.
func extractFeedURL(page, base string) string {
	for _, link := range alternateLink.FindAllString(page, -1) {
		if !strings.Contains(link, "application/rss+xml") && !strings.Contains(link, "application/atom+xml") &&
			!strings.Contains(link, "application/feed+json") {
			continue
		}
		m := hrefAttr.FindStringSubmatch(link)
		if m == nil {
			// Bun moves on to the next link only when this one has no href.
			continue
		}
		href := m[1]
		switch {
		case strings.HasPrefix(href, "/"):
			href = origin(base) + href
		case !strings.HasPrefix(href, "http"):
			href = base + "/" + href
		}
		return href
	}
	return ""
}

// origin is new URL(base).origin: scheme and host, without a default port.
func origin(base string) string {
	u, err := url.Parse(base)
	if err != nil {
		return "null"
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && !(scheme == "http" && port == "80") && !(scheme == "https" && port == "443") {
		host += ":" + port
	}
	return scheme + "://" + host
}

// getFeed is RssClient.getFeed on a URL discoverFeed already accepted.
func (c *client) getFeed(feedURL string) (*feed, error) {
	f, err := c.parseURL(feedURL)
	if err == nil {
		return f, nil
	}
	var dnsErr *net.DNSError
	switch msg := err.Error(); {
	case errors.As(err, &dnsErr) || errors.Is(err, syscall.ECONNREFUSED):
		return nil, c.fail("NETWORK_ERROR", "Cannot reach feed: "+feedURL, "Check the URL and your internet connection")
	case strings.Contains(msg, "Non-whitespace before first tag") || strings.Contains(msg, "Invalid XML"):
		return nil, c.fail("INVALID_PARAMS", "Invalid RSS feed format", "The URL may not be an RSS feed")
	default:
		return nil, c.fail("API_ERROR", "Failed to parse feed: "+jsErrorString(err), "Verify the feed URL is valid")
	}
}

// jsErrorString is String(error): "Error: message" unless the message
// already carries its TypeError or RangeError name.
func jsErrorString(err error) string {
	msg := err.Error()
	if strings.HasPrefix(msg, "TypeError: ") || strings.HasPrefix(msg, "RangeError: ") {
		return msg
	}
	return "Error: " + msg
}

// info is RssClient.getInfo: the feed and the URL it was found at.
type info struct {
	*feed
	FeedURL string `json:"feedUrl"`
}

func (c *client) getInfo(raw string) (*info, error) {
	feedURL, err := c.discoverFeed(raw)
	if err != nil {
		return nil, err
	}
	f, err := c.getFeed(feedURL)
	if err != nil {
		return nil, err
	}
	return &info{feed: f, FeedURL: feedURL}, nil
}

// list is RssClient.list: articles published on or after since (an article
// without a date is kept), then the first limit of them.
func (c *client) list(raw string, limit float64, since *time.Time, sinceValid bool) ([]article, error) {
	feedURL, err := c.discoverFeed(raw)
	if err != nil {
		return nil, err
	}
	f, err := c.getFeed(feedURL)
	if err != nil {
		return nil, err
	}
	articles := f.Items
	if since != nil {
		kept := []article{}
		for _, a := range articles {
			if !jsvalue.Truthy(a.PubDate) {
				kept = append(kept, a)
				continue
			}
			// new Date(pubDate) >= since: an Invalid Date on either side is
			// false, and an element object cannot become a date at all.
			s, ok := a.PubDate.(string)
			if !ok {
				return nil, errNoDefault
			}
			if t, ok := jsvalue.ParseDate(s); ok && sinceValid && !t.Before(*since) {
				kept = append(kept, a)
			}
		}
		articles = kept
	}
	return jsSlice(articles, limit), nil
}

// jsSlice is articles.slice(0, limit).
func jsSlice(items []article, limit float64) []article {
	n := float64(len(items))
	switch {
	case limit != limit: // NaN
		limit = 0
	case limit < 0:
		limit = max(n+limit, 0)
	case limit > n:
		limit = n
	}
	return items[:int(limit)]
}

// get is RssClient.get: the article whose id or link is exactly articleID.
func (c *client) get(raw, articleID string) (*article, error) {
	feedURL, err := c.discoverFeed(raw)
	if err != nil {
		return nil, err
	}
	f, err := c.getFeed(feedURL)
	if err != nil {
		return nil, err
	}
	for i := range f.Items {
		a := &f.Items[i]
		if a.ID == any(articleID) || a.Link == any(articleID) {
			return a, nil
		}
	}
	return nil, c.fail("NOT_FOUND", "Article not found: "+articleID, `Use "agentio rss articles" to list available articles`)
}
