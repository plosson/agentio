package host

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/lines"
	"github.com/plosson/agentio/go/internal/oauth"
	"github.com/plosson/agentio/go/internal/plugins"
	"golang.org/x/term"
)

// Streams is where the host talks to a person during setup.
type Streams struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer
}

func StdStreams() Streams {
	return Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr}
}

func (s Streams) in() io.Reader {
	if s.In != nil {
		return s.In
	}
	return os.Stdin
}

func (s Streams) err() io.Writer {
	if s.Err != nil {
		return s.Err
	}
	return os.Stderr
}

func fail(code plugins.ErrorCode, message, suggestion string) error {
	return clierr.New(clierr.Code(code), message, suggestion)
}

func fetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	if req.Context() != nil && req.Context() != context.Background() {
		ctx = req.Context()
	}
	return plugins.Fetch(ctx, req)
}

// NewSetupContext builds the host surface a profile.setup receives.
func NewSetupContext(s Streams) *plugins.SetupContext {
	// One line reader over In, shared by every prompt.
	rd := lines.For(s.in())
	return &plugins.SetupContext{
		Prompt:  func(q string, secret bool) (string, error) { return prompt(s, rd, q, secret) },
		Confirm: func(q string) (bool, error) { return confirm(s, rd, q) },
		Log:     func(parts ...any) { fmt.Fprintln(s.err(), parts...) },
		OpenURL: oauth.LaunchBrowser,
		OAuth: func(ctx context.Context, opts plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
			port := opts.Port
			if port == 0 {
				found, err := oauth.FindPort()
				if err != nil {
					return plugins.OAuthSetupResult{}, err
				}
				port = found
			}
			redirect := fmt.Sprintf("http://localhost:%d/callback", port)
			authURL := ""
			if opts.AuthorizationURL != nil {
				authURL = opts.AuthorizationURL(redirect)
			}
			res, err := oauth.AwaitCode(ctx, oauth.AwaitConfig{
				Port: port, ServiceName: opts.ServiceName, ExpectedState: opts.ExpectedState,
				AuthURL: authURL, Lines: rd, Err: s.err(),
			})
			if err != nil {
				return plugins.OAuthSetupResult{}, err
			}
			return plugins.OAuthSetupResult{Code: res.Code, State: res.State, RedirectURI: redirect}, nil
		},
		Fail:  fail,
		Fetch: fetch,
	}
}

func logStderr(parts ...any) { fmt.Fprintln(os.Stderr, parts...) }

func NewRunContext(creds map[string]any, profileName string, ctx context.Context) *plugins.RunContext {
	if ctx == nil {
		ctx = context.Background()
	}
	return &plugins.RunContext{
		Credentials: creds,
		Profile:     profileName,
		Signal:      ctx,
		Fetch:       fetch,
		Log:         logStderr,
		Confirm:     func(q string) (bool, error) { return confirm(StdStreams(), lines.For(os.Stdin), q) },
		Fail:        fail,
	}
}

// prompt reads its answer from rd, the line reader over s.In.
func prompt(s Streams, rd *lines.Reader, question string, secret bool) (string, error) {
	if !strings.HasSuffix(question, " ") {
		question += " "
	}
	fmt.Fprint(s.err(), question)
	if secret && isTerminal(s.in()) && !rd.Waiting() {
		fd := int(os.Stdin.Fd())
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(s.err())
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	line, err := rd.ReadLine(context.Background())
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func confirm(s Streams, rd *lines.Reader, question string) (bool, error) {
	answer, err := prompt(s, rd, question+" (y/n): ", false)
	if err != nil {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
		return true, nil
	default:
		return false, nil
	}
}

func isTerminal(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}

// ReadStdin returns the full stdin when it is not a terminal. A terminal yields nil.
func ReadStdin(r io.Reader) (string, bool, error) {
	if r == nil {
		r = os.Stdin
	}
	if isTerminal(r) {
		return "", false, nil
	}
	b, err := io.ReadAll(r)
	if err != nil {
		return "", false, err
	}
	if len(b) == 0 {
		return "", false, nil
	}
	return string(b), true, nil
}
