package discourse

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// The models are the Bun client's objects (DiscourseCategory, DiscourseTopic,
// DiscourseTopicDetail, DiscoursePost), built from the answer as JavaScript
// reads it: a missing field is undefined (left out of --json, "undefined" in
// text), and reading a field of null or undefined fails with Bun's TypeError.

// parseCategory is Bun parseCategory.
func parseCategory(raw any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(raw) {
		return nil, jsvalue.TypeError(raw, "raw.id")
	}
	get := func(k string) any { return jsvalue.Member(raw, k) }
	description := get("description")
	if !jsvalue.Truthy(description) {
		description = ""
	}
	c := jsvalue.NewObject()
	c.Set("id", get("id"))
	c.Set("name", get("name"))
	c.Set("slug", get("slug"))
	c.Set("description", description)
	c.Set("topicCount", get("topic_count"))
	c.Set("postCount", get("post_count"))
	c.Set("color", get("color"))
	c.Set("parentCategoryId", get("parent_category_id"))
	return c, nil
}

// parseTopic is Bun parseTopic.
func (a *api) parseTopic(raw any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(raw) {
		return nil, jsvalue.TypeError(raw, "raw.id")
	}
	t := a.topicFields(raw)
	posters := jsvalue.Member(raw, "posters")
	if jsvalue.Nullish(posters) { // raw.posters?.map(...)
		posters = jsvalue.Undefined
	} else {
		items, err := jsvalue.Items(posters, "raw.posters?")
		if err != nil {
			return nil, err
		}
		list := make([]any, 0, len(items))
		for _, p := range items {
			if jsvalue.Nullish(p) {
				return nil, jsvalue.TypeError(p, "p.user_id")
			}
			poster := jsvalue.NewObject()
			poster.Set("userId", jsvalue.Member(p, "user_id"))
			list = append(list, poster)
		}
		posters = list
	}
	t.Set("posters", posters)
	return t, nil
}

// topicFields are the fields DiscourseTopic and DiscourseTopicDetail share,
// read from a non-nullish raw topic in Bun's order.
func (a *api) topicFields(raw any) *jsvalue.Object {
	get := func(k string) any { return jsvalue.Member(raw, k) }
	t := jsvalue.NewObject()
	t.Set("id", get("id"))
	t.Set("title", get("title"))
	t.Set("slug", get("slug"))
	t.Set("postsCount", get("posts_count"))
	t.Set("replyCount", get("reply_count"))
	t.Set("views", get("views"))
	t.Set("likeCount", get("like_count"))
	t.Set("categoryId", get("category_id"))
	t.Set("categoryName", a.categoryName(get("category_id")))
	t.Set("createdAt", get("created_at"))
	t.Set("lastPostedAt", get("last_posted_at"))
	t.Set("pinned", get("pinned"))
	t.Set("closed", get("closed"))
	t.Set("archived", get("archived"))
	return t
}

// parsePost is Bun parsePost.
func parsePost(raw any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(raw) {
		return nil, jsvalue.TypeError(raw, "raw.id")
	}
	get := func(k string) any { return jsvalue.Member(raw, k) }
	p := jsvalue.NewObject()
	p.Set("id", get("id"))
	p.Set("username", get("username"))
	p.Set("displayName", get("display_username"))
	p.Set("createdAt", get("created_at"))
	p.Set("updatedAt", get("updated_at"))
	p.Set("postNumber", get("post_number"))
	p.Set("raw", get("raw"))
	p.Set("cooked", get("cooked"))
	p.Set("replyCount", get("reply_count"))
	p.Set("likeCount", get("like_count"))
	return p, nil
}

// apiError is a Bun CliError thrown by DiscourseClient.request. Commands turn
// it into a host error; Validate reads only its message, as Bun does.
type apiError struct {
	code    plugins.ErrorCode
	message string
}

func (e *apiError) Error() string { return e.message }

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

type api struct {
	baseURL  string
	apiKey   string
	username string
	ctx      context.Context
	fetch    fetchFunc
	// categories is Bun's categoryCache (a Map from category id to name):
	// filled by getCategories, read by topics.
	categories map[string]any
}

