package confluence

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
)

type space struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	HomepageID  string `json:"homepageId,omitempty"`
	Description string `json:"description,omitempty"`
}

type page struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	SpaceID   string `json:"spaceId"`
	Status    string `json:"status"`
	ParentID  string `json:"parentId,omitempty"`
	AuthorID  string `json:"authorId,omitempty"`
	CreatedAt string `json:"createdAt"`
	Version   int    `json:"version"`
	WebURL    string `json:"webUrl,omitempty"`
}

// pageDetail is ConfluencePageDetail: the page plus its extracted body.
type pageDetail struct {
	page
	Body       string `json:"body"`
	BodyFormat string `json:"bodyFormat"`
}

type comment struct {
	ID        string `json:"id"`
	PageID    string `json:"pageId"`
	AuthorID  string `json:"authorId,omitempty"`
	Body      string `json:"body"`
	CreatedAt string `json:"createdAt"`
	Version   int    `json:"version"`
}

type searchResult struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	Title        string `json:"title"`
	SpaceKey     string `json:"spaceKey,omitempty"`
	URL          string `json:"url,omitempty"`
	Excerpt      string `json:"excerpt,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
}

type pageCreated struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	SpaceID string `json:"spaceId"`
	WebURL  string `json:"webUrl,omitempty"`
}

type pageUpdated struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Version int    `json:"version"`
}

type commentCreated struct {
	ID     string `json:"id"`
	PageID string `json:"pageId"`
}

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

func (a api) request(method, base, path string, body any, out any) error {
	return a.Request(method, base+path, body, out)
}

func query(path string, kv ...string) string {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	if len(v) == 0 {
		return path
	}
	return path + "?" + v.Encode()
}

type apiSpace struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	HomepageID  string `json:"homepageId"`
	Description *struct {
		Plain *struct {
			Value string `json:"value"`
		} `json:"plain"`
	} `json:"description"`
}

func (s apiSpace) model() space {
	desc := ""
	if s.Description != nil && s.Description.Plain != nil {
		desc = s.Description.Plain.Value
	}
	return space{ID: s.ID, Key: s.Key, Name: s.Name, Type: s.Type, Status: s.Status, HomepageID: s.HomepageID, Description: desc}
}

func (a api) listSpaces(limit, typ string) ([]space, error) {
	pairs := []string{"limit", limit}
	if typ != "" {
		pairs = append(pairs, "type", typ)
	}
	var payload struct {
		Results []apiSpace `json:"results"`
	}
	if err := a.request(http.MethodGet, a.v2(), query("/spaces", pairs...), nil, &payload); err != nil {
		return nil, err
	}
	out := make([]space, 0, len(payload.Results))
	for _, s := range payload.Results {
		out = append(out, s.model())
	}
	return out, nil
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

func (a api) getSpace(idOrKey string) (space, error) {
	if digitsOnly(idOrKey) {
		var s apiSpace
		if err := a.request(http.MethodGet, a.v2(), "/spaces/"+idOrKey, nil, &s); err != nil {
			return space{}, err
		}
		return s.model(), nil
	}
	var payload struct {
		Results []apiSpace `json:"results"`
	}
	if err := a.request(http.MethodGet, a.v2(), query("/spaces", "keys", idOrKey, "limit", "1"), nil, &payload); err != nil {
		return space{}, err
	}
	if len(payload.Results) == 0 {
		return space{}, a.Fail("NOT_FOUND", fmt.Sprintf("Space %q not found", idOrKey), "")
	}
	return payload.Results[0].model(), nil
}

type apiPage struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	SpaceID   string `json:"spaceId"`
	Status    string `json:"status"`
	ParentID  string `json:"parentId"`
	AuthorID  string `json:"authorId"`
	CreatedAt string `json:"createdAt"`
	Version   struct {
		Number float64 `json:"number"`
	} `json:"version"`
	Links struct {
		WebUI string `json:"webui"`
	} `json:"_links"`
	Body *struct {
		Storage *struct {
			Value string `json:"value"`
		} `json:"storage"`
		Atlas *struct {
			Value string `json:"value"`
		} `json:"atlas_doc_format"`
		View *struct {
			Value string `json:"value"`
		} `json:"view"`
	} `json:"body"`
}

func (a api) pageModel(p apiPage) page {
	out := page{
		ID: p.ID, Title: p.Title, SpaceID: p.SpaceID, Status: p.Status,
		ParentID: p.ParentID, AuthorID: p.AuthorID, CreatedAt: p.CreatedAt, Version: int(p.Version.Number),
	}
	if p.Links.WebUI != "" {
		out.WebURL = a.webURL(p.Links.WebUI)
	}
	return out
}

func (a api) listPages(spaceKey, spaceID, parentID, limit string) ([]page, error) {
	if spaceID == "" && spaceKey != "" {
		found, err := a.getSpace(spaceKey)
		if err != nil {
			return nil, err
		}
		spaceID = found.ID
	}
	pairs := []string{"limit", limit}
	if parentID != "" {
		pairs = append(pairs, "parent-id", parentID)
	}
	path := query("/pages", pairs...)
	if spaceID != "" {
		path = query("/spaces/"+spaceID+"/pages", pairs...)
	}
	var payload struct {
		Results []apiPage `json:"results"`
	}
	if err := a.request(http.MethodGet, a.v2(), path, nil, &payload); err != nil {
		return nil, err
	}
	out := make([]page, 0, len(payload.Results))
	for _, p := range payload.Results {
		out = append(out, a.pageModel(p))
	}
	return out, nil
}

func (a api) getPage(pageID, bodyFormat string) (pageDetail, error) {
	var response apiPage
	path := query("/pages/"+pageID, "body-format", bodyFormat)
	if err := a.request(http.MethodGet, a.v2(), path, nil, &response); err != nil {
		return pageDetail{}, err
	}
	return pageDetail{page: a.pageModel(response), Body: pageBody(response, bodyFormat), BodyFormat: bodyFormat}, nil
}

func pageBody(response apiPage, bodyFormat string) string {
	if response.Body == nil {
		return ""
	}
	if bodyFormat == "atlas_doc_format" && response.Body.Atlas != nil && response.Body.Atlas.Value != "" {
		var adf any
		if err := json.Unmarshal([]byte(response.Body.Atlas.Value), &adf); err != nil {
			return response.Body.Atlas.Value
		}
		return atlassian.ExtractTextFromADF(adf)
	}
	if bodyFormat == "view" && response.Body.View != nil && response.Body.View.Value != "" {
		return stripHTML(response.Body.View.Value)
	}
	if response.Body.Storage != nil && response.Body.Storage.Value != "" {
		return stripHTML(response.Body.Storage.Value)
	}
	return ""
}

func (a api) createPage(spaceKey, spaceID, title string, parentID *string, body string) (pageCreated, error) {
	if spaceID == "" && spaceKey != "" {
		found, err := a.getSpace(spaceKey)
		if err != nil {
			return pageCreated{}, err
		}
		spaceID = found.ID
	}
	if spaceID == "" {
		return pageCreated{}, a.Fail("INVALID_PARAMS", "spaceId or spaceKey is required to create a page", "")
	}
	payload := map[string]any{
		"spaceId": spaceID,
		"status":  "current",
		"title":   title,
		"body": map[string]any{
			"representation": "storage",
			"value":          textToStorage(body),
		},
	}
	if parentID != nil { // Bun sends a given "" as is.
		payload["parentId"] = *parentID
	}
	var response apiPage
	if err := a.request(http.MethodPost, a.v2(), "/pages", payload, &response); err != nil {
		return pageCreated{}, err
	}
	created := pageCreated{ID: response.ID, Title: response.Title, SpaceID: response.SpaceID}
	if response.Links.WebUI != "" {
		created.WebURL = a.webURL(response.Links.WebUI)
	}
	return created, nil
}

func (a api) updatePage(pageID string, title *string, body string) (pageUpdated, error) {
	current, err := a.getPage(pageID, "storage")
	if err != nil {
		return pageUpdated{}, err
	}
	if title == nil { // Bun `params.title ?? current.title`: "" is kept.
		title = &current.Title
	}
	payload := map[string]any{
		"id":     pageID,
		"status": current.Status,
		"title":  *title,
		"body": map[string]any{
			"representation": "storage",
			"value":          textToStorage(body),
		},
		"version": map[string]any{"number": current.Version + 1},
	}
	var response apiPage
	if err := a.request(http.MethodPut, a.v2(), "/pages/"+pageID, payload, &response); err != nil {
		return pageUpdated{}, err
	}
	return pageUpdated{ID: response.ID, Title: response.Title, Version: int(response.Version.Number)}, nil
}

type apiComment struct {
	ID        string `json:"id"`
	AuthorID  string `json:"authorId"`
	CreatedAt string `json:"createdAt"`
	Version   struct {
		Number float64 `json:"number"`
	} `json:"version"`
	Body *struct {
		Storage *struct {
			Value string `json:"value"`
		} `json:"storage"`
	} `json:"body"`
}

func (a api) listComments(pageID string) ([]comment, error) {
	var payload struct {
		Results []apiComment `json:"results"`
	}
	path := "/pages/" + pageID + "/footer-comments?body-format=storage"
	if err := a.request(http.MethodGet, a.v2(), path, nil, &payload); err != nil {
		return nil, err
	}
	out := make([]comment, 0, len(payload.Results))
	for _, c := range payload.Results {
		body := ""
		if c.Body != nil && c.Body.Storage != nil && c.Body.Storage.Value != "" {
			body = stripHTML(c.Body.Storage.Value)
		}
		out = append(out, comment{
			ID: c.ID, PageID: pageID, AuthorID: c.AuthorID, Body: body, CreatedAt: c.CreatedAt, Version: int(c.Version.Number),
		})
	}
	return out, nil
}

func (a api) addComment(pageID, body string) (commentCreated, error) {
	payload := map[string]any{
		"pageId": pageID,
		"body": map[string]any{
			"representation": "storage",
			"value":          textToStorage(body),
		},
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := a.request(http.MethodPost, a.v2(), "/footer-comments", payload, &response); err != nil {
		return commentCreated{}, err
	}
	return commentCreated{ID: response.ID, PageID: pageID}, nil
}

func (a api) search(cql, spaceKey, typ, text, limit string) ([]searchResult, error) {
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
	var payload struct {
		Results []searchHit `json:"results"`
	}
	path := query("/search", "cql", queryCQL, "limit", limit)
	if err := a.request(http.MethodGet, a.v1(), path, nil, &payload); err != nil {
		return nil, err
	}
	out := make([]searchResult, 0, len(payload.Results))
	for _, hit := range payload.Results {
		out = append(out, a.searchModel(hit))
	}
	return out, nil
}

type searchHit struct {
	Content *struct {
		ID    string  `json:"id"`
		Type  *string `json:"type"`
		Title *string `json:"title"`
		Space *struct {
			Key string `json:"key"`
		} `json:"space"`
	} `json:"content"`
	Title        *string `json:"title"`
	Excerpt      *string `json:"excerpt"`
	URL          *string `json:"url"`
	LastModified *string `json:"lastModified"`
}

func (a api) searchModel(hit searchHit) searchResult {
	id := ""
	typ := "unknown"
	title := "(untitled)"
	spaceKey := ""
	if hit.Content != nil {
		id = hit.Content.ID
		if hit.Content.Type != nil {
			typ = *hit.Content.Type
		}
		if hit.Content.Space != nil {
			spaceKey = hit.Content.Space.Key
		}
	}
	switch {
	case hit.Content != nil && hit.Content.Title != nil:
		title = *hit.Content.Title
	case hit.Title != nil:
		title = *hit.Title
	}
	out := searchResult{ID: id, Type: typ, Title: title, SpaceKey: spaceKey}
	if hit.URL != nil && *hit.URL != "" {
		out.URL = a.webURL(*hit.URL)
	}
	if hit.Excerpt != nil && *hit.Excerpt != "" {
		out.Excerpt = stripHTML(*hit.Excerpt)
	}
	if hit.LastModified != nil && *hit.LastModified != "" {
		out.LastModified = *hit.LastModified
	}
	return out
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
	return strings.TrimSpace(html)
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
