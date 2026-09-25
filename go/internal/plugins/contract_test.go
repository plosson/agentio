package plugins

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// A wrong type or a missing key must read as the zero value, never panic.
func TestInputAccessorsReturnZeroForMissingOrMistypedValues(t *testing.T) {
	in := CommandInput{
		Args:    map[string]any{"id": "42", "n": 7},
		Options: map[string]any{"limit": "10", "force": true, "to": []string{"a", "b"}, "json": true, "tag": "x"},
	}
	if in.Arg("id") != "42" || in.Arg("n") != "" || in.Arg("missing") != "" {
		t.Fatalf("Arg: %q %q %q", in.Arg("id"), in.Arg("n"), in.Arg("missing"))
	}
	if in.Option("limit") != "10" || in.Option("force") != "" || in.Option("to") != "" {
		t.Fatal("Option must only return strings")
	}
	if !in.Flag("force") || in.Flag("limit") || in.Flag("missing") {
		t.Fatal("Flag must only return true for a bool true")
	}
	if got := in.List("to"); len(got) != 2 || got[1] != "b" {
		t.Fatalf("List: %v", got)
	}
	if in.List("tag") != nil || in.List("missing") != nil {
		t.Fatal("List must be nil for a non-slice or missing value")
	}
	if v, ok := in.LookupOption("limit"); !ok || v != "10" {
		t.Fatal("LookupOption must report a given value")
	}
	in.Options["due"] = ""
	if v, ok := in.LookupOption("due"); !ok || v != "" {
		t.Fatal("LookupOption must report an explicit empty value as given")
	}
	in.Options["title"] = nil
	for _, name := range []string{"title", "force", "missing"} {
		if _, ok := in.LookupOption(name); ok {
			t.Fatalf("LookupOption(%q) reported a value that was not a given string", name)
		}
	}
	var empty CommandInput
	if empty.Arg("x") != "" || empty.Option("x") != "" || empty.Flag("x") || empty.List("x") != nil {
		t.Fatal("nil maps must read as zero values")
	}

	setup := SetupOptions{Options: map[string]any{"app-key": "k", "full": true}}
	if setup.Option("app-key") != "k" || setup.Option("full") != "" || !setup.Flag("full") || setup.Flag("app-key") {
		t.Fatal("SetupOptions accessors mix up types")
	}
	if (SetupOptions{}).Option("x") != "" || (SetupOptions{}).Flag("x") {
		t.Fatal("nil setup options must read as zero values")
	}
}

// A failed call returning a typed nil must come back as an untyped nil, or the
// host would print "null" before the error.
// event stands in for an API response struct.
type event struct{ ID string }

func TestResultDropsTheTypedNilOnFailure(t *testing.T) {
	var none *event
	v, err := Result(none, errors.New("boom"))
	if v != nil || err == nil {
		t.Fatalf("%#v %v", v, err)
	}
	// A value that came with an error is dropped too.
	v, _ = Result(&event{ID: "x"}, errors.New("boom"))
	if v != nil {
		t.Fatalf("%#v", v)
	}
	if v, err := Result([]string{}, nil); err != nil || v == nil {
		t.Fatalf("%#v %v", v, err)
	}
}

func TestRequireOptionsReportsTheFirstMissingInDeclarationOrder(t *testing.T) {
	var got []string
	run := &RunContext{Fail: func(code ErrorCode, message, suggestion string) error {
		got = append(got, string(code)+"|"+message+"|"+suggestion)
		return errors.New(message)
	}}
	in := CommandInput{Options: map[string]any{"space": "", "limit": true, "query": "q"}}
	if err := RequireOptions(in, run.Fail, "--query <q>", "--limit <n>", "--space <id>"); err == nil {
		t.Fatal("a bool where a string is required passed")
	}
	// Commander's requiredOption checks `=== undefined`: a given "" is present,
	// while an absent option (nil, as the host leaves it) still fails after it.
	if err := RequireOptions(in, run.Fail, "--space <id>"); err != nil {
		t.Fatalf("a given empty string failed: %v", err)
	}
	in.Options["missing"] = nil
	if err := RequireOptions(in, run.Fail, "--space <id>", "--missing <x>"); err == nil {
		t.Fatal("an absent option after a given empty one passed")
	}
	want := []string{
		"INVALID_PARAMS|required option '--limit <n>' not specified|",
		"INVALID_PARAMS|required option '--missing <x>' not specified|",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%q", got)
	}
	if err := RequireOptions(in, run.Fail, "--query <q>"); err != nil {
		t.Fatal(err)
	}
}

