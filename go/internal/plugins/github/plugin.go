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

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// listInfo is Bun getExtraInfo: ` (username)` when the username is truthy.
func listInfo(creds map[string]any) string {
	if v := creds["username"]; jsvalue.Truthy(v) {
		return " (" + jsvalue.String(v) + ")"
	}
	return ""
}

// withUser sets username and email from /user. An absent email is dropped, as
// JSON.stringify drops an undefined field.
func withUser(creds map[string]any, u user) map[string]any {
	creds["username"] = u.login
	if u.hasEmail {
		creds["email"] = u.email
	} else {
		delete(creds, "email")
	}
	return creds
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
	creds := withUser(map[string]any{"accessToken": token}, u)
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

func reauth(ctx context.Context, creds map[string]any, profileName string, sc *plugins.SetupContext) (map[string]any, error) {
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
	out := make(map[string]any, len(creds)+3)
	for k, v := range creds {
		out[k] = v
	}
	out["accessToken"] = token
	return withUser(out, u), nil
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	u, err := NewClient(ctx, run).getUser()
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	return plugins.ValidationResult{Valid: true, Info: u.login}, nil
}
