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
	"fmt"
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
	// Options holds the ProfileSpec.SetupOptions flags given to `profile add`,
	// keyed by long name (Bun: `--app-key <key>` arrives as "app-key").
	Options map[string]any
}

// Option is a <value> setup option; absent or of another type is "".
func (o SetupOptions) Option(name string) string {
	s, _ := o.Options[name].(string)
	return s
}

// Flag is a switch setup option; absent or of another type is false.
func (o SetupOptions) Flag(name string) bool {
	b, _ := o.Options[name].(bool)
	return b
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
	// Confirm asks a yes/no question on the terminal (Bun utils/stdin confirm).
	Confirm func(question string) (bool, error)
	Fail    func(code ErrorCode, message, suggestion string) error
}

type ArgumentSpec struct {
	Name        string
	Description string
	Required    bool
	Variadic    bool
}

type OptionSpec struct {
	// Flags is the Bun flag syntax. A `[value]` flag (Bun `--json [file]`) is
	// nil when absent, true when given bare, and the string when given a value;
	// like Commander it takes the next word unless that word starts with "-".
	Flags        string
	Description  string
	DefaultValue any // string or bool; nil when unset
	// Repeatable collects every occurrence of a <value> flag into a []string,
	// empty when the flag is absent (Bun: a collector option with default []).
	Repeatable bool
}

type CommandInput struct {
	Args    map[string]any
	Options map[string]any
	Stdin   any // nil, string, or decoded JSON object
}

// Arg is a string argument; absent or of another type is "".
func (in CommandInput) Arg(name string) string {
	s, _ := in.Args[name].(string)
	return s
}

// Option is a <value> option; absent or of another type is "".
func (in CommandInput) Option(name string) string {
	s, _ := in.Options[name].(string)
	return s
}

// LookupOption is a <value> option and whether it was given, so an explicit
// empty value is told apart from an absent one (Bun `options.due !== undefined`).
func (in CommandInput) LookupOption(name string) (string, bool) {
	s, ok := in.Options[name].(string)
	return s, ok
}

// Flag is a switch option; absent or of another type is false.
func (in CommandInput) Flag(name string) bool {
	b, _ := in.Options[name].(bool)
	return b
}

// List is a Repeatable option; absent or of another type is nil.
func (in CommandInput) List(name string) []string {
	values, _ := in.Options[name].([]string)
	return values
}

type CommandSpec struct {
	Path        string
	Description string
	Arguments   []ArgumentSpec
	Options     []OptionSpec
	// Aliases are other names for the last Path segment (Bun `.alias('list')`).
	Aliases []string
	// Default runs this command when its parent group is given no subcommand
	// (Bun `.command('list', { isDefault: true })`).
	Default bool
	// Input is "", "none", "text", or "json".
	Input string
	// Access is "", "read", or "write". Omitted access is treated as read.
	Access string
	// AccessFor, when set, decides the access from the parsed input instead of
	// Access, for a Bun command that calls enforceWriteAccess only on some flags.
	AccessFor func(in CommandInput) string
	// Operation names the action in the read-only refusal ("Cannot <operation>").
	// Empty uses Path.
	Operation string
	// OperationFor, when set, names the action from the parsed input instead of
	// Operation (Bun gmail draft: "update draft" with an id, else "create draft").
	OperationFor func(in CommandInput) string
	Examples     []string
	// Run returns the value the host prints. A non-nil value returned together
	// with an error is printed first, then the error is rendered (Bun: output,
	// then throw).
	Run    func(ctx context.Context, in CommandInput, run *RunContext) (any, error)
	Format func(value any) string
	// Verbatim prints Format's text as is, without the newline the host
	// otherwise adds (Bun process.stdout.write instead of console.log).
	Verbatim bool
}

// ExitStatus ends a command with Code and no error line, after any value
// returned with it is printed (Bun: output, then process.exit(code)).
type ExitStatus struct {
	Code int
}

func (e *ExitStatus) Error() string { return fmt.Sprintf("exit status %d", e.Code) }

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
	// SetupOptions are extra `<service> profile add` flags (Bun: dropbox --app-key).
	SetupOptions []OptionSpec
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