// Parse, Check and Required are Prepare adapters: a failure carries no
// value and never stops the command early; Prepared reads the value back as
// the type Parse produced, and a missing or other-typed value as its zero.
func TestPrepareAdapters(t *testing.T) {
	var failed []string
	pre := &PrepareContext{Fail: func(code ErrorCode, m, s string) error {
		failed = append(failed, code+"|"+m)
		return errors.New(m)
	}}
	parse := Parse(func(in CommandInput, fail FailFunc) (int, error) {
		if in.Option("n") == "" {
			return 7, fail("INVALID_PARAMS", "n is required", "")
		}
		return 42, nil
	})
	if v, done, err := parse(context.Background(), CommandInput{}, pre); v != nil || done || err == nil {
		t.Fatalf("rejected: %#v %v %v", v, done, err)
	}
	v, done, err := parse(context.Background(), CommandInput{Options: map[string]any{"n": "1"}}, pre)
	if v != 42 || done || err != nil {
		t.Fatalf("accepted: %#v %v %v", v, done, err)
	}
	if got := Prepared[int](&RunContext{Prepared: v}); got != 42 {
		t.Fatalf("Prepared = %d", got)
	}
	if got := Prepared[string](&RunContext{Prepared: v}); got != "" {
		t.Fatalf("other type = %q", got)
	}
	if got := Prepared[[]string](&RunContext{}); got != nil {
		t.Fatalf("no value = %#v", got)
	}
	check := Check(func(in CommandInput, fail FailFunc) error { return fail("INVALID_PARAMS", "no", "") })
	if v, done, err := check(context.Background(), CommandInput{}, pre); v != nil || done || err == nil {
		t.Fatalf("check: %#v %v %v", v, done, err)
	}
	req := Required("--query <q>")
	if _, _, err := req(context.Background(), CommandInput{Options: map[string]any{"query": ""}}, pre); err != nil {
		t.Fatalf("given empty is present: %v", err)
	}
	if _, _, err := req(context.Background(), CommandInput{Options: map[string]any{}}, pre); err == nil {
		t.Fatal("absent option passed")
	}
	want := "INVALID_PARAMS|n is required,INVALID_PARAMS|no,INVALID_PARAMS|required option '--query <q>' not specified"
	if strings.Join(failed, ",") != want {
		t.Fatalf("failures %v", failed)
	}
}

// Bun httpStatusToErrorCode: four statuses have their own code, every other
// status (including a success one and a 5xx) is API_ERROR.
func TestHTTPStatusToErrorCodeMatchesBun(t *testing.T) {
	for status, want := range map[int]ErrorCode{
		401: "AUTH_FAILED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RATE_LIMITED",
		400: "API_ERROR", 402: "API_ERROR", 410: "API_ERROR", 500: "API_ERROR", 503: "API_ERROR", 200: "API_ERROR", 0: "API_ERROR",
	} {
		if got := HTTPStatusToErrorCode(status); got != want {
			t.Errorf("%d: %q, want %q", status, got, want)
		}
	}
}

