package jira

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
)

// The models are the Bun client's objects (JiraProject, JiraIssue,
// JiraTransition, ...), built from the answer as JavaScript reads it: a
// missing field is undefined (left out of --json, "undefined" in text), and
// reading a field of null or undefined fails with Bun's TypeError.

// transitionList is the transitions of one issue. It prints as the array;
// Format also needs the issue key.
type transitionList struct {
	issueKey string
	items    []any
}

func (l transitionList) MarshalJSON() ([]byte, error) {
	if l.items == nil {
		return []byte("[]"), nil
	}
	return jsvalue.Stringify(l.items), nil
}

type api struct {
	atlassian.Client
	cloudID string
	siteURL string
}

func apiFrom(ctx context.Context, run *plugins.RunContext) api {
	return api{
		Client:  atlassian.NewClient(ctx, run, "JIRA API error"),
		cloudID: run.Credentials.StrValue("cloudId"),
		siteURL: run.Credentials.StrValue("siteUrl"),
	}
}

func (a api) base() string {
	return "https://api.atlassian.com/ex/jira/" + a.cloudID + "/rest/api/3"
}

func (a api) request(method, path string, body any) (any, error) {
	return a.Request(method, a.base()+path, body)
}

// limit is Bun parseInt(options.limit, 10), or ok false when it is falsy
// (NaN or 0).
func limit(raw string) (string, bool) {
	n := jsvalue.ParseInt(raw)
	if math.IsNaN(n) || n == 0 {
		return "", false
	}
	return jsvalue.NumberString(n), true
}

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

// field reads `text.keys…` from the answer, or fails as JavaScript does.
func field(base any, text string, keys ...string) (any, error) {
	return jsvalue.Path(base, text, keys...)
}

