package confluence

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
)

// The models are the Bun client's objects (ConfluenceSpace, ConfluencePage,
// ...), built from the answer as JavaScript reads it: a missing field is
// undefined (left out of --json, "undefined" in text), and reading a field of
// null or undefined fails with Bun's TypeError.

type api struct {
	atlassian.Client
	cloudID string
	siteURL string
}

func apiFrom(ctx context.Context, run *plugins.RunContext) api {
	return api{
		Client:  atlassian.NewClient(ctx, run, "Confluence API error"),
		cloudID: atlassian.Str(run.Credentials, "cloudId"),
		siteURL: atlassian.Str(run.Credentials, "siteUrl"),
	}
}

func (a api) v2() string {
	return "https://api.atlassian.com/ex/confluence/" + a.cloudID + "/wiki/api/v2"
}

func (a api) v1() string {
	return "https://api.atlassian.com/ex/confluence/" + a.cloudID + "/wiki/rest/api"
}

func (a api) webURL(path string) string {
	return strings.TrimSuffix(a.siteURL, "/") + "/wiki" + path
}

func (a api) request(method, base, path string, body any) (any, error) {
	return a.Request(method, base+path, body)
}

// Bun's request() calls as the transpiled source shows them in a TypeError.
const (
	spacesText   = "(await this.request(\"GET\", this.baseV2, `/spaces?${params.toString()}`))"
	pagesText    = `(await this.request("GET", this.baseV2, path))`
	commentsText = "(await this.request(\"GET\", this.baseV2, `/pages/${pageId}/footer-comments?body-format=storage`))"
	commentText  = "(await this.request(\"POST\", this.baseV2, \"/footer-comments\", {\n        pageId,\n        body: {\n          representation: \"storage\",\n          value: storage\n        }\n      }))"
	searchText   = "(await this.request(\"GET\", this.baseV1, `/search?${params.toString()}`))"
)

// mapItems is `text.map(f)` over the answer at text.
func mapItems(list any, text string, f func(item any) (*jsvalue.Object, error)) ([]any, error) {
	items, err := jsvalue.Items(list, text)
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(items))
	for _, item := range items {
		o, err := f(item)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, nil
}

// results is `text.results.map(f)`.
func results(response any, text string, f func(item any) (*jsvalue.Object, error)) ([]any, error) {
	list, err := jsvalue.Path(response, text, "results")
	if err != nil {
		return nil, err
	}
	return mapItems(list, text+".results", f)
}

// webLink is `raw._links?.webui ? this.webUrl(raw._links.webui) : undefined`.
func (a api) webLink(raw any) any {
	webui := jsvalue.Optional(jsvalue.Member(raw, "_links"), "webui")
	if !jsvalue.Truthy(webui) {
		return jsvalue.Undefined
	}
	return a.webURL(jsvalue.String(webui))
}

// query is Bun's `${path}?${params.toString()}` over URLSearchParams set in
// the order given.
func query(path string, kv ...string) string {
	q := jsvalue.NewSearchParams()
	for i := 0; i+1 < len(kv); i += 2 {
		q.Set(kv[i], kv[i+1])
	}
	return path + "?" + q.String()
}

// spaceModel is the ConfluenceSpace Bun builds from raw, read as text.
func spaceModel(raw any, text string) (*jsvalue.Object, error) {
	if jsvalue.Nullish(raw) {
		return nil, jsvalue.TypeError(raw, text+".id")
	}
	o := atlassian.Pick(raw, "id", "id", "key", "key", "name", "name", "type", "type", "status", "status", "homepageId", "homepageId")
	o.Set("description", jsvalue.Optional(jsvalue.Optional(jsvalue.Member(raw, "description"), "plain"), "value"))
	return o, nil
}

func (a api) listSpaces(limit, typ string) ([]any, error) {
	pairs := []string{"limit", limit}
	if typ != "" {
		pairs = append(pairs, "type", typ)
	}
	response, err := a.request(http.MethodGet, a.v2(), query("/spaces", pairs...), nil)
	if err != nil {
		return nil, err
	}
	return results(response, spacesText, func(s any) (*jsvalue.Object, error) { return spaceModel(s, "s") })
}

func digitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func (a api) getSpace(idOrKey string) (*jsvalue.Object, error) {
	if digitsOnly(idOrKey) {
		s, err := a.request(http.MethodGet, a.v2(), "/spaces/"+idOrKey, nil)
		if err != nil {
			return nil, err
		}
		return spaceModel(s, "s")
	}
	response, err := a.request(http.MethodGet, a.v2(), query("/spaces", "keys", idOrKey, "limit", "1"), nil)
	if err != nil {
		return nil, err
	}
	list, err := jsvalue.Path(response, spacesText, "results")
	if err != nil {
		return nil, err
	}
	if jsvalue.Nullish(list) {
		return nil, jsvalue.TypeError(list, spacesText+".results[0]")
	}
	match := jsvalue.Member(list, "0")
	if !jsvalue.Truthy(match) {
		return nil, a.Fail("NOT_FOUND", fmt.Sprintf("Space \"%s\" not found", idOrKey), "")
	}
	return spaceModel(match, "match")
}

// spaceIDFor is Bun's `let spaceId = options.spaceId; if (!spaceId &&
// options.spaceKey) spaceId = (await this.getSpace(key)).id`.
func (a api) spaceIDFor(spaceKey, spaceID string) (any, error) {
	if spaceID != "" || spaceKey == "" {
		return spaceID, nil
	}
	found, err := a.getSpace(spaceKey)
	if err != nil {
		return nil, err
	}
	return jsvalue.Member(found, "id"), nil
}

// pageModel is the ConfluencePage Bun builds from raw, read as text.
func (a api) pageModel(raw any, text string) (*jsvalue.Object, error) {
	if jsvalue.Nullish(raw) {
		return nil, jsvalue.TypeError(raw, text+".id")
	}
	o := atlassian.Pick(raw, "id", "id", "title", "title", "spaceId", "spaceId", "status", "status",
		"parentId", "parentId", "authorId", "authorId", "createdAt", "createdAt")
	version, err := jsvalue.Path(raw, text, "version", "number")
	if err != nil {
		return nil, err
	}
	o.Set("version", version)
	o.Set("webUrl", a.webLink(raw))
	return o, nil
}

func (a api) listPages(spaceKey, spaceID, parentID, limit string) ([]any, error) {
	id, err := a.spaceIDFor(spaceKey, spaceID)
	if err != nil {
		return nil, err
	}
	pairs := []string{"limit", limit}
	if parentID != "" {
		pairs = append(pairs, "parent-id", parentID)
	}
	path := query("/pages", pairs...)
	if jsvalue.Truthy(id) {
		path = query("/spaces/"+jsvalue.String(id)+"/pages", pairs...)
	}
	response, err := a.request(http.MethodGet, a.v2(), path, nil)
	if err != nil {
		return nil, err
	}
	return results(response, pagesText, func(p any) (*jsvalue.Object, error) { return a.pageModel(p, "p") })
}

func (a api) getPage(pageID, bodyFormat string) (*jsvalue.Object, error) {
	response, err := a.request(http.MethodGet, a.v2(), query("/pages/"+pageID, "body-format", bodyFormat), nil)
	if err != nil {
		return nil, err
	}
	if jsvalue.Nullish(response) {
		return nil, jsvalue.TypeError(response, "response.body")
	}
	body := pageBody(jsvalue.Member(response, "body"), bodyFormat)
	detail, err := a.pageModel(response, "response")
	if err != nil {
		return nil, err
	}
	detail.Set("body", body)
	detail.Set("bodyFormat", bodyFormat)
	return detail, nil
}

// pageBody is getPage's body: the requested representation made plain text,
// storage as the fallback, "" when there is none.
func pageBody(body any, bodyFormat string) any {
	value := func(format string) any { return jsvalue.Optional(jsvalue.Optional(body, format), "value") }
	if atlas := value("atlas_doc_format"); bodyFormat == "atlas_doc_format" && jsvalue.Truthy(atlas) {
		adf, err := jsvalue.Parse([]byte(jsvalue.String(atlas)))
		if err != nil {
			return atlas
		}
		return atlassian.ExtractTextFromADF(adf)
	}
	if view := value("view"); bodyFormat == "view" && jsvalue.Truthy(view) {
		return stripHTML(jsvalue.String(view))
	}
	if storage := value("storage"); jsvalue.Truthy(storage) {
		return stripHTML(jsvalue.String(storage))
	}
	return ""
}

// storageBody is `{ representation: 'storage', value: storage }`.
func storageBody(text string) *jsvalue.Object {
	body := jsvalue.NewObject()
	body.Set("representation", "storage")
	body.Set("value", textToStorage(text))
	return body
}

