package daemon

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/ping"
)

// The Bun page is the source of truth. A copy that drifted means the Go hub
// serves a different UI; `go generate ./internal/daemon` refreshes it.
func TestEmbeddedUIMatchesBunSource(t *testing.T) {
	src, err := os.ReadFile("../../../src/daemon/ui/index.html")
	if err != nil {
		t.Fatalf("read the Bun UI source: %v", err)
	}
	if !bytes.Equal(src, []byte(UIIndexHTML)) {
		t.Fatal("go/internal/daemon/ui/index.html differs from src/daemon/ui/index.html; run `go generate ./internal/daemon`")
	}
	for _, marker := range []string{"__CSP_NONCE__", "__PLUGIN_METADATA__"} {
		if !strings.Contains(UIIndexHTML, marker) {
			t.Fatalf("template lost its %s marker", marker)
		}
	}
}

var nonceAttr = regexp.MustCompile(`nonce="([^"]+)"`)

func TestPageIsTheTemplateWithNonceAndMetadata(t *testing.T) {
	isolate(t)
	evil, plain := acme.New(), ping.New()
	evil.DisplayName = "Z </script><b>&"
	evil.Brand = &plugins.Brand{Color: "#A1b2C3"}
	plain.DisplayName = "Ping"
	plain.Brand = &plugins.Brand{Color: "red"}
	reg, err := plugins.NewRegistry(evil, plain)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&Server{Registry: reg, Version: "test"}).Handler())
	defer srv.Close()

	get := func(path string) (*http.Response, string) {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}
	res, body := get("/ui")
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	nonces := nonceAttr.FindAllStringSubmatch(body, -1)
	if len(nonces) != 2 || nonces[0][1] != nonces[1][1] {
		t.Fatalf("want one nonce on the style and the script, got %v", nonces)
	}
	nonce := nonces[0][1]
	if raw, err := base64.StdEncoding.DecodeString(nonce); err != nil || len(raw) != 16 {
		t.Fatalf("nonce %q is not 16 random bytes", nonce)
	}
	wantHeaders := map[string]string{
		"Content-Type":              "text/html; charset=utf-8",
		"Cache-Control":             "no-store",
		"Content-Security-Policy":   "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		"X-Frame-Options":           "DENY",
		"X-Content-Type-Options":    "nosniff",
		"Referrer-Policy":           "no-referrer",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	}
	for k, v := range wantHeaders {
		if got := res.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	// Registry order, no color unless it is a #rrggbb, and nothing that closes the script.
	meta := `{"acme":{"displayName":"Z \u003c/script\u003e\u003cb\u003e\u0026","color":"#A1b2C3"},"ping":{"displayName":"Ping"}}`
	want := strings.Replace(strings.ReplaceAll(UIIndexHTML, "__CSP_NONCE__", nonce), "__PLUGIN_METADATA__", meta, 1)
	if body != want {
		t.Fatalf("page is not the template with the nonce and metadata substituted; metadata line: %s", regexp.MustCompile(`PLUGIN_METADATA = .*`).FindString(body))
	}
	var parsed map[string]map[string]string
	if err := json.Unmarshal([]byte(meta), &parsed); err != nil || parsed["acme"]["displayName"] != "Z </script><b>&" {
		t.Fatalf("metadata does not round-trip: %v %v", parsed, err)
	}

	// A fresh nonce every response; /ui/ serves the same page; other verbs do not.
	_, again := get("/ui/")
	if n := nonceAttr.FindStringSubmatch(again); n == nil || n[1] == nonce {
		t.Fatal("nonce was reused")
	}
	post, err := http.Post(srv.URL+"/ui", "text/html", nil)
	if err != nil {
		t.Fatal(err)
	}
	post.Body.Close()
	if post.StatusCode != 401 {
		t.Fatalf("POST /ui = %d, want 401 as Bun", post.StatusCode)
	}
	for _, path := range []string{"/ui/index.html", "/ui//", "/uix"} {
		if res, _ := get(path); res.StatusCode != 401 {
			t.Errorf("GET %s = %d, want 401 as Bun", path, res.StatusCode)
		}
	}
	// The domain alone lands on the UI with a relative Location.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	root, err := client.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	root.Body.Close()
	if root.StatusCode != 302 || root.Header.Get("Location") != "/ui" {
		t.Fatalf("GET / = %d %q", root.StatusCode, root.Header.Get("Location"))
	}
}

func TestPageWithoutRegistryHasEmptyMetadata(t *testing.T) {
	isolate(t)
	if got := (&Server{}).pluginMetadata(); got != "{}" {
		t.Fatalf("got %s", got)
	}
}
