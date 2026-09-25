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
	"time"

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
	// Prepared is what CommandSpec.Prepare returned; nil without a Prepare.
	Prepared any
}

// Parse is a CommandSpec.Prepare that only parses: parse's value reaches Run
// (read it with Prepared[T]) and the command never stops early.
func Parse[T any](parse func(in CommandInput, fail FailFunc) (T, error)) func(context.Context, CommandInput, *PrepareContext) (any, bool, error) {
	return func(_ context.Context, in CommandInput, pre *PrepareContext) (any, bool, error) {
		v, err := parse(in, pre.Fail)
		if err != nil {
			return nil, false, err
		}
		return v, false, nil
	}
}

// Check is a CommandSpec.Prepare that only checks: Run gets no value.
func Check(check func(in CommandInput, fail FailFunc) error) func(context.Context, CommandInput, *PrepareContext) (any, bool, error) {
	return func(_ context.Context, in CommandInput, pre *PrepareContext) (any, bool, error) {
		return nil, false, check(in, pre.Fail)
	}
}

// Prepared is run.Prepared as the type the command's Prepare returns.
func Prepared[T any](run *RunContext) T {
	v, _ := run.Prepared.(T)
	return v
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
	// Required is Commander's requiredOption: the CLI refuses the line without
	// it (`error: required option '<Flags>' not specified`), and the host checks
	// it again (RequireOptions) for a caller that skips the CLI.
	Required bool
}

// Negates is the option a Commander negatable flag sets: "x" for a `--no-x`
// switch, "" otherwise. `--no-x` sets x to false, and the last of `--x` and
// `--no-x` wins. Declared after `--x`, it leaves x's default as it is; alone,
// x defaults to true and there is no `--x`. The command reads x, never "no-x".
func (o OptionSpec) Negates() string {
	fields := strings.Fields(o.Flags)
	if len(fields) != 1 || !strings.HasPrefix(fields[0], "--no-") {
		return ""
	}
	return strings.TrimPrefix(fields[0], "--no-")
}

// ProfileFlags is the --profile option the host puts on a command of a
// service with profiles.
const ProfileFlags = "--profile <name>"

// ProfileOption places the host's --profile among a command's Options, with
// Bun's description for it, where the Bun command declares it. Without one,
// the host adds --profile after the leading Required options, with the usual
// description.
func ProfileOption(description string) OptionSpec {
	return OptionSpec{Flags: ProfileFlags, Description: description}
}

// WithProfileOption is opts with the host's --profile in place.
func WithProfileOption(opts []OptionSpec) []OptionSpec {
	at := 0
	for i, opt := range opts {
		if opt.Flags == ProfileFlags {
			return opts
		}
		if opt.Required && at == i {
			at = i + 1
		}
	}
	out := append([]OptionSpec(nil), opts[:at]...)
	out = append(out, ProfileOption("Profile name (optional if only one profile exists)"))
	return append(out, opts[at:]...)
}

type CommandInput struct {
	Args    map[string]any
	Options map[string]any
	Stdin   any // nil, string, or decoded JSON object
	// ReadStdin, when Stdin is nil, reads a text command's stdin on first use:
	// the piped text and whether anything was piped. Bun's commands read
	// stdin only when the value it stands in for is missing, so the CLI does
	// not read it before the command asks (Piped, Stdin, OptionOrStdin).
	ReadStdin func() (string, bool)
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

// IntOptionPtr is a <value> option with Commander's parseInt argParser: nil
// when absent (undefined), NaN when the value (even "") has no leading digits.
func (in CommandInput) IntOptionPtr(name string) *float64 {
	s, ok := in.LookupOption(name)
	if !ok {
		return nil
	}
	n := jsvalue.ParseInt(s)
	return &n
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

// BunTransport is Bun's fetch as an http.RoundTripper: a request that cannot
// be sent fails with Bun's fetch error (FetchError; FetchFailure takes off the
// http.Client wrapping), and a response body that cannot be read in full fails
// as `await response.arrayBuffer()` (or text(), json()) rejects under Bun, so
// a plain io.ReadAll(resp.Body) anywhere returns Bun's error. A timeout reads
// as AbortSignal.timeout's rejection.
type BunTransport struct {
	// Base sends the request; nil is http.DefaultTransport at the time of the
	// call, which tests replace.
	Base http.RoundTripper
	// Timeout, when set, covers the whole exchange, body included. It lives
	// here rather than in http.Client.Timeout, which rewrites body errors.
	Timeout time.Duration
}

func (t BunTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	cancel := context.CancelFunc(func() {})
	if t.Timeout > 0 {
		var ctx context.Context
		ctx, cancel = context.WithTimeout(req.Context(), t.Timeout)
		req = req.WithContext(ctx)
	}
	resp, err := base.RoundTrip(req)
	if err != nil {
		cancel()
		return nil, fetchError(req, err, transportRoots(base))
	}
	resp.Body = &bunBody{ReadCloser: resp.Body, ctx: req.Context(), cancel: cancel}
	return resp, nil
}

type bunBody struct {
	io.ReadCloser
	ctx    context.Context
	cancel context.CancelFunc
}

func (b *bunBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == nil || err == io.EOF {
		return n, err
	}
	var timeout interface{ Timeout() bool }
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() ||
		errors.Is(b.ctx.Err(), context.DeadlineExceeded) {
		return n, errors.New("The operation timed out.")
	}
	return n, errors.New(BunSocketClosed)
}

func (b *bunBody) Close() error {
	defer b.cancel()
	return b.ReadCloser.Close()
}

// NewHTTPClient is an http.Client that fails like Bun's fetch (BunTransport);
// timeout 0 is none.
func NewHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Transport: BunTransport{Timeout: timeout}}
}