func (a api) createPage(spaceKey, spaceID, title string, parentID *string, body string) (*jsvalue.Object, error) {
	id, err := a.spaceIDFor(spaceKey, spaceID)
	if err != nil {
		return nil, err
	}
	if !jsvalue.Truthy(id) {
		return nil, a.Fail("INVALID_PARAMS", "spaceId or spaceKey is required to create a page", "")
	}
	payload := jsvalue.NewObject()
	payload.Set("spaceId", id)
	payload.Set("status", "current")
	payload.Set("title", title)
	payload.Set("parentId", jsvalue.Undefined)
	if parentID != nil { // Bun sends a given "" as is.
		payload.Set("parentId", *parentID)
	}
	payload.Set("body", storageBody(body))
	response, err := a.request(http.MethodPost, a.v2(), "/pages", payload)
	if err != nil {
		return nil, err
	}
	if jsvalue.Nullish(response) {
		return nil, jsvalue.TypeError(response, "response.id")
	}
	created := atlassian.Pick(response, "id", "id", "title", "title", "spaceId", "spaceId")
	created.Set("webUrl", a.webLink(response))
	return created, nil
}

// plusOne is JavaScript's `v + 1`.
func plusOne(v any) any {
	switch x := v.(type) {
	case nil:
		return 1.0
	case bool:
		if x {
			return 2.0
		}
		return 1.0
	case string:
		return x + "1"
	case json.Number, float64:
		return jsvalue.Number(jsvalue.String(x)) + 1
	case *jsvalue.Object, []any:
		return jsvalue.String(x) + "1"
	}
	return math.NaN() // undefined + 1
}

func (a api) updatePage(pageID string, title *string, body string) (*jsvalue.Object, error) {
	current, err := a.getPage(pageID, "storage")
	if err != nil {
		return nil, err
	}
	payload := jsvalue.NewObject()
	payload.Set("id", pageID)
	payload.Set("status", jsvalue.Member(current, "status"))
	if title != nil { // Bun `params.title ?? current.title`: "" is kept.
		payload.Set("title", *title)
	} else {
		payload.Set("title", jsvalue.Member(current, "title"))
	}
	payload.Set("body", storageBody(body))
	version := jsvalue.NewObject()
	version.Set("number", plusOne(jsvalue.Member(current, "version")))
	payload.Set("version", version)
	response, err := a.request(http.MethodPut, a.v2(), "/pages/"+pageID, payload)
	if err != nil {
		return nil, err
	}
	if jsvalue.Nullish(response) {
		return nil, jsvalue.TypeError(response, "response.id")
	}
	updated := atlassian.Pick(response, "id", "id", "title", "title")
	number, err := jsvalue.Path(response, "response", "version", "number")
	if err != nil {
		return nil, err
	}
	updated.Set("version", number)
	return updated, nil
}

func (a api) listComments(pageID string) ([]any, error) {
	response, err := a.request(http.MethodGet, a.v2(), "/pages/"+pageID+"/footer-comments?body-format=storage", nil)
	if err != nil {
		return nil, err
	}
	return results(response, commentsText, func(c any) (*jsvalue.Object, error) {
		if jsvalue.Nullish(c) {
			return nil, jsvalue.TypeError(c, "c.id")
		}
		o := atlassian.Pick(c, "id", "id")
		o.Set("pageId", pageID)
		o.Set("authorId", jsvalue.Member(c, "authorId"))
		body := any("")
		if storage := jsvalue.Optional(jsvalue.Optional(jsvalue.Member(c, "body"), "storage"), "value"); jsvalue.Truthy(storage) {
			body = stripHTML(jsvalue.String(storage))
		}
		o.Set("body", body)
		o.Set("createdAt", jsvalue.Member(c, "createdAt"))
		version, err := jsvalue.Path(c, "c", "version", "number")
		if err != nil {
			return nil, err
		}
		o.Set("version", version)
		return o, nil
	})
}

func (a api) addComment(pageID, body string) (*jsvalue.Object, error) {
	payload := jsvalue.NewObject()
	payload.Set("pageId", pageID)
	payload.Set("body", storageBody(body))
	response, err := a.request(http.MethodPost, a.v2(), "/footer-comments", payload)
	if err != nil {
		return nil, err
	}
	id, err := jsvalue.Path(response, commentText, "id")
	if err != nil {
		return nil, err
	}
	out := jsvalue.NewObject()
	out.Set("id", id)
	out.Set("pageId", pageID)
	return out, nil
}

