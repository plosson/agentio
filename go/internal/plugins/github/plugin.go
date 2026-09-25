// Package github is the GitHub service. Its only commands are profile
// management: `github install|uninstall` read the vault, so the host owns them
// (go/internal/cli), as Bun's src/commands/github-vault-secrets.ts does.
package github

import (
	"context"
	"fmt"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:         plugins.APIVersion,
		ID:                 "github",
		DisplayName:        "GitHub",
		Description:        "Use when interacting with GitHub via the agentio CLI.",
		CommandDescription: "GitHub operations",
		Profile: &plugins.ProfileSpec{
			ProfileDescription: "Profile name (auto-detected from username if not provided)",
			Setup:              setup,
			Validate:           validate,
			Reauthenticate:     reauth,
			ListInfo:           listInfo,
		},
		Commands: []plugins.CommandSpec{},
	}
}

// listInfo is Bun getExtraInfo: ` (username)` when the username is truthy.
func listInfo(creds plugins.Credentials) string {
	if v := creds.Value("username"); jsvalue.Truthy(v) {
		return " (" + jsvalue.String(v) + ")"
	}
	return ""
}

// withUser is Bun's `{ ...creds, accessToken, username: ”, email: null }`
// completed from /user: username and email set in those places. An absent
// email is undefined, which JSON.stringify drops.
func withUser(creds plugins.Credentials, token string, u user) plugins.Credentials {
	out := jsvalue.Spread(creds)
	out.Set("accessToken", token)
	out.Set("username", u.login)
	if u.hasEmail {
		out.Set("email", u.email)
	} else {
		out.Set("email", jsvalue.Undefined)
	}
	return out
}

func setup(ctx context.Context, _ plugins.SetupOptions, sc *plugins.SetupContext) (*plugins.SetupResult, error) {
	sc.Log("\nGitHub Setup\n")
	sc.Log("This will open your browser to authorize agentio with GitHub.")
	sc.Log("You will need to grant access to repositories where you want to set secrets.\n")
	token, err := performOAuth(ctx, sc)
	if err != nil {
		return nil, err
	}
	u, err := newClient(ctx, token, sc.Fetch, sc.Fail).getUser()
	if err != nil {
		return nil, err
	}
	creds := withUser(nil, token, u)
	email := ""
	if jsvalue.Truthy(u.email) {
		email = fmt.Sprintf(" (%s)", jsvalue.String(u.email))
	}
	sc.Log(fmt.Sprintf("\nAuthenticated as: %s%s", u.login, email))
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: u.login,
		Info:                 "Install secrets: agentio github install owner/repo",
	}, nil
}

func reauth(ctx context.Context, creds plugins.Credentials, profileName string, sc *plugins.SetupContext) (plugins.Credentials, error) {
	sc.Log(fmt.Sprintf("\nRe-authenticating github / %s...", profileName))
	token, err := performOAuth(ctx, sc)
	if err != nil {
		return nil, err
	}
	u, err := newClient(ctx, token, sc.Fetch, sc.Fail).getUser()
	if err != nil {
		return nil, err
	}
	sc.Log(fmt.Sprintf("  Done (%s)", u.login))
	return withUser(creds, token, u), nil
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	u, err := NewClient(ctx, run).getUser()
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	return plugins.ValidationResult{Valid: true, Info: u.login}, nil
}