var bunClient = NewHTTPClient(0)

// Fetch is Bun's global fetch: req sent under ctx, failing as Bun's does
// (a failed send is the bare FetchError). It is what the host hands a
// plugin, and a plugin's own default.
func Fetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	resp, err := bunClient.Do(req.WithContext(ctx))
	return resp, FetchFailure(err)
}

// PrepareContext is what CommandSpec.Prepare receives: no profile, no
// credentials, only stderr and the error constructor.
type PrepareContext struct {
	Log  func(parts ...any)
	Fail FailFunc
}

// FailFunc is RunContext.Fail. Input checks take it so they also run from
// CommandSpec.Prepare, before a RunContext exists.
type FailFunc = func(code ErrorCode, message, suggestion string) error

// Result drops a typed nil on failure: the host prints any non-nil value
// returned with an error, and Bun printed nothing before throwing.
func Result[T any](v T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return v, nil
}

// Piped is the raw piped text and whether anything was piped (Bun
// readStdin() !== null), read now if the CLI left it for later.
func Piped(in CommandInput) (string, bool) {
	if text, ok := in.Stdin.(string); ok {
		return text, true
	}
	if in.Stdin == nil && in.ReadStdin != nil {
		return in.ReadStdin()
	}
	return "", false
}

// Stdin is Bun readStdin(): the piped text decoded as Buffer#toString('utf-8')
// and trimmed as String#trim does; "" when nothing was piped.
func Stdin(in CommandInput) string {
	text, _ := Piped(in)
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

// RequireOptions is Commander's requiredOption check over the Required
// options, in declaration order: only an absent option fails. A given "" is
// present, as Commander checks `=== undefined`, and the command then handles
// the empty value as Bun does.
func RequireOptions(in CommandInput, fail FailFunc, opts []OptionSpec) error {
	for _, opt := range opts {
		if !opt.Required {
			continue
		}
		name := strings.TrimPrefix(strings.Fields(opt.Flags)[0], "--")
		if _, given := in.LookupOption(name); !given {
			return fail("INVALID_PARAMS", fmt.Sprintf("required option '%s' not specified", opt.Flags), "")
		}
	}
	return nil
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
	// Prepare is the Bun action's work before get<X>Client: parse and check
	// the input, read local files, print a dry run. The host calls it once,
	// before it resolves the profile, refreshes the token or refuses a write
	// on a read-only profile. An error is reported as is. done prints
	// prepared and stops (no profile needed); otherwise prepared reaches Run
	// as RunContext.Prepared, so nothing is parsed or read twice. A check
	// that needs the client stays in Run, after the profile, as in Bun.
	Prepare func(ctx context.Context, in CommandInput, pre *PrepareContext) (prepared any, done bool, err error)
	// Examples are the example lines Bun's addExamples block lists, each
	// comment opening a new example.
	Examples []string
	// ExampleNotes are the lines Bun prints after the examples, as they are:
	// "" is an empty line.
	ExampleNotes []string
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
