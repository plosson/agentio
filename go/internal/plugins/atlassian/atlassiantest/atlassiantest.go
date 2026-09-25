// Package atlassiantest is the test harness for the Atlassian product
// plugins: a fake auth.atlassian.com and api.atlassian.com that records every
// request, a vault in a temp HOME, and the host's command execution. Only
// _test.go files import it. Like testbox, and unlike the atlassian package,
// it reaches the vault, profile and host packages, because the tests drive
// the plugins through them.
package atlassiantest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Hit is one request that reached the fake Atlassian.
type Hit struct {
	// Host is the Atlassian host the request was sent to.
	Host   string
	Method string
	Path   string
	Query  url.Values
	// RawQuery is the query string as sent.
	RawQuery string
	Auth     string
	Type     string
	// Raw is the body as sent, Body the same body decoded when it is a JSON object.
	Raw  string
	Body map[string]any
}

// Fake stands in for auth.atlassian.com and api.atlassian.com. The default
// transport is rewritten for the test so production URLs land here and
// nothing else leaves the process.
type Fake struct {
	t      *testing.T
	mu     sync.Mutex
	hits   []Hit
	handle func(w http.ResponseWriter, h Hit)
}

type rewrite struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host != "api.atlassian.com" && req.URL.Host != "auth.atlassian.com" {
		return nil, errors.New("atlassiantest: blocked request to " + req.URL.Host)
	}
	out := req.Clone(req.Context())
	out.URL.Scheme = r.target.Scheme
	out.URL.Host = r.target.Host
	out.Host = r.target.Host
	out.Header.Set("X-Orig-Host", req.URL.Host)
	return r.base.RoundTrip(out)
}

// NewFake starts the fake and routes http.DefaultTransport to it until the
// test ends.
func NewFake(t *testing.T, handle func(w http.ResponseWriter, h Hit)) *Fake {
	t.Helper()
	f := &Fake{t: t, handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	prev := http.DefaultTransport
	http.DefaultTransport = rewrite{target: target, base: srv.Client().Transport}
	t.Cleanup(func() { http.DefaultTransport = prev })
	return f
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	h := Hit{
		Host: r.Header.Get("X-Orig-Host"), Method: r.Method, Path: r.URL.Path,
		Query: r.URL.Query(), RawQuery: r.URL.RawQuery, Auth: r.Header.Get("Authorization"),
		Type: r.Header.Get("Content-Type"), Raw: string(raw),
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &h.Body); err != nil {
			f.t.Errorf("non-JSON object body %q", raw)
		}
	}
	f.mu.Lock()
	f.hits = append(f.hits, h)
	handle := f.handle
	f.mu.Unlock()
	handle(w, h)
}

// SetHandle replaces the fake's answers for the requests that follow.
func (f *Fake) SetHandle(handle func(w http.ResponseWriter, h Hit)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handle = handle
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
	if len(all) == 0 {
		f.t.Fatal("no request reached the fake")
	}
	return all[len(all)-1]
}

// WriteJSON answers with v as JSON.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteRaw answers with body verbatim.
func WriteRaw(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
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

// Product is one Atlassian plugin under test: New builds it.
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
	if err := profile.Save(p.id(), name, testbox.Object(creds), opts); err != nil {
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
	return testbox.Map(c.Credentials.Get(p.id(), name))
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

// Exec runs path through the host (profile, read-only check, refresh, Run).
func (p Product) Exec(t *testing.T, reg *plugins.Registry, path string, in plugins.CommandInput) (any, error) {
	t.Helper()
	if in.Options == nil {
		in.Options = map[string]any{}
	}
	if in.Args == nil {
		in.Args = map[string]any{}
	}
	return host.Execute(context.Background(), reg, reg.Find(p.id()), p.Spec(t, path), in)
}

// StoredCreds is a saved Atlassian profile expiring at expiry (ms), with a
// field no product owns so tests can see it is kept.
func StoredCreds(expiry int64) map[string]any {
	return map[string]any{
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"cloudId":      "cloud-1",
		"siteUrl":      "https://acme.atlassian.net",
		"legacyField":  "kept",
	}
}

// Far is an expiry a day away: no refresh is due.
func Far() int64 { return time.Now().Add(24 * time.Hour).UnixMilli() }

// SetupContext is the host's setup context with stdin at EOF (no terminal)
// and output discarded. Tests set OAuth and Prompt as they need.
func SetupContext() *plugins.SetupContext {
	return host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
}

// Row is one command as the Bun command table describes it: arguments
// ("<a> [b]"), flags with their defaults ("--limit <number>=50"), access,
// read-only refusal label and stdin input.
type Row struct {
	Args, Flags, Access, Operation, Input string
}

// CheckCommands fails t unless the product's commands are exactly want, each
// with examples and a Format.
func (p Product) CheckCommands(t *testing.T, want map[string]Row) {
	t.Helper()
	plugin := p.New()
	if _, err := plugins.NewRegistry(plugin); err != nil {
		t.Fatal(err)
	}
	if len(plugin.Commands) != len(want) {
		t.Fatalf("%d commands, want %d", len(plugin.Commands), len(want))
	}
	for _, c := range plugin.Commands {
		w, ok := want[c.Path]
		if !ok {
			t.Fatalf("unexpected command %q", c.Path)
		}
		var args, flags []string
		for _, a := range c.Arguments {
			if a.Required {
				args = append(args, "<"+a.Name+">")
			} else {
				args = append(args, "["+a.Name+"]")
			}
		}
		for _, o := range c.Options {
			f := o.Flags
			if o.Required {
				f += "!" // requiredOption
			}
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			flags = append(flags, f)
		}
		got := Row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
}
