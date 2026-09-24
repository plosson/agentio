package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
)

type project struct {
	ID             string `json:"id"`
	Key            string `json:"key"`
	Name           string `json:"name"`
	ProjectTypeKey string `json:"projectTypeKey"`
	Simplified     bool   `json:"simplified"`
	Style          string `json:"style"`
	IsPrivate      bool   `json:"isPrivate"`
	// AvatarURLs is passed through as sent: key order kept, absent omitted.
	AvatarURLs json.RawMessage `json:"avatarUrls,omitempty"`
}

type issue struct {
	ID                string  `json:"id"`
	Key               string  `json:"key"`
	Summary           string  `json:"summary"`
	Status            string  `json:"status"`
	StatusCategoryKey string  `json:"statusCategoryKey"`
	Priority          *string `json:"priority,omitempty"`
	Assignee          *string `json:"assignee,omitempty"`
	Reporter          *string `json:"reporter,omitempty"`
	Created           string  `json:"created"`
	Updated           string  `json:"updated"`
	ProjectKey        string  `json:"projectKey"`
	IssueType         string  `json:"issueType"`
	Description       string  `json:"description"`
}

type transition struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	To   struct {
		ID             string `json:"id"`
		Name           string `json:"name"`
		StatusCategory struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		} `json:"statusCategory"`
	} `json:"to"`
}

// transitionList is the transitions of one issue. It prints as the array;
// Format also needs the issue key.
type transitionList struct {
	issueKey string
	items    []transition
}

func (l transitionList) MarshalJSON() ([]byte, error) {
	if l.items == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(l.items)
}

type commentResult struct {
	ID       string `json:"id"`
	IssueKey string `json:"issueKey"`
}

type transitionResult struct {
	IssueKey       string `json:"issueKey"`
	TransitionName string `json:"transitionName"`
	NewStatus      string `json:"newStatus"`
}

type api struct {
	atlassian.Client
	cloudID string
	siteURL string
}

func apiFrom(ctx context.Context, run *plugins.RunContext) api {
	return api{
		Client:  atlassian.NewClient(ctx, run, "JIRA API error"),
		cloudID: atlassian.Str(run.Credentials, "cloudId"),
		siteURL: atlassian.Str(run.Credentials, "siteUrl"),
	}
}

func (a api) base() string {
	return "https://api.atlassian.com/ex/jira/" + a.cloudID + "/rest/api/3"
}

func (a api) request(method, path string, body any, out any) error {
	return a.Request(method, a.base()+path, body, out)
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

func (a api) listProjects(maxResults string) ([]project, error) {
	path := "/project/search"
	if n, ok := limit(maxResults); ok {
		q := jsvalue.NewSearchParams()
		q.Set("maxResults", n)
		path += "?" + q.String()
	}
	var payload struct {
		Values []project `json:"values"`
	}
	if err := a.request(http.MethodGet, path, nil, &payload); err != nil {
		return nil, err
	}
	if payload.Values == nil {
		return []project{}, nil
	}
	return payload.Values, nil
}

type apiIssue struct {
	ID     string `json:"id"`
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  struct {
			Name           string `json:"name"`
			StatusCategory struct {
				Key string `json:"key"`
			} `json:"statusCategory"`
		} `json:"status"`
		Priority *named  `json:"priority"`
		Assignee *person `json:"assignee"`
		Reporter *person `json:"reporter"`
		Created  string  `json:"created"`
		Updated  string  `json:"updated"`
		Project  struct {
			Key string `json:"key"`
		} `json:"project"`
		IssueType struct {
			Name string `json:"name"`
		} `json:"issuetype"`
		Description any `json:"description"`
	} `json:"fields"`
}

type named struct {
	Name *string `json:"name"`
}

type person struct {
	DisplayName *string `json:"displayName"`
}

func (i apiIssue) model() issue {
	out := issue{
		ID: i.ID, Key: i.Key, Summary: i.Fields.Summary,
		Status: i.Fields.Status.Name, StatusCategoryKey: i.Fields.Status.StatusCategory.Key,
		Created: i.Fields.Created, Updated: i.Fields.Updated,
		ProjectKey: i.Fields.Project.Key, IssueType: i.Fields.IssueType.Name,
		Description: atlassian.ExtractTextFromADF(i.Fields.Description),
	}
	if i.Fields.Priority != nil {
		out.Priority = i.Fields.Priority.Name
	}
	if i.Fields.Assignee != nil {
		out.Assignee = i.Fields.Assignee.DisplayName
	}
	if i.Fields.Reporter != nil {
		out.Reporter = i.Fields.Reporter.DisplayName
	}
	return out
}

func (a api) searchIssues(jql, projectKey, status, assignee, maxResults string) ([]issue, error) {
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
	var payload struct {
		Issues []apiIssue `json:"issues"`
	}
	if err := a.request(http.MethodGet, "/search/jql?"+q.String(), nil, &payload); err != nil {
		return nil, err
	}
	out := make([]issue, 0, len(payload.Issues))
	for _, i := range payload.Issues {
		out = append(out, i.model())
	}
	return out, nil
}

func (a api) getIssue(key string) (issue, error) {
	var response apiIssue
	if err := a.request(http.MethodGet, "/issue/"+key, nil, &response); err != nil {
		return issue{}, err
	}
	return response.model(), nil
}

func (a api) getTransitions(key string) (transitionList, error) {
	var payload struct {
		Transitions []transition `json:"transitions"`
	}
	if err := a.request(http.MethodGet, "/issue/"+key+"/transitions", nil, &payload); err != nil {
		return transitionList{}, err
	}
	return transitionList{issueKey: key, items: payload.Transitions}, nil
}

func (a api) transitionIssue(key, transitionID string) (transitionResult, error) {
	list, err := a.getTransitions(key)
	if err != nil {
		return transitionResult{}, err
	}
	var found *transition
	for i := range list.items {
		if list.items[i].ID == transitionID {
			found = &list.items[i]
			break
		}
	}
	if found == nil {
		return transitionResult{}, a.Fail("NOT_FOUND", `Transition "`+transitionID+`" not found or not available for this issue`, "")
	}
	body := map[string]any{"transition": map[string]any{"id": transitionID}}
	if err := a.request(http.MethodPost, "/issue/"+key+"/transitions", body, nil); err != nil {
		return transitionResult{}, err
	}
	return transitionResult{IssueKey: key, TransitionName: found.Name, NewStatus: found.To.Name}, nil
}

func (a api) addComment(key, body string) (commentResult, error) {
	var response struct {
		ID string `json:"id"`
	}
	if err := a.request(http.MethodPost, "/issue/"+key+"/comment", map[string]any{"body": textToADF(body)}, &response); err != nil {
		return commentResult{}, err
	}
	return commentResult{ID: response.ID, IssueKey: key}, nil
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
