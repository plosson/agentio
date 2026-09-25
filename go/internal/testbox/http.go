package testbox

import (
	"fmt"
	"net/http"
	"testing"
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
