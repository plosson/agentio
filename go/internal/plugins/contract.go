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
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
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
	// ReadOnly is the profile's read-only flag, for a command that runs on a
	// read-only profile under its own restrictions instead of being refused
	// (Bun sql query: isProfileReadOnly, then a read-only transaction).
	ReadOnly bool
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

// OptionPtr is LookupOption as a value Bun passes on to its client: nil when
// absent (undefined), a given "" kept.
func (in CommandInput) OptionPtr(name string) *string {
	if s, ok := in.LookupOption(name); ok {
		return &s
	}
	return nil
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

// HTTPStatusToErrorCode is Bun src/utils/errors.ts httpStatusToErrorCode.
func HTTPStatusToErrorCode(status int) ErrorCode {
	switch status {
	case 401:
		return "AUTH_FAILED"
	case 403:
		return "PERMISSION_DENIED"
	case 404:
		return "NOT_FOUND"
	case 429:
		return "RATE_LIMITED"
	}
	return "API_ERROR"
}

// BunSocketClosed is the TypeError Bun's fetch rejects a body read with when
// the connection drops before the body is complete.
const BunSocketClosed = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"

// ReadBody is `await response.arrayBuffer()` (or text(), json()) under Bun:
// a body that cannot be read in full rejects with a plain error, and none of
// it is kept. A timeout reads as AbortSignal.timeout's rejection.
func ReadBody(body io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(body)
	if err == nil {
		return raw, nil
	}
	var timeout interface{ Timeout() bool }
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() {
		return nil, errors.New("The operation timed out.")
	}
	return nil, errors.New(BunSocketClosed)
}

// FailFunc is RunContext.Fail. Input checks take it so they also run from an
// AccessFor, before a RunContext exists (WriteUnlessInvalid).
type FailFunc = func(code ErrorCode, message, suggestion string) error

// Result drops a typed nil on failure: the host prints any non-nil value
// returned with an error, and Bun printed nothing before throwing.
func Result[T any](v T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return v, nil
}

// Stdin is Bun readStdin(): the piped text decoded as Buffer#toString('utf-8')
// and trimmed as String#trim does; "" when nothing was piped.
func Stdin(in CommandInput) string {
	text, _ := in.Stdin.(string)
	return jsvalue.Trim(jsvalue.BufferString([]byte(text)))
}

// OptionOrStdin is a <value> option with Bun's readStdin() fallback, and
// whether it is set. With emptyReadsStdin (Bun `if (!x) x = stdin`) an empty
// option reads stdin; without it (Bun `if (x === undefined)`) only an absent
// one does. Empty stdin leaves the option as given.
func OptionOrStdin(in CommandInput, name string, emptyReadsStdin bool) (string, bool) {
	value, given := in.LookupOption(name)
	if given && (value != "" || !emptyReadsStdin) {
		return value, true
	}
	if piped := Stdin(in); piped != "" {
		return piped, true
	}
	return value, given
}

// JSONPayload is Bun's `--json [file]` message payload (slack and gchat send):
// source is the option's value, a file name to read or true (bare flag) for
// stdin, and the text is JSON.parse'd with Bun's error wording. stdinHint is
// the suggestion when nothing was piped.
func JSONPayload(in CommandInput, source any, fail FailFunc, stdinHint string) (any, error) {
	var content string
	if file, isFile := source.(string); isFile {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, fail("INVALID_PARAMS", "Failed to read JSON file: "+file, "Check that the file exists and is readable")
		}
		content = jsvalue.BufferString(raw) // readFile(file, 'utf-8')
	} else {
		content = Stdin(in)
		if content == "" {
			return nil, fail("INVALID_PARAMS", "No JSON provided via stdin", stdinHint)
		}
	}
	payload, err := jsvalue.Parse([]byte(content))
	if err != nil {
		return nil, fail("INVALID_PARAMS", "Invalid JSON: "+jsvalue.ParseErrorMessage([]byte(content)), "Check that the JSON is valid")
	}
	return payload, nil
}

// RequireOptions is Commander's requiredOption check, in declaration order:
// only an absent option fails. A given "" is present, as Commander checks
// `=== undefined`, and the command then handles the empty value as Bun does.
// flags are the Bun declarations ("--space <id>").
func RequireOptions(in CommandInput, fail FailFunc, flags ...string) error {
	for _, f := range flags {
		name := strings.TrimPrefix(strings.Fields(f)[0], "--")
		if _, given := in.LookupOption(name); !given {
			return fail("INVALID_PARAMS", fmt.Sprintf("required option '%s' not specified", f), "")
		}
	}
	return nil
}

// WriteUnlessInvalid is an AccessFor that lets input check rejects reach Run,
// which reports it: a Bun command that validates its input before calling
// enforceWriteAccess answers a read-only profile with the input error.
func WriteUnlessInvalid(check func(CommandInput, FailFunc) error) func(CommandInput) string {
	return func(in CommandInput) string {
		if check(in, func(ErrorCode, string, string) error { return errInvalid }) != nil {
			return "read"
		}
		return "write"
	}
}

var errInvalid = errors.New("invalid")

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
	// NoProfileFor, when set and true for the input, runs Run with no profile
	// and no credentials, for a Bun command that answers that input before it
	// resolves a profile (gmail archive --dry-run prints its plan first).
	NoProfileFor func(in CommandInput) bool
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
	// RequireProfile makes --profile a required option of `<service> profile
	// add` (Bun slack `requiredOption('--profile <name>')`). The top-level
	// `profile add <service>` keeps it optional, as in Bun.
	RequireProfile bool
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
