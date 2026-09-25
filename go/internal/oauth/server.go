// Package oauth is the localhost callback the host offers to profile.setup.
// It matches src/auth/oauth-server.ts: ports 3000-3010, state check, and a
// pasted redirect for machines the browser cannot call back to.
package oauth

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/lines"
)

const (
	portStart = 3000
	portEnd   = 3010
)

// timeout is a variable so tests can shorten it; the message stays Bun's.
var timeout = 5 * time.Minute

const (
	htmlOK    = "<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>"
	htmlFail  = "<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>"
	htmlMiss  = "<html><body><h1>Missing Authorization Code</h1><p>You can close this window.</p></body></html>"
	htmlState = "<html><body><h1>State Mismatch</h1><p>You can close this window.</p></body></html>"
)

type Result struct {
	Code  string
	State string
}

// FindPort returns a free TCP port in 3000-3010.
func FindPort() (int, error) {
	for port := portStart; port <= portEnd; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		_ = ln.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no available port found in range %d-%d", portStart, portEnd)
}

// LaunchBrowser opens url with the platform opener. A missing opener returns false.
func LaunchBrowser(raw string) bool {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		if _, err := exec.LookPath("open"); err != nil {
			return false
		}
		cmd = exec.Command("open", raw)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", raw)
	default:
		if _, err := exec.LookPath("xdg-open"); err != nil {
			return false
		}
		cmd = exec.Command("xdg-open", raw)
	}
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return false
	}
	return true
}

// ParseRedirect accepts a bare code or a pasted redirect URL.
func ParseRedirect(input, serviceName, expectedState string) (Result, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return Result{}, clierr.New(clierr.InvalidParams, "An authorization code is required", "")
	}
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		return Result{Code: trimmed}, nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return Result{}, clierr.New(clierr.InvalidParams, "Could not parse the pasted redirect URL", "Copy the whole address bar, starting with http://")
	}
	if e := parsed.Query().Get("error"); e != "" {
		desc := parsed.Query().Get("error_description")
		msg := e
		if desc != "" {
			msg = e + " - " + desc
		}
		return Result{}, clierr.New(clierr.AuthFailed, serviceName+" denied the authorization: "+msg, "")
	}
	returned := parsed.Query().Get("state")
	if expectedState != "" && returned != expectedState {
		return Result{}, clierr.New(clierr.AuthFailed, "OAuth state mismatch - possible CSRF attack", "")
	}
	code := parsed.Query().Get("code")
	if code == "" {
		return Result{}, clierr.New(clierr.InvalidParams, `No "code" parameter found in the pasted redirect URL`, "Copy the full URL from the browser address bar after approving access")
	}
	return Result{Code: code, State: returned}, nil
}

type AwaitConfig struct {
	Port          int
	ServiceName   string
	ExpectedState string
	AuthURL       string
	// Lines, when set, is the paste source. Nil uses os.Stdin's reader.
	Lines *lines.Reader
	// Err receives the human instructions. Nil uses os.Stderr.
	Err io.Writer
}

// AwaitCode returns whichever arrives first: the localhost callback, or a pasted redirect.
func AwaitCode(ctx context.Context, cfg AwaitConfig) (Result, error) {
	errOut := cfg.Err
	if errOut == nil {
		errOut = os.Stderr
	}
	in := cfg.Lines
	if in == nil {
		in = lines.For(os.Stdin)
	}
	callback := make(chan Result, 1)
	fail := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if e := r.URL.Query().Get("error"); e != "" {
			_, _ = io.WriteString(w, htmlFail)
			fail <- fmt.Errorf("oauth error: %s", e)
			return
		}
		if cfg.ExpectedState != "" && r.URL.Query().Get("state") != cfg.ExpectedState {
			_, _ = io.WriteString(w, htmlState)
			fail <- clierr.New(clierr.AuthFailed, "OAuth state mismatch - possible CSRF attack", "")
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			_, _ = io.WriteString(w, htmlMiss)
			fail <- fmt.Errorf("missing code")
			return
		}
		_, _ = io.WriteString(w, htmlOK)
		st := r.URL.Query().Get("state")
		callback <- Result{Code: code, State: st}
	})
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", cfg.Port), Handler: mux}
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return Result{}, err
	}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		shut, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shut)
	}()

	fmt.Fprintf(errOut, "\nOpening browser for %s authorization...\nIf the browser doesn't open, visit:\n%s\n\n", cfg.ServiceName, cfg.AuthURL)
	if !LaunchBrowser(cfg.AuthURL) {
		fmt.Fprintln(errOut, "No browser could be opened on this machine.")
	}
	fmt.Fprintln(errOut, "Waiting for the browser to come back.")
	fmt.Fprintln(errOut, "On a remote machine the redirect lands on this host and your browser cannot")
	fmt.Fprintln(errOut, "reach it - approve access anyway, then paste the address bar contents here.")

	// Once the callback wins, the paste stops waiting and a line typed later
	// goes to the next prompt.
	pasteCtx, stopPaste := context.WithCancel(ctx)
	defer stopPaste()
	pasted := make(chan Result, 1)
	pasteErr := make(chan error, 1)
	go func() {
		fmt.Fprint(errOut, "? Redirect URL (or code): ")
		line, err := in.ReadLine(pasteCtx)
		if err == io.EOF && line == "" {
			return // Bun: nothing left to paste, the callback or the timeout decides
		}
		if err != nil && line == "" {
			pasteErr <- err
			return
		}
		res, err := ParseRedirect(line, cfg.ServiceName, cfg.ExpectedState)
		if err != nil {
			pasteErr <- err
			return
		}
		pasted <- res
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-callback:
		return res, nil
	case err := <-fail:
		return Result{}, err
	case res := <-pasted:
		return res, nil
	case err := <-pasteErr:
		return Result{}, err
	case <-ctx.Done():
		return Result{}, ctx.Err()
	case <-timer.C:
		return Result{}, fmt.Errorf("OAuth flow timed out after 5 minutes")
	}
}