func (a api) search(cql, spaceKey, typ, text, limit string) ([]any, error) {
	var parts []string
	if cql != "" {
		parts = append(parts, cql)
	}
	if spaceKey != "" {
		parts = append(parts, `space.key = "`+spaceKey+`"`)
	}
	if typ != "" {
		parts = append(parts, `type = "`+typ+`"`)
	}
	if text != "" {
		parts = append(parts, `text ~ "`+strings.ReplaceAll(text, `"`, `\"`)+`"`)
	}
	queryCQL := strings.Join(parts, " AND ")
	if queryCQL == "" {
		queryCQL = `type = "page" ORDER BY lastmodified DESC`
	}
	response, err := a.request(http.MethodGet, a.v1(), query("/search", "cql", queryCQL, "limit", limit), nil)
	if err != nil {
		return nil, err
	}
	return results(response, searchText, a.searchModel)
}

// orElse is `v ?? fallback`.
func orElse(v, fallback any) any {
	if jsvalue.Nullish(v) {
		return fallback
	}
	return v
}

// searchModel is the ConfluenceSearchResult Bun maps each hit to.
func (a api) searchModel(r any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(r) {
		return nil, jsvalue.TypeError(r, "r.content")
	}
	content := jsvalue.Member(r, "content")
	o := jsvalue.NewObject()
	o.Set("id", orElse(jsvalue.Optional(content, "id"), ""))
	o.Set("type", orElse(jsvalue.Optional(content, "type"), "unknown"))
	o.Set("title", orElse(jsvalue.Optional(content, "title"), orElse(jsvalue.Member(r, "title"), "(untitled)")))
	o.Set("spaceKey", jsvalue.Optional(jsvalue.Optional(content, "space"), "key"))
	o.Set("url", jsvalue.Undefined)
	if url := jsvalue.Member(r, "url"); jsvalue.Truthy(url) {
		o.Set("url", a.webURL(jsvalue.String(url)))
	}
	o.Set("excerpt", jsvalue.Undefined)
	if excerpt := jsvalue.Member(r, "excerpt"); jsvalue.Truthy(excerpt) {
		o.Set("excerpt", stripHTML(jsvalue.String(excerpt)))
	}
	o.Set("lastModified", jsvalue.Member(r, "lastModified"))
	return o, nil
}

func textToStorage(text string) string {
	blocks := regexp.MustCompile(`\n\n+`).Split(text, -1)
	var b strings.Builder
	for _, block := range blocks {
		escaped := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(block)
		escaped = strings.ReplaceAll(escaped, "\n", "<br/>")
		b.WriteString("<p>")
		b.WriteString(escaped)
		b.WriteString("</p>")
	}
	return b.String()
}

var (
	reBR    = regexp.MustCompile(`(?i)<br\s*/?>`)
	rePPair = regexp.MustCompile(`(?i)</p>\s*<p[^>]*>`)
	reP     = regexp.MustCompile(`(?i)</?p[^>]*>`)
	reTag   = regexp.MustCompile(`<[^>]+>`)
	reNL    = regexp.MustCompile(`\n{3,}`)
)

func stripHTML(html string) string {
	html = reBR.ReplaceAllString(html, "\n")
	html = rePPair.ReplaceAllString(html, "\n\n")
	html = reP.ReplaceAllString(html, "")
	html = reTag.ReplaceAllString(html, "")
	html = strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
	).Replace(html)
	html = reNL.ReplaceAllString(html, "\n\n")
	return jsvalue.Trim(html)
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	a := apiFrom(ctx, run)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.v2()+"/spaces?limit=1", nil)
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	req.Header.Set("Authorization", "Bearer "+a.Access)
	req.Header.Set("Accept", "application/json")
	resp, err := run.Fetch(ctx, req)
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return plugins.ValidationResult{Valid: true, Info: a.siteURL}, nil
	}
	return plugins.ValidationResult{Valid: false, Error: fmt.Sprintf("API returned %d", resp.StatusCode)}, nil
}

// limitQuery is Bun `parseInt(options.limit, 10)`, then `limit ?? fallback`:
// only an absent --limit takes the fallback, a given "" is NaN.
func limitQuery(in plugins.CommandInput, fallback int) string {
	raw, given := in.LookupOption("limit")
	if !given {
		return strconv.Itoa(fallback)
	}
	n, ok := jsParseInt(raw)
	if !ok {
		return "NaN"
	}
	return strconv.Itoa(n)
}

func jsParseInt(s string) (int, bool) {
	i := 0
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			i++
			continue
		}
		break
	}
	if i >= len(s) {
		return 0, false
	}
	sign := 1
	if s[i] == '+' || s[i] == '-' {
		if s[i] == '-' {
			sign = -1
		}
		i++
	}
	if i >= len(s) || s[i] < '0' || s[i] > '9' {
		return 0, false
	}
	n := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		n = n*10 + int(s[i]-'0')
		i++
	}
	return sign * n, true
}
