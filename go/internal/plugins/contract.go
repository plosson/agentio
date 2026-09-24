// Package plugins is the contract a service implements. The host owns vault
// writes, profile names, refresh persistence, read-only enforcement, JSON
// output, and error rendering. A plugin returns data and credentials.
//
// This is the Go form of src/plugin-sdk/index.ts (the declarative contract).
// In-tree Commander registration is a TypeScript adapter and is not part of
// the contract offered to a service.
package plugins

import (
	"context"
	"net/http"
)

const APIVersion = 1

type ErrorCode = string

type ValidationResult struct {
	Valid bool
	Info  string
	Error string
}

type SetupOptions struct {
	Profile  string
	ReadOnly bool
}

type SetupResult struct {
	Credentials          map[string]any
	SuggestedProfileName string
	Info                 string
}

type OAuthSetupOptions struct {
	ServiceName string
	// ExpectedState is checked against the callback when set.
	ExpectedState string
	// AuthorizationURL is called after the host has reserved a localhost callback.
	AuthorizationURL func(redirectURI string) string
	// Port pins the callback port when the provider only accepts one registered
	// redirect URI (Atlassian: 9999). Zero picks a free port in 3000-3010.
	Port int
}

type OAuthSetupResult struct {
	Code        string
	State       string
	RedirectURI string
}

// SetupContext is the host surface a profile.setup may use.
type SetupContext struct {
	Prompt  func(question string, secret bool) (string, error)
	Confirm func(question string) (bool, error)
	Log     func(parts ...any)
	OpenURL func(url string) bool
	OAuth   func(ctx context.Context, opts OAuthSetupOptions) (OAuthSetupResult, error)
	Fail    func(code ErrorCode, message, suggestion string) error
	Fetch   func(ctx context.Context, req *http.Request) (*http.Response, error)
}

// RunContext is what a command handler receives. Credentials are already fresh.
type RunContext struct {
	Credentials map[string]any
	Profile     string
	Signal      context.Context
	Fetch       func(ctx context.Context, req *http.Request) (*http.Response, error)
	Log         func(parts ...any)
	Fail        func(code ErrorCode, message, suggestion string) error
}

type ArgumentSpec struct {
	Name        string
	Description string
	Required    bool
	Variadic    bool
}

type OptionSpec struct {
	Flags        string
	Description  string
	DefaultValue any // string or bool; nil when unset
}

type CommandInput struct {
	Args    map[string]any
	Options map[string]any
	Stdin   any // nil, string, or decoded JSON object
}

type CommandSpec struct {
	Path        string
	Description string
	Arguments   []ArgumentSpec
	Options     []OptionSpec
	// Input is "", "none", "text", or "json".
	Input string
	// Access is "", "read", or "write". Omitted access is treated as read.
	Access string
	// Operation names the action in the read-only refusal ("Cannot <operation>").
	// Empty uses Path.
	Operation string
	Examples  []string
	Run       func(ctx context.Context, in CommandInput, run *RunContext) (any, error)
	Format    func(value any) string
}

// RefreshSpec is profile.refresh. Run must not persist; the host does.
type RefreshSpec struct {
	SecretFields []string
	Applies      func(credentials map[string]any) bool
	IsStale      func(credentials map[string]any, nowMs int64, bufferMs int64) bool
	Run          func(ctx context.Context, credentials map[string]any) (map[string]any, error)
}

type ProfileSpec struct {
	Setup          func(ctx context.Context, opts SetupOptions, setup *SetupContext) (*SetupResult, error)
	Validate       func(ctx context.Context, run *RunContext) (ValidationResult, error)
	Reauthenticate func(ctx context.Context, credentials map[string]any, profileName string, setup *SetupContext) (map[string]any, error)
	Refresh        *RefreshSpec
	// ListInfo is appended to a profile's line in `profile list` (Bun getExtraInfo).
	ListInfo func(credentials map[string]any) string
}

type Brand struct {
	Color    string
	IconPath string
}

// Plugin is one service. ID is the vault key and the CLI noun.
type Plugin struct {
	APIVersion  int
	ID          string
	DisplayName string
	Description string
	Brand       *Brand
	Profile     *ProfileSpec
	Commands    []CommandSpec
}
