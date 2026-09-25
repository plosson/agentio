package daemon

import (
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// The admin UI is the Bun daemon's page, byte for byte. src/daemon/ui/index.html
// is the source of truth; go:embed cannot reach outside the module, so a copy
// lives in ui/ and TestEmbeddedUIMatchesBunSource fails when the two differ.
//
//go:generate cp ../../../src/daemon/ui/index.html ui/index.html
//go:embed ui/index.html
var UIIndexHTML string

var brandColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// pluginMetadata is the JSON the page reads as PLUGIN_METADATA: registry order,
// and no color key when a plugin has no valid brand color, as Bun serialises
// an undefined field. <, > and & are escaped so the blob cannot close the script.
func (s *Server) pluginMetadata() string {
	meta := object{}
	if s.Registry != nil {
		for _, p := range s.Registry.Plugins() {
			entry := object{{"displayName", p.DisplayName}}
			if p.Brand != nil && brandColor.MatchString(p.Brand.Color) {
				entry = append(entry, field{"color", p.Brand.Color})
			}
			meta = append(meta, field{p.ID, entry})
		}
	}
	return strings.NewReplacer("<", `\u003c`, ">", `\u003e`, "&", `\u0026`).Replace(string(marshalJS(meta)))
}

// page serves the admin UI with a fresh CSP nonce and the plugin metadata.
func (s *Server) page(w http.ResponseWriter) {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	nonce := base64.StdEncoding.EncodeToString(raw)
	html := strings.ReplaceAll(UIIndexHTML, "__CSP_NONCE__", nonce)
	// Bun's String.replace with a string pattern swaps the first occurrence only.
	html = strings.Replace(html, "__PLUGIN_METADATA__", s.pluginMetadata(), 1)
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	for k, v := range securityHeaders(nonce) {
		h.Set(k, v)
	}
	_, _ = io.WriteString(w, html)
}

// marshalJS encodes v as JSON.stringify does: no HTML escaping, no trailing newline.
func marshalJS(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}
