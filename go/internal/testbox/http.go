package testbox

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/plugins"
)

// CutShort answers with status and a Content-Length of 100, sends 10 bytes
// of body, and drops the connection: a download cut part-way.
func CutShort(t *testing.T, w http.ResponseWriter, status int) {
	t.Helper()
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fmt.Fprintf(buf, "HTTP/1.1 %d %s\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\n0123456789", status, http.StatusText(status))
	_ = buf.Flush()
	_ = conn.Close()
}

// WantSocketClosed fails t unless err is the plain error Bun's fetch body
// readers reject with when the connection drops (see CutShort).
func WantSocketClosed(t *testing.T, err error) {
	t.Helper()
	if err == nil || err.Error() != plugins.BunSocketClosed {
		t.Errorf("want %q, got %#v", plugins.BunSocketClosed, err)
	}
}

// FreePort is a loopback TCP port that was free a moment ago.
func FreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

// GetWhenUp GETs url once it answers, trying every 10ms for about 2s: a
// browser landing on an OAuth callback server that is still starting.
func GetWhenUp(url string) {
	for i := 0; i < 200; i++ {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Feed writes each part to w, pausing 20ms after each: stdin arriving in
// separate writes. It leaves w open.
func Feed(w io.Writer, parts ...string) {
	for _, part := range parts {
		_, _ = io.WriteString(w, part)
		time.Sleep(20 * time.Millisecond)
	}
}