func newAPI(ctx context.Context, creds map[string]any, fetch fetchFunc) *api {
	return &api{
		baseURL:    strings.TrimSuffix(str(creds, "baseUrl"), "/"),
		apiKey:     str(creds, "apiKey"),
		username:   str(creds, "username"),
		ctx:        ctx,
		fetch:      fetch,
		categories: map[string]any{},
	}
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func networkError(err error) *apiError {
	return &apiError{code: "NETWORK_ERROR", message: "Failed to connect to Discourse: " + err.Error()}
}

// get is Bun request('GET', path): the answer as `await response.json()`
// reads it, and any failure but an API error as NETWORK_ERROR.
func (a *api) get(path string) (any, error) {
	req, err := http.NewRequestWithContext(a.ctx, http.MethodGet, a.baseURL+path, nil)
	if err != nil {
		return nil, networkError(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Api-Key", a.apiKey)
	req.Header.Set("Api-Username", a.username)
	resp, err := a.fetch(a.ctx, req)
	if err != nil {
		return nil, networkError(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, networkError(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &apiError{code: plugins.HTTPStatusToErrorCode(resp.StatusCode), message: errorMessage(resp.StatusCode, string(raw))}
	}
	data, err := plugins.ResponseJSON(resp.StatusCode, raw)
	if err != nil {
		return nil, networkError(err)
	}
	return data, nil
}

// errorMessage follows the Bun try/catch: a truthy `errors` array is joined,
// anything that throws while reading it falls back to the raw body text.
func errorMessage(status int, text string) string {
	fallback := func(msg string) string {
		if text != "" {
			return text
		}
		return msg
	}
	msg := fmt.Sprintf("Discourse API error: %d", status)
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var data any
	if err := dec.Decode(&data); err != nil || dec.More() {
		return fallback(msg)
	}
	if data == nil {
		return fallback(msg) // null.errors throws
	}
	obj, ok := data.(map[string]any)
	if !ok {
		return msg
	}
	errs, present := obj["errors"]
	if !present || !jsTruthy(errs) {
		return msg
	}
	list, ok := errs.([]any)
	if !ok {
		return fallback(msg) // .join is not a function
	}
	parts := make([]string, len(list))
	for i, e := range list {
		switch v := e.(type) {
		case nil:
			parts[i] = ""
		case string:
			parts[i] = v
		case json.Number:
			parts[i] = v.String()
		case bool:
			parts[i] = strconv.FormatBool(v)
		default:
			parts[i] = "[object Object]"
		}
	}
	return strings.Join(parts, ", ")
}

func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err != nil || f != 0
	default:
		return true
	}
}

func (a *api) getCategories() ([]any, error) {
	const request = `(await this.request("GET", "/categories.json"))`
	data, err := a.get("/categories.json")
	if err != nil {
		return nil, err
	}
	list, err := jsvalue.Path(data, request, "category_list", "categories")
	if err != nil {
		return nil, err
	}
	items, err := jsvalue.Items(list, request+".category_list.categories")
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(items))
	for _, raw := range items {
		c, err := parseCategory(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	for _, c := range out {
		id, _ := c.(*jsvalue.Object).Get("id")
		name, _ := c.(*jsvalue.Object).Get("name")
		a.categories[cacheKey(id)] = name
	}
	return out, nil
}

// cacheKey is the Map key of a category id: SameValueZero, so 1 and "1"
// differ and 1.0 is 1.
func cacheKey(id any) string {
	if id == jsvalue.Undefined {
		return "undefined"
	}
	return string(jsvalue.Stringify(id))
}

// categoryName is categoryCache.get(id): undefined when not cached.
func (a *api) categoryName(id any) any {
	if name, ok := a.categories[cacheKey(id)]; ok {
		return name
	}
	return jsvalue.Undefined
}

// findCategory is Bun's categories.find(c => c.slug === filter ||
// c.name.toLowerCase() === filter?.toLowerCase()).
func findCategory(cats []any, filter string) (*jsvalue.Object, error) {
	for _, c := range cats {
		cat := c.(*jsvalue.Object)
		slug, _ := cat.Get("slug")
		if jsvalue.StrictEqual(slug, filter) {
			return cat, nil
		}
		name, _ := cat.Get("name")
		if jsvalue.Nullish(name) {
			return nil, jsvalue.TypeError(name, "c.name.toLowerCase")
		}
		if strings.ToLower(jsvalue.String(name)) == strings.ToLower(filter) {
			return cat, nil
		}
	}
	return nil, nil
}

func (a *api) listTopics(categoryFilter string, page int) ([]any, error) {
	path := "/latest.json"
	if categoryFilter != "" {
		cats, err := a.getCategories()
		if err != nil {
			return nil, err
		}
		found, err := findCategory(cats, categoryFilter)
		if err != nil {
			return nil, err
		}
		if found == nil {
			return nil, &apiError{code: "NOT_FOUND", message: fmt.Sprintf("Category \"%s\" not found", categoryFilter)}
		}
		slug, _ := found.Get("slug")
		id, _ := found.Get("id")
		path = "/c/" + jsvalue.String(slug) + "/" + jsvalue.String(id) + "/l/latest.json"
	}
	if page > 0 {
		path += "?page=" + strconv.Itoa(page)
	}
	data, err := a.get(path)
	if err != nil {
		return nil, err
	}
	if len(a.categories) == 0 {
		if _, err := a.getCategories(); err != nil {
			return nil, err
		}
	}
	list, err := jsvalue.Path(data, "data", "topic_list", "topics")
	if err != nil {
		return nil, err
	}
	items, err := jsvalue.Items(list, "data.topic_list.topics")
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(items))
	for _, raw := range items {
		t, err := a.parseTopic(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (a *api) getTopic(id int) (*jsvalue.Object, error) {
	data, err := a.get(fmt.Sprintf("/t/%d.json", id))
	if err != nil {
		return nil, err
	}
	if len(a.categories) == 0 {
		if _, err := a.getCategories(); err != nil {
			return nil, err
		}
	}
	if jsvalue.Nullish(data) {
		return nil, jsvalue.TypeError(data, "data.id")
	}
	detail := a.topicFields(data)
	list, err := jsvalue.Path(data, "data", "post_stream", "posts")
	if err != nil {
		return nil, err
	}
	items, err := jsvalue.Items(list, "data.post_stream.posts")
	if err != nil {
		return nil, err
	}
	posts := make([]any, 0, len(items))
	for _, raw := range items {
		p, err := parsePost(raw)
		if err != nil {
			return nil, err
		}
		posts = append(posts, p)
	}
	detail.Set("posts", posts)
	return detail, nil
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	a := newAPI(ctx, run.Credentials, run.Fetch)
	if _, err := a.getCategories(); err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	return plugins.ValidationResult{Valid: true, Info: a.baseURL}, nil
}

// jsParseInt is parseInt(s, 10): leading whitespace, an optional sign, then
// digits up to the first non-digit. No digits is NaN (ok false).
func jsParseInt(s string) (int, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	sign := 1
	if s != "" && (s[0] == '+' || s[0] == '-') {
		if s[0] == '-' {
			sign = -1
		}
		s = s[1:]
	}
	n, digits := 0, 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		n = n*10 + int(s[digits]-'0')
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	return sign * n, true
}
