package discourse

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
)

type category struct {
	ID               int    `json:"id"`
	Name             string `json:"name"`
	Slug             string `json:"slug"`
	Description      string `json:"description"`
	TopicCount       int    `json:"topicCount"`
	PostCount        int    `json:"postCount"`
	Color            string `json:"color"`
	ParentCategoryID *int   `json:"parentCategoryId,omitempty"`
}

type poster struct {
	UserID int `json:"userId"`
}

type topic struct {
	ID           int       `json:"id"`
	Title        string    `json:"title"`
	Slug         string    `json:"slug"`
	PostsCount   int       `json:"postsCount"`
	ReplyCount   int       `json:"replyCount"`
	Views        int       `json:"views"`
	LikeCount    int       `json:"likeCount"`
	CategoryID   int       `json:"categoryId"`
	CategoryName *string   `json:"categoryName,omitempty"`
	CreatedAt    string    `json:"createdAt"`
	LastPostedAt string    `json:"lastPostedAt"`
	Pinned       bool      `json:"pinned"`
	Closed       bool      `json:"closed"`
	Archived     bool      `json:"archived"`
	Posters      *[]poster `json:"posters,omitempty"`
}

type post struct {
	ID          int     `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"displayName,omitempty"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	PostNumber  int     `json:"postNumber"`
	Raw         *string `json:"raw,omitempty"`
	Cooked      string  `json:"cooked"`
	ReplyCount  int     `json:"replyCount"`
	LikeCount   int     `json:"likeCount"`
}

// topicDetail is DiscourseTopicDetail. Bun never sets posters on it.
type topicDetail struct {
	ID           int     `json:"id"`
	Title        string  `json:"title"`
	Slug         string  `json:"slug"`
	PostsCount   int     `json:"postsCount"`
	ReplyCount   int     `json:"replyCount"`
	Views        int     `json:"views"`
	LikeCount    int     `json:"likeCount"`
	CategoryID   int     `json:"categoryId"`
	CategoryName *string `json:"categoryName,omitempty"`
	CreatedAt    string  `json:"createdAt"`
	LastPostedAt string  `json:"lastPostedAt"`
	Pinned       bool    `json:"pinned"`
	Closed       bool    `json:"closed"`
	Archived     bool    `json:"archived"`
	Posts        []post  `json:"posts"`
}

type rawCategory struct {
	ID               int     `json:"id"`
	Name             string  `json:"name"`
	Slug             string  `json:"slug"`
	Description      *string `json:"description"`
	TopicCount       int     `json:"topic_count"`
	PostCount        int     `json:"post_count"`
	Color            string  `json:"color"`
	ParentCategoryID *int    `json:"parent_category_id"`
}

type rawTopic struct {
	ID           int    `json:"id"`
	Title        string `json:"title"`
	Slug         string `json:"slug"`
	PostsCount   int    `json:"posts_count"`
	ReplyCount   int    `json:"reply_count"`
	Views        int    `json:"views"`
	LikeCount    int    `json:"like_count"`
	CategoryID   int    `json:"category_id"`
	CreatedAt    string `json:"created_at"`
	LastPostedAt string `json:"last_posted_at"`
	Pinned       bool   `json:"pinned"`
	Closed       bool   `json:"closed"`
	Archived     bool   `json:"archived"`
	Posters      *[]struct {
		UserID int `json:"user_id"`
	} `json:"posters"`
}

type rawPost struct {
	ID              int     `json:"id"`
	Username        string  `json:"username"`
	DisplayUsername *string `json:"display_username"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
	PostNumber      int     `json:"post_number"`
	Raw             *string `json:"raw"`
	Cooked          string  `json:"cooked"`
	ReplyCount      int     `json:"reply_count"`
	LikeCount       int     `json:"like_count"`
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
	// categories is Bun's categoryCache: filled by getCategories, read by topics.
	categories map[int]string
}

