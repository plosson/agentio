package gmail

import (
	"context"
	"fmt"
	"os"

	"github.com/plosson/agentio/go/internal/oauth"
	"github.com/plosson/agentio/go/internal/profile"
)

const ServiceKey = "gmail"

// Setup runs Gmail OAuth and returns credentials for the shared profile layer.
// It does not write the vault — callers must profile.PersistSetup.
func Setup(ctx context.Context) (profile.SetupResult, error) {
	fmt.Fprintln(os.Stderr, "Starting OAuth flow for Gmail...")
	bundle, err := oauth.PerformGmailOAuth(ctx)
	if err != nil {
		return profile.SetupResult{}, err
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
	return profile.SetupResult{
		Credentials:          bundle.ToMap(),
		SuggestedProfileName: suggested,
		Info:                 info,
	}, nil
}

// ClientFromCredentials builds a Gmail API client from vault credential map.
func ClientFromCredentials(ctx context.Context, creds map[string]any) (*Client, error) {
	return NewClient(ctx, oauth.BundleFromMap(creds))
}
