package gmail

import (
	"context"
	"fmt"
	"os"

	"github.com/plosson/agentio/go/internal/oauth"
	"github.com/plosson/agentio/go/internal/service"
)

// ServiceID is Bun ServicePlugin.id for Gmail.
const ServiceID = "gmail"

// Plugin is the Gmail ServicePlugin (Bun src/plugins/google/gmail).
// It owns OAuth + API client construction. Profile CRUD is host-owned.
type Plugin struct{}

// New returns the Gmail ServicePlugin.
func New() *Plugin { return &Plugin{} }

func (Plugin) ID() string          { return ServiceID }
func (Plugin) DisplayName() string { return "Gmail" }
func (Plugin) Description() string {
	return "Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export."
}

// Setup mirrors Bun ProfilePlugin.setup / gmailProfileAdd.
// Returns credentials only — host persists via profile.AddProfileFromPlugin.
func (Plugin) Setup(ctx context.Context, opts service.SetupOptions) (*service.SetupResult, error) {
	_ = opts // host chooses final name; readOnly applied at PersistSetupResult
	fmt.Fprintln(os.Stderr, "Starting OAuth flow for Gmail...")
	bundle, err := oauth.PerformGmailOAuth(ctx)
	if err != nil {
		return nil, err
	}
	email := bundle.Email
	suggested := email
	if suggested == "" {
		suggested = "default"
	}
	info := ""
	if email != "" {
		info = fmt.Sprintf("Email: %s", email)
	}
	return &service.SetupResult{
		Credentials:          bundle.ToMap(),
		SuggestedProfileName: suggested,
		Info:                 info,
	}, nil
}

// ClientFromCredentials builds a Gmail API client from vault credential map
// (Bun profile.createClient).
func ClientFromCredentials(ctx context.Context, creds map[string]any) (*Client, error) {
	return NewClient(ctx, oauth.BundleFromMap(creds))
}

// ServiceKey is retained as an alias of ServiceID for older call sites.
const ServiceKey = ServiceID