func (a api) listProjects(maxResults string) ([]any, error) {
	path := "/project/search"
	if n, ok := limit(maxResults); ok {
		q := jsvalue.NewSearchParams()
		q.Set("maxResults", n)
		path += "?" + q.String()
	}
	response, err := a.request(http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	const text = `(await this.request("GET", path))`
	values, err := field(response, text, "values")
	if err != nil {
		return nil, err
	}
	return mapItems(values, text+".values", projectModel)
}

// projectModel is the JiraProject Bun maps each project to.
func projectModel(p any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(p) {
		return nil, jsvalue.TypeError(p, "p.id")
	}
	return atlassian.Pick(p, "id", "id", "key", "key", "name", "name", "projectTypeKey", "projectTypeKey",
		"simplified", "simplified", "style", "style", "isPrivate", "isPrivate", "avatarUrls", "avatarUrls"), nil
}

// issueModel is the JiraIssue Bun builds from raw, read as text ("issue" in
// search, "response" in get), in the order the object literal reads it.
func issueModel(raw any, text string) (*jsvalue.Object, error) {
	if jsvalue.Nullish(raw) {
		return nil, jsvalue.TypeError(raw, text+".id")
	}
	o := atlassian.Pick(raw, "id", "id", "key", "key")
	for _, f := range []struct {
		key  string
		path []string
	}{
		{"summary", []string{"fields", "summary"}},
		{"status", []string{"fields", "status", "name"}},
		{"statusCategoryKey", []string{"fields", "status", "statusCategory", "key"}},
	} {
		v, err := field(raw, text, f.path...)
		if err != nil {
			return nil, err
		}
		o.Set(f.key, v)
	}
	fields := jsvalue.Member(raw, "fields")
	o.Set("priority", jsvalue.Optional(jsvalue.Member(fields, "priority"), "name"))
	o.Set("assignee", jsvalue.Optional(jsvalue.Member(fields, "assignee"), "displayName"))
	o.Set("reporter", jsvalue.Optional(jsvalue.Member(fields, "reporter"), "displayName"))
	o.Set("created", jsvalue.Member(fields, "created"))
	o.Set("updated", jsvalue.Member(fields, "updated"))
	for _, f := range []struct {
		key  string
		path []string
	}{
		{"projectKey", []string{"fields", "project", "key"}},
		{"issueType", []string{"fields", "issuetype", "name"}},
	} {
		v, err := field(raw, text, f.path...)
		if err != nil {
			return nil, err
		}
		o.Set(f.key, v)
	}
	o.Set("description", atlassian.ExtractTextFromADF(jsvalue.Member(fields, "description")))
	return o, nil
}

func (a api) searchIssues(jql, projectKey, status, assignee, maxResults string) ([]any, error) {
	var parts []string
	if jql != "" {
		parts = append(parts, jql)
	}
	if projectKey != "" {
		parts = append(parts, `project = "`+projectKey+`"`)
	}
	if status != "" {
		parts = append(parts, `status = "`+status+`"`)
	}
	if assignee != "" {
		parts = append(parts, `assignee = "`+assignee+`"`)
	}
	query := strings.Join(parts, " AND ")
	if query == "" {
		query = "ORDER BY created DESC"
	}
	n, ok := limit(maxResults)
	if !ok {
		n = "50"
	}
	q := jsvalue.NewSearchParams()
	q.Set("jql", query)
	q.Set("maxResults", n)
	q.Set("fields", "summary,status,priority,assignee,reporter,created,updated,project,issuetype,description")
	response, err := a.request(http.MethodGet, "/search/jql?"+q.String(), nil)
	if err != nil {
		return nil, err
	}
	const text = "(await this.request(\"GET\", `/search/jql?${params.toString()}`))"
	issues, err := field(response, text, "issues")
	if err != nil {
		return nil, err
	}
	return mapItems(issues, text+".issues", func(i any) (*jsvalue.Object, error) { return issueModel(i, "issue") })
}

func (a api) getIssue(key string) (*jsvalue.Object, error) {
	response, err := a.request(http.MethodGet, "/issue/"+key, nil)
	if err != nil {
		return nil, err
	}
	return issueModel(response, "response")
}

func (a api) getTransitions(key string) (transitionList, error) {
	response, err := a.request(http.MethodGet, "/issue/"+key+"/transitions", nil)
	if err != nil {
		return transitionList{}, err
	}
	const text = "(await this.request(\"GET\", `/issue/${issueKey}/transitions`))"
	list, err := field(response, text, "transitions")
	if err != nil {
		return transitionList{}, err
	}
	items, err := mapItems(list, text+".transitions", transitionModel)
	if err != nil {
		return transitionList{}, err
	}
	return transitionList{issueKey: key, items: items}, nil
}

// transitionModel is the JiraTransition Bun maps each transition to.
func transitionModel(t any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(t) {
		return nil, jsvalue.TypeError(t, "t.id")
	}
	out := atlassian.Pick(t, "id", "id", "name", "name")
	to := jsvalue.NewObject()
	category := jsvalue.NewObject()
	for _, f := range []struct {
		into *jsvalue.Object
		key  string
		path []string
	}{
		{to, "id", []string{"to", "id"}},
		{to, "name", []string{"to", "name"}},
		{category, "key", []string{"to", "statusCategory", "key"}},
		{category, "name", []string{"to", "statusCategory", "name"}},
	} {
		v, err := field(t, "t", f.path...)
		if err != nil {
			return nil, err
		}
		f.into.Set(f.key, v)
	}
	to.Set("statusCategory", category)
	out.Set("to", to)
	return out, nil
}

func (a api) transitionIssue(key, transitionID string) (*jsvalue.Object, error) {
	list, err := a.getTransitions(key)
	if err != nil {
		return nil, err
	}
	var found any
	for _, t := range list.items {
		if jsvalue.StrictEqual(jsvalue.Member(t, "id"), transitionID) {
			found = t
			break
		}
	}
	if found == nil {
		return nil, a.Fail("NOT_FOUND", `Transition "`+transitionID+`" not found or not available for this issue`, "")
	}
	body := jsvalue.NewObject()
	id := jsvalue.NewObject()
	id.Set("id", transitionID)
	body.Set("transition", id)
	if _, err := a.request(http.MethodPost, "/issue/"+key+"/transitions", body); err != nil {
		return nil, err
	}
	out := jsvalue.NewObject()
	out.Set("issueKey", key)
	out.Set("transitionName", jsvalue.Member(found, "name"))
	out.Set("newStatus", jsvalue.Member(jsvalue.Member(found, "to"), "name"))
	return out, nil
}

func (a api) addComment(key, body string) (*jsvalue.Object, error) {
	payload := jsvalue.NewObject()
	payload.Set("body", textToADF(body))
	response, err := a.request(http.MethodPost, "/issue/"+key+"/comment", payload)
	if err != nil {
		return nil, err
	}
	const text = "(await this.request(\"POST\", `/issue/${issueKey}/comment`, {\n        body: adfBody\n      }))"
	id, err := field(response, text, "id")
	if err != nil {
		return nil, err
	}
	out := jsvalue.NewObject()
	out.Set("id", id)
	out.Set("issueKey", key)
	return out, nil
}

type adfInline struct {
	Type string  `json:"type"`
	Text *string `json:"text,omitempty"`
}

type adfParagraph struct {
	Type    string      `json:"type"`
	Content []adfInline `json:"content"`
}

type adfDoc struct {
	Version int            `json:"version"`
	Type    string         `json:"type"`
	Content []adfParagraph `json:"content"`
}

// textToADF is JiraClient.textToAdf: a paragraph per "\n\n" block, a hard
// break between its lines.
func textToADF(text string) adfDoc {
	doc := adfDoc{Version: 1, Type: "doc", Content: []adfParagraph{}}
	for _, paragraph := range strings.Split(text, "\n\n") {
		lines := strings.Split(paragraph, "\n")
		content := []adfInline{}
		for i, line := range lines {
			content = append(content, adfInline{Type: "text", Text: &line})
			if i < len(lines)-1 {
				content = append(content, adfInline{Type: "hardBreak"})
			}
		}
		doc.Content = append(doc.Content, adfParagraph{Type: "paragraph", Content: content})
	}
	return doc
}

// validate is JiraClient.validate: /myself names the user; a token without
// read:me falls back to a one-project search.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	a := apiFrom(ctx, run)
	fail := func(err error) (plugins.ValidationResult, error) {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	status, body, err := a.get(a.base() + "/myself")
	if err != nil {
		return fail(err)
	}
	if status >= 200 && status < 300 {
		user, err := jsvalue.Parse(body)
		if err != nil {
			return plugins.ValidationResult{Valid: false, Error: jsvalue.ParseErrorMessage(body)}, nil
		}
		info := a.siteURL
		if obj, ok := user.(*jsvalue.Object); ok {
			for _, key := range []string{"emailAddress", "displayName"} {
				if v, _ := obj.Get(key); jsvalue.Truthy(v) {
					info = jsvalue.String(v)
				}
			}
		}
		return plugins.ValidationResult{Valid: true, Info: info}, nil
	}
	status, _, err = a.get(a.base() + "/project/search?maxResults=1")
	if err != nil {
		return fail(err)
	}
	if status >= 200 && status < 300 {
		return plugins.ValidationResult{Valid: true, Info: a.siteURL}, nil
	}
	return plugins.ValidationResult{Valid: false, Error: fmt.Sprintf("API returned %d", status)}, nil
}

func (a api) get(target string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(a.Ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.Access)
	req.Header.Set("Accept", "application/json")
	resp, err := a.Fetch(a.Ctx, req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, body, nil
}