func newAPI(ctx context.Context, creds map[string]any, fetch fetchFunc) *api {
	return &api{
		baseURL:    strings.TrimSuffix(str(creds, "baseUrl"), "/"),
		apiKey:     str(creds, "apiKey"),
		username:   str(creds, "username"),
		ctx:        ctx,
		fetch:      fetch,
		categories: map[int]string{},
	}
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func networkError(err error) *apiError {
	return &apiError{code: "NETWORK_ERROR", message: "Failed to connect to Discourse: " + err.Error()}
}

func (a *api) get(path string, out any) error {
	req, err := http.NewRequestWithContext(a.ctx, http.MethodGet, a.baseURL+path, nil)
	if err != nil {
		return networkError(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Api-Key", a.apiKey)
	req.Header.Set("Api-Username", a.username)
	resp, err := a.fetch(a.ctx, req)
	if err != nil {
		return networkError(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return networkError(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &apiError{code: plugins.HTTPStatusToErrorCode(resp.StatusCode), message: errorMessage(resp.StatusCode, string(raw))}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return networkError(err)
	}
	return nil
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

func (a *api) getCategories() ([]category, error) {
	var payload struct {
		CategoryList struct {
			Categories []rawCategory `json:"categories"`
		} `json:"category_list"`
	}
	if err := a.get("/categories.json", &payload); err != nil {
		return nil, err
	}
	out := make([]category, 0, len(payload.CategoryList.Categories))
	for _, c := range payload.CategoryList.Categories {
		desc := ""
		if c.Description != nil {
			desc = *c.Description
		}
		out = append(out, category{
			ID: c.ID, Name: c.Name, Slug: c.Slug, Description: desc,
			TopicCount: c.TopicCount, PostCount: c.PostCount, Color: c.Color,
			ParentCategoryID: c.ParentCategoryID,
		})
		a.categories[c.ID] = c.Name
	}
	return out, nil
}

func (a *api) categoryName(id int) *string {
	if name, ok := a.categories[id]; ok {
		return &name
	}
	return nil
}

func (a *api) listTopics(categoryFilter string, page int) ([]topic, error) {
	path := "/latest.json"
	if categoryFilter != "" {
		cats, err := a.getCategories()
		if err != nil {
			return nil, err
		}
		var found *category
		for i := range cats {
			if cats[i].Slug == categoryFilter || strings.ToLower(cats[i].Name) == strings.ToLower(categoryFilter) {
				found = &cats[i]
				break
			}
		}
		if found == nil {
			return nil, &apiError{code: "NOT_FOUND", message: fmt.Sprintf("Category %q not found", categoryFilter)}
		}
		path = fmt.Sprintf("/c/%s/%d/l/latest.json", found.Slug, found.ID)
	}
	if page > 0 {
		path += "?page=" + strconv.Itoa(page)
	}
	var payload struct {
		TopicList struct {
			Topics []rawTopic `json:"topics"`
		} `json:"topic_list"`
	}
	if err := a.get(path, &payload); err != nil {
		return nil, err
	}
	if len(a.categories) == 0 {
		if _, err := a.getCategories(); err != nil {
			return nil, err
		}
	}
	out := make([]topic, 0, len(payload.TopicList.Topics))
	for _, t := range payload.TopicList.Topics {
		var posters *[]poster
		if t.Posters != nil {
			list := make([]poster, 0, len(*t.Posters))
			for _, p := range *t.Posters {
				list = append(list, poster{UserID: p.UserID})
			}
			posters = &list
		}
		out = append(out, topic{
			ID: t.ID, Title: t.Title, Slug: t.Slug, PostsCount: t.PostsCount,
			ReplyCount: t.ReplyCount, Views: t.Views, LikeCount: t.LikeCount,
			CategoryID: t.CategoryID, CategoryName: a.categoryName(t.CategoryID),
			CreatedAt: t.CreatedAt, LastPostedAt: t.LastPostedAt,
			Pinned: t.Pinned, Closed: t.Closed, Archived: t.Archived, Posters: posters,
		})
	}
	return out, nil
}

func (a *api) getTopic(id int) (topicDetail, error) {
	var data struct {
		rawTopic
		PostStream struct {
			Posts []rawPost `json:"posts"`
		} `json:"post_stream"`
	}
	if err := a.get(fmt.Sprintf("/t/%d.json", id), &data); err != nil {
		return topicDetail{}, err
	}
	if len(a.categories) == 0 {
		if _, err := a.getCategories(); err != nil {
			return topicDetail{}, err
		}
	}
	posts := make([]post, 0, len(data.PostStream.Posts))
	for _, p := range data.PostStream.Posts {
		posts = append(posts, post{
			ID: p.ID, Username: p.Username, DisplayName: p.DisplayUsername,
			CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt, PostNumber: p.PostNumber,
			Raw: p.Raw, Cooked: p.Cooked, ReplyCount: p.ReplyCount, LikeCount: p.LikeCount,
		})
	}
	return topicDetail{
		ID: data.ID, Title: data.Title, Slug: data.Slug, PostsCount: data.PostsCount,
		ReplyCount: data.ReplyCount, Views: data.Views, LikeCount: data.LikeCount,
		CategoryID: data.CategoryID, CategoryName: a.categoryName(data.CategoryID),
		CreatedAt: data.CreatedAt, LastPostedAt: data.LastPostedAt,
		Pinned: data.Pinned, Closed: data.Closed, Archived: data.Archived, Posts: posts,
	}, nil
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