// Bun `--json [file]`: a file is read as readFile(file, 'utf-8') (a BOM is
// kept, so JSON.parse rejects it), stdin is trimmed, key order is kept, and
// every failure uses Bun's text (the parse wording was checked with bun -e).
func TestJSONPayloadMatchesBun(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	var got []string
	fail := func(code ErrorCode, m, s string) error {
		got = append(got, code+"|"+m+"|"+s)
		return errors.New(m)
	}
	ordered := write("ordered.json", "\n{\"z\":1,\"a\":[\"<&>\",1.50]}\n")
	v, err := JSONPayload(CommandInput{}, ordered, fail, "hint")
	if err != nil || string(jsvalue.Stringify(v)) != `{"z":1,"a":["<&>",1.5]}` {
		t.Fatalf("file: %s %v", jsvalue.Stringify(v), err)
	}
	v, err = JSONPayload(CommandInput{Stdin: "  [null] \n"}, true, fail, "hint")
	if err != nil || string(jsvalue.Stringify(v)) != `[null]` {
		t.Fatalf("stdin: %s %v", jsvalue.Stringify(v), err)
	}
	missing := filepath.Join(dir, "missing.json")
	for _, c := range []struct {
		in     CommandInput
		source any
	}{
		{CommandInput{}, missing},
		{CommandInput{}, dir},
		{CommandInput{Stdin: " \n"}, true},
		{CommandInput{}, write("bom.json", "\uFEFF{}")},
		{CommandInput{Stdin: `{"a":1,}`}, true},
		{CommandInput{}, write("empty.json", "")},
	} {
		if v, err := JSONPayload(c.in, c.source, fail, "hint"); v != nil || err == nil {
			t.Errorf("%v: accepted %v", c.source, v)
		}
	}
	want := []string{
		"INVALID_PARAMS|Failed to read JSON file: " + missing + "|Check that the file exists and is readable",
		"INVALID_PARAMS|Failed to read JSON file: " + dir + "|Check that the file exists and is readable",
		"INVALID_PARAMS|No JSON provided via stdin|hint",
		"INVALID_PARAMS|Invalid JSON: JSON Parse error: Unrecognized token '\uFEFF'|Check that the JSON is valid",
		"INVALID_PARAMS|Invalid JSON: JSON Parse error: Property name must be a string literal|Check that the JSON is valid",
		"INVALID_PARAMS|Invalid JSON: JSON Parse error: Unexpected EOF|Check that the JSON is valid",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("\n got %q\nwant %q", got, want)
	}
}

// failingReader hands over some bytes, then fails.
type failingReader struct {
	data []byte
	err  error
}

func (r *failingReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, r.err
}

type timeoutErr struct{}

func (timeoutErr) Error() string { return "i/o timeout" }
func (timeoutErr) Timeout() bool { return true }

// roundTripper answers every request with a body that fails with err after
// "partial".
type roundTripper struct{ err error }

func (rt roundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	body := io.NopCloser(&failingReader{data: []byte("partial"), err: rt.err})
	return &http.Response{StatusCode: 200, Body: body, Request: req}, nil
}

// A body read that fails part-way fails as Bun's fetch does, whatever reads it.
func TestBunTransportFailsBodyReadsLikeBun(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{io.ErrUnexpectedEOF, BunSocketClosed},
		{syscall.ECONNRESET, BunSocketClosed},
		{context.Canceled, BunSocketClosed},
		{context.DeadlineExceeded, "The operation timed out."},
		{timeoutErr{}, "The operation timed out."},
	}
	for _, c := range cases {
		client := &http.Client{Transport: BunTransport{Base: roundTripper{c.err}}}
		resp, err := client.Get("http://example.invalid/")
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err == nil || err.Error() != c.want {
			t.Errorf("%v: %v", c.err, err)
		}
	}
	client := &http.Client{Transport: BunTransport{Base: roundTripper{io.EOF}}}
	resp, err := client.Get("http://example.invalid/")
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := io.ReadAll(resp.Body); err != nil || string(raw) != "partial" {
		t.Fatalf("%q %v", raw, err)
	}
}

// A body that outlives the timeout fails as AbortSignal.timeout does, not with
// the text http.Client.Timeout would add.
func TestBunTransportTimeoutCoversTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = io.WriteString(w, "0123456789")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	resp, err := NewHTTPClient(50 * time.Millisecond).Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err == nil || err.Error() != "The operation timed out." {
		t.Fatalf("%v", err)
	}
}
