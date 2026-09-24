package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Client mirrors Bun JiraClient — calls Atlassian Jira Cloud REST via cloudId.
type Client struct {
	creds   Credentials
	baseURL string
	http    *http.Client
}

func NewClient(creds Credentials) *Client {
	return &Client{
		creds:   creds,
		baseURL: fmt.Sprintf("https://api.atlassian.com/ex/jira/%s/rest/api/3", creds.CloudID),
		http:    http.DefaultClient,
	}
}

// Myself is Bun validate()/myself — GET /myself.
type Myself struct {
	AccountID   string `json:"accountId"`
	DisplayName string `json:"displayName"`
	Email       string `json:"emailAddress"`
}

func (c *Client) Myself(ctx context.Context) (*Myself, error) {
	var me Myself
	if err := c.get(ctx, "/myself", &me); err != nil {
		return nil, err
	}
	return &me, nil
}

// Project mirrors Bun JiraProject (subset for list).
type Project struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	Name string `json:"name"`
}

// ListProjects mirrors Bun listProjects — GET /project/search.
func (c *Client) ListProjects(ctx context.Context, maxResults int) ([]Project, error) {
	if maxResults <= 0 {
		maxResults = 50
	}
	path := fmt.Sprintf("/project/search?maxResults=%d", maxResults)
	var resp struct {
		Values []Project `json:"values"`
	}
	if err := c.get(ctx, path, &resp); err != nil {
		return nil, err
	}
	return resp.Values, nil
}

func FormatProjects(projects []Project) string {
	if len(projects) == 0 {
		return "No projects found\n"
	}
	s := fmt.Sprintf("Projects (%d)\n\n", len(projects))
	for _, p := range projects {
		s += fmt.Sprintf("  %s\t%s\t%s\n", p.Key, p.ID, p.Name)
	}
	return s
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	u, err := url.JoinPath(c.baseURL, path)
	if err != nil {
		// path may contain query; JoinPath breaks it — fall back to concat
		u = c.baseURL + path
	}
	if idx := len(path); idx > 0 && path[0] == '/' {
		u = c.baseURL + path
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.creds.AccessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("jira API %s: %s", resp.Status, string(raw))
	}
	return json.Unmarshal(raw, out)
}
