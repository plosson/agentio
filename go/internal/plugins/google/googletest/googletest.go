// Package googletest is the test harness the Google product plugins share: a
// fake Google that records every request, a vault in a temp HOME, and the
// CommandInput the host builds. Only _test.go files import it. Like testbox,
// and unlike the google package, it reaches the vault, profile and host
// packages, because the tests drive the plugins through them.
package googletest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Hit is one request that reached the fake Google.
type Hit struct {
	Method string
	Path   string
	Query  url.Values
	Auth   string
	// Type is the Content-Type header, Raw the body as sent.
	Type string
	Raw  string
	// JSON is a JSON object body. Body is any JSON body compacted with its
	// keys sorted: the body as the API reads it.
	JSON map[string]any
	Body string
	// Form is any other non-empty body read as a query string (the token
	// requests).
	Form url.Values
}

// Fake is an httptest server standing in for every Google endpoint: the
// product API, the token endpoint (/token) and userinfo (/userinfo).
type Fake struct {
	t      *testing.T
	root   string
	srv    *httptest.Server
	mu     sync.Mutex
	hits   []Hit
	handle func(w http.ResponseWriter, h Hit)
}

// NewFake starts a fake Google whose product API is rooted at "/".
func NewFake(t *testing.T, handle func(w http.ResponseWriter, h Hit)) *Fake {
	return NewFakeAt(t, "/", handle)
}

// NewFakeAt starts a fake Google whose product API is rooted at root
// ("/calendar/v3/" keeps calendar/v3's own request paths).
func NewFakeAt(t *testing.T, root string, handle func(w http.ResponseWriter, h Hit)) *Fake {
	t.Helper()
	f := &Fake{t: t, root: root, handle: handle}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	h := Hit{
		Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Auth: r.Header.Get("Authorization"),
		Type: r.Header.Get("Content-Type"), Raw: string(raw),
	}
	if strings.HasPrefix(h.Type, "application/json") {
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			f.t.Errorf("non-JSON body %q", raw)
		}
		h.JSON, _ = v.(map[string]any)
		h.Body = JSONText(v)
	} else if len(raw) > 0 {
		h.Form, _ = url.ParseQuery(string(raw))
	}
	f.mu.Lock()
	f.hits = append(f.hits, h)
	handle := f.handle
	f.mu.Unlock()
	handle(w, h)
}

// Ctx sends the product clients, the token exchange and userinfo to the fake.
func (f *Fake) Ctx() context.Context {
	return google.WithEndpoints(context.Background(), google.Endpoints{
		API: f.srv.URL + f.root, Token: f.srv.URL + "/token", UserInfo: f.srv.URL + "/userinfo",
	})
}

// SetHandle replaces the fake's answers for the requests that follow.
func (f *Fake) SetHandle(handle func(w http.ResponseWriter, h Hit)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handle = handle
}

// Reset forgets the requests recorded so far.
func (f *Fake) Reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits = nil
}

// Recorded is every request so far, in arrival order.
func (f *Fake) Recorded() []Hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Hit(nil), f.hits...)
}

// Last is the latest request.
func (f *Fake) Last() Hit {
	all := f.Recorded()
	return all[len(all)-1]
}

// Paths is each request as "METHOD /path".
func (f *Fake) Paths() []string {
	var out []string
	for _, h := range f.Recorded() {
		out = append(out, h.Method+" "+h.Path)
	}
	return out
}

// WriteJSON answers with v as JSON.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteRaw answers with body verbatim as JSON.
func WriteRaw(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// WriteAPIError answers with a Google API error body.
func WriteAPIError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": message}})
}

// JSONText is v marshalled by encoding/json.
func JSONText(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// CliErr is err as the CLI error the host renders; anything else fails t.
func CliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	ce, ok := err.(*clierr.Error)
	if !ok {
		t.Fatalf("not a CLI error: %#v", err)
	}
	return ce
}

// Product is one Google plugin under test: New builds it.
type Product struct {
	New func() *plugins.Plugin
}

// For is the harness for the plugin New builds.
func For(New func() *plugins.Plugin) Product {
	return Product{New: New}
}

func (p Product) id() string { return p.New().ID }

// SetupVault isolates HOME, creates an empty vault there and returns a
// registry holding only the product.
func (p Product) SetupVault(t *testing.T) *plugins.Registry {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(p.New())
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

// SaveProfile stores creds as the product's profile name.
func (p Product) SaveProfile(t *testing.T, name string, creds map[string]any, readOnly bool) {
	t.Helper()
	opts := profile.SaveOptions{}
	if readOnly {
		opts = profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}
	}
	if err := profile.Save(p.id(), name, creds, opts); err != nil {
		t.Fatal(err)
	}
}

// LoadCreds reads the product's profile name back from the vault.
func (p Product) LoadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c.Credentials[p.id()][name]
}

// Spec is the product's command at path.
func (p Product) Spec(t *testing.T, path string) *plugins.CommandSpec {
	t.Helper()
	plugin := p.New()
	for i := range plugin.Commands {
		if plugin.Commands[i].Path == path {
			return &plugin.Commands[i]
		}
	}
	t.Fatalf("no command %q", path)
	return nil
}

// Input is the CommandInput the host builds for path (cli flagValue): []
// for a repeatable flag, nil for an absent [value] flag, a switch's default
// (false unless declared true), a <value> option's default or nil when it has
// none. Then args and set are applied.
func (p Product) Input(t *testing.T, path string, args map[string]any, set map[string]any) plugins.CommandInput {
	t.Helper()
	in := plugins.CommandInput{Args: map[string]any{}, Options: map[string]any{}}
	for _, o := range p.Spec(t, path).Options {
		name := strings.TrimPrefix(strings.Fields(o.Flags)[0], "--")
		def, isBool := o.DefaultValue.(bool)
		switch {
		case o.Repeatable:
			in.Options[name] = []string{}
		case strings.Contains(o.Flags, "[") && !strings.Contains(o.Flags, "<"):
			in.Options[name] = nil
		case isBool || !strings.Contains(o.Flags, "<"):
			in.Options[name] = def
		default:
			if s, _ := o.DefaultValue.(string); s != "" {
				in.Options[name] = s
			} else {
				in.Options[name] = nil
			}
		}
	}
	for k, v := range args {
		in.Args[k] = v
	}
	for k, v := range set {
		in.Options[k] = v
	}
	return in
}

// Exec runs path through the host (profile, refresh, read-only check, Run).
func (p Product) Exec(ctx context.Context, t *testing.T, reg *plugins.Registry, path string, in plugins.CommandInput) (any, error) {
	t.Helper()
	return host.Execute(ctx, reg, reg.Find(p.id()), p.Spec(t, path), in)
}

// Printed is what the CLI writes to stdout for v (Format, or the host's
// string or JSON rendering).
func (p Product) Printed(t *testing.T, path string, v any, asJSON bool) string {
	t.Helper()
	var b bytes.Buffer
	if err := host.PrintResult(&b, p.Spec(t, path), v, asJSON); err != nil {
		t.Fatal(err)
	}
	return b.String()
}
