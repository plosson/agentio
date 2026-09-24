package jira

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/plosson/agentio/go/internal/plugin"
)

// ServiceID is Bun ServicePlugin.id for Jira.
const ServiceID = "jira"

// Plugin is the Jira ServicePlugin (Bun src/plugins/jira).
// Owns Atlassian 3LO + API client. Profile CRUD is host-owned.
type Plugin struct{}

// New returns the Jira ServicePlugin.
func New() *Plugin { return &Plugin{} }

func (Plugin) ID() string          { return ServiceID }
func (Plugin) DisplayName() string { return "JIRA" }
func (Plugin) Description() string {
	return "Use when interacting with JIRA via the agentio CLI - search issues, comment, transition."
}

// Setup mirrors Bun ProfilePlugin.setup / jiraProfileAdd.
// Returns credentials only — host persists via profile.AddProfileFromPlugin.
func (Plugin) Setup(ctx context.Context, opts plugin.SetupOptions) (*plugin.SetupResult, error) {
	_ = opts
	fmt.Fprintln(os.Stderr, "\nJIRA OAuth Setup")
	creds, err := PerformOAuth(ctx)
	if err != nil {
		return nil, err
	}
	suggested := "default"
	if u, err := url.Parse(creds.SiteURL); err == nil && u.Hostname() != "" {
		suggested = u.Hostname()
	}
	fmt.Fprintf(os.Stderr, "\nAuthorized for site: %s\n", creds.SiteURL)
	return &plugin.SetupResult{
		Credentials:          creds.ToMap(),
		SuggestedProfileName: suggested,
		Info:                 "Test with: agentio jira projects",
	}, nil
}

// ClientFromCredentials builds a Jira API client from vault credential map.
func ClientFromCredentials(creds map[string]any) *Client {
	return NewClient(CredentialsFromMap(creds))
}
