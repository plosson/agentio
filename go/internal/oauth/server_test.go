package oauth

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/lines"
	"github.com/plosson/agentio/go/internal/testbox"
)

func TestParseRedirectRejectsTheWaysAPasteGoesWrong(t *testing.T) {
	if _, err := ParseRedirect("  ", "Acme", ""); err == nil {
		t.Fatal("empty paste accepted")
	}
	res, err := ParseRedirect("raw-code", "Acme", "state")
	if err != nil || res.Code != "raw-code" {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := ParseRedirect("http://localhost/callback?error=access_denied&error_description=no", "Acme", ""); err == nil || !strings.Contains(err.Error(), "access_denied") {
		t.Fatal(err)
	}
	if _, err := ParseRedirect("http://localhost/callback?code=c&state=other", "Acme", "expected"); err == nil || !strings.Contains(err.Error(), "state") {
		t.Fatal(err)
	}
	if _, err := ParseRedirect("http://localhost/callback?state=expected", "Acme", "expected"); err == nil {
		t.Fatal("missing code accepted")
	}
	res, err = ParseRedirect("http://localhost/callback?code=abc&state=expected", "Acme", "expected")
	if err != nil || res.Code != "abc" || res.State != "expected" {
		t.Fatalf("%+v %v", res, err)
	}
}

// Bun: stdin at end of input (`</dev/null`) only ends the paste path. The
// browser callback, or the 5-minute timeout, still decides.
func TestPasteAtEndOfInputLeavesTheCallbackToDecide(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no browser opener
	await := func(t *testing.T) (int, chan error, chan Result) {
		port := testbox.FreePort(t)
		errs, results := make(chan error, 1), make(chan Result, 1)
		go func() {
			res, err := AwaitCode(context.Background(), AwaitConfig{
				Port: port, ServiceName: "Demo", ExpectedState: "s1", AuthURL: "https://example.invalid/auth",
				Lines: lines.For(strings.NewReader("")), Err: io.Discard,
			})
			errs <- err
			results <- res
		}()
		return port, errs, results
	}

	t.Run("callback after EOF", func(t *testing.T) {
		port, errs, results := await(t)
		time.Sleep(200 * time.Millisecond) // stdin has long hit EOF
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/callback?code=abc&state=s1", port))
		if err != nil {
			t.Fatalf("callback: %v (flow ended with %v)", err, <-errs)
		}
		resp.Body.Close()
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		if res := <-results; res.Code != "abc" || res.State != "s1" {
			t.Fatalf("%#v", res)
		}
	})

	t.Run("EOF and no callback", func(t *testing.T) {
		old := timeout
		timeout = 300 * time.Millisecond
		defer func() { timeout = old }()
		_, errs, _ := await(t)
		if err := <-errs; err == nil || err.Error() != "OAuth flow timed out after 5 minutes" {
			t.Fatalf("%v", err)
		}
	})
}
